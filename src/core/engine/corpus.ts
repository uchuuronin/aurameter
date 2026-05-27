/**
 * Slop training corpus (Block 2).
 *
 * Turns mod verdicts on Slop-flagged posts into a pooled, privacy-safe training
 * corpus for the ONE global Slop model. It does NOT fit a model (Devvit can't);
 * it banks feature-vector/label pairs and (via the scheduler) flags
 * retrain-readiness for the offline trainer (tools/slop-trainer).
 *
 * All corpus Redis access lives in this file (mirrors how storage.ts owns its
 * keys). The pure predicates (wasQueuedOnSlop, classifyModAction, toCorpusJsonl)
 * are unit-tested directly; the redis-backed functions are tested against the
 * in-memory fake (test/devvit-server-mock.ts) wired via vitest.config alias.
 *
 * PRIVACY (plan, non-negotiable): a corpus entry stores the stylometric
 * FEATURE VECTOR + a binary label only — never sub name, title, body, or author.
 * Feature vectors are content-derived numbers, matching the recordSamples
 * precedent.
 *
 * PURITY (plan §3): a *passive* verdict is corpus-eligible only if the post was
 * queued BECAUSE Slop was high (a fired rule with `slop >= N`, N >= 2). A post
 * queued on Tea/Clown/Time teaches the Slop model nothing. Spot-check verdicts
 * bypass purity — the mod is explicitly labeling a Slop-surfaced post.
 */

import { redis } from '@devvit/web/server';
import type { RuleCondition } from '../config/types.js';
import { loadQueueReason, loadSlopFeatures } from './storage.js';

// -- queue reason (Task 1) ----------------------------------------------------

/**
 * Why a post was queued: the id of (one of) the fired rule(s) plus the set of
 * conditions that fired. A post can match multiple rules; triggers.ts records
 * the UNION of all matched rules' conditions so wasQueuedOnSlop can ask whether
 * ANY of them was a Slop condition. `ruleId` is the first matching rule, kept
 * for debugging/log attribution only — the purity decision is made on
 * `conditions`, not on the id.
 */
export interface QueueReason {
  ruleId: string;
  conditions: RuleCondition[];
}

/**
 * Comparators that mean "Slop was HIGH". A `slop <= n` (or `<`) condition fires
 * because Slop is LOW, so a post queued on it is NOT a high-Slop example and
 * must not be harvested as one. Only `>=`, `>`, `=` express "Slop at/above a
 * level".
 */
const HIGH_SLOP_COMPARATORS: ReadonlySet<RuleCondition['comparator']> = new Set([
  '>=',
  '>',
  '=',
]);

/** Plan §3 purity floor: a Slop condition only counts if it requires slop >= 2. */
const SLOP_PURITY_FLOOR = 2;

/**
 * The purity gate's core predicate. True iff the post was queued because of a
 * Slop condition strong enough to make it a genuine high-Slop example —
 * meaning a passive mod verdict on it is eligible for the Slop corpus. Pure.
 */
export function wasQueuedOnSlop(reason: QueueReason | null | undefined): boolean {
  if (!reason || !Array.isArray(reason.conditions)) return false;
  return reason.conditions.some(
    (c) =>
      c != null &&
      c.signal === 'slop' &&
      HIGH_SLOP_COMPARATORS.has(c.comparator) &&
      typeof c.threshold === 'number' &&
      c.threshold >= SLOP_PURITY_FLOOR,
  );
}

// -- verdict classification (Task 4) ------------------------------------------

/** A mod action's meaning for the Slop corpus. */
export type VerdictClass = 'ai-positive' | 'non-ai-negative' | 'ignore';

/**
 * Classify a Reddit mod-action type into a Slop label (pure).
 *   removelink / spamlink -> ai-positive   (mod judged it removable -> treat as synthetic=1)
 *   approvelink           -> non-ai-negative (mod judged it fine -> synthetic=0)
 *   anything else         -> ignore         (comment actions, distinguish, sticky, ...)
 *
 * Case-insensitive and null-safe so a defensively-read payload field can't throw.
 */
export function classifyModAction(action: string | null | undefined): VerdictClass {
  const a = (action ?? '').toLowerCase();
  if (a === 'removelink' || a === 'spamlink') return 'ai-positive';
  if (a === 'approvelink') return 'non-ai-negative';
  return 'ignore';
}

// -- corpus entries (Task 2) --------------------------------------------------

/** label: 1 = synthetic (ai), 0 = human (not-ai). */
export type SlopLabel = 0 | 1;
export type VerdictSource = 'passive' | 'spotcheck';

export interface CorpusEntry {
  id: string;
  ts: number;
  /** stylometric feature vector — the model's input; NOT the post content. */
  features: Record<string, number>;
  label: SlopLabel;
  source: VerdictSource;
}

/** One global pooled corpus (NOT per-sub — the model is global, sub is not a feature). */
const slopCorpusKey = () => `am:slopcorpus`;

/** Generous cap; this is the training set. Trim-by-rank mirrors appendLog. */
const CORPUS_HARD_CAP = 50000;

function newCorpusId(): string {
  return `c-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Append a fully-formed corpus entry. zAdd then trim-by-rank to the cap. */
export async function appendCorpusEntry(entry: CorpusEntry): Promise<void> {
  await redis.zAdd(slopCorpusKey(), { score: entry.ts, member: JSON.stringify(entry) });
  await redis.zRemRangeByRank(slopCorpusKey(), 0, -(CORPUS_HARD_CAP + 1));
}

/**
 * Read corpus entries newest-first. Mirrors storage.ts::readLog: `before` (ts
 * ms) pages back; unparseable members are dropped (forward-compatible).
 */
export async function readCorpus(
  opts: { limit: number; before?: number },
): Promise<CorpusEntry[]> {
  const max = opts.before !== undefined ? opts.before - 1 : Date.now();
  const raw = await redis.zRange(slopCorpusKey(), 0, max, { by: 'score', reverse: true });
  const entries: CorpusEntry[] = [];
  for (const { member } of raw) {
    if (entries.length >= opts.limit) break;
    try {
      entries.push(JSON.parse(member) as CorpusEntry);
    } catch {
      // drop unparseable members
    }
  }
  return entries;
}

/**
 * Pure formatter: newline-delimited JSON, one entry per line — the shape
 * tools/slop-trainer/fit.py consumes. Separated from I/O so it's unit-testable.
 */
export function toCorpusJsonl(entries: CorpusEntry[]): string {
  return entries.map((e) => JSON.stringify(e)).join('\n');
}

/** Read the whole corpus and emit it as JSONL (the CI export tap, Task 9). */
export async function exportCorpusJsonl(): Promise<string> {
  // Read all: a single reverse range with a very high limit. The cap keeps this
  // bounded at CORPUS_HARD_CAP entries.
  const all = await readCorpus({ limit: CORPUS_HARD_CAP });
  // Emit oldest-first for a stable training file.
  all.reverse();
  return toCorpusJsonl(all);
}

/** Current corpus size (for the retrain-readiness check in the scheduler). */
export async function corpusSize(): Promise<number> {
  const all = await redis.zRange(slopCorpusKey(), 0, -1, { by: 'rank' });
  return all.length;
}

// ── retrain readiness (Block 2 Task 9) ────────────────────────────────────────
//
// The app NEVER fits a model (Devvit can't). The scheduler only FLAGS when the
// global corpus is worth retraining offline, on a slow cadence. State is a
// single global marker (am:slopretrain:lastat) holding the ms timestamp of the
// last retrain; 0/absent = never retrained (so the first eligible rollup flags).

/** ~7 weeks. Retrain is global + occasional; this is the minimum gap between flags. */
export const RETRAIN_INTERVAL_MS = 7 * 7 * 24 * 60 * 60 * 1000;

/** Don't bother flagging until the corpus is big enough to train on. */
export const MIN_RETRAIN_CORPUS = 500;

const retrainMarkerKey = () => `am:slopretrain:lastat`;

/** Read the last-retrain timestamp (ms), or 0 if never recorded. */
export async function loadLastRetrainAt(): Promise<number> {
  const raw = await redis.get(retrainMarkerKey());
  const n = raw ? Number(raw) : 0;
  return Number.isFinite(n) ? n : 0;
}

/** Record that a retrain happened (call after deploying new weights). */
export async function markRetrained(at: number = Date.now()): Promise<void> {
  await redis.set(retrainMarkerKey(), String(at));
}

/**
 * Pure predicate: is the corpus due for a retrain? True iff it's both big
 * enough AND enough time has passed since the last retrain. Separated from I/O
 * so it's unit-testable.
 */
export function isRetrainDue(corpusN: number, lastRetrainAt: number, now: number): boolean {
  return corpusN >= MIN_RETRAIN_CORPUS && now - lastRetrainAt > RETRAIN_INTERVAL_MS;
}

/**
 * THE harvest gate. Turn a mod verdict on a post into a corpus entry — but only
 * if it's eligible:
 *   - load the post's stored Slop feature vector (Task 3 persists it). No
 *     features -> nothing to learn from -> skip.
 *   - passive verdicts: require wasQueuedOnSlop(reason) (the purity filter).
 *   - spotcheck verdicts: bypass purity (the mod explicitly labeled a
 *     Slop-surfaced post).
 *
 * Returns true if an entry was appended, false if skipped. Never throws on a
 * skip — callers fire it from trigger handlers.
 */
export async function appendVerdict(args: {
  postId: string;
  label: SlopLabel;
  source: VerdictSource;
}): Promise<boolean> {
  const { postId, label, source } = args;

  // Purity gate (passive only). Spot-check bypasses — explicit mod labeling.
  if (source === 'passive') {
    const reason = await loadQueueReason(postId);
    if (!wasQueuedOnSlop(reason)) return false;
  }

  // Need the raw feature vector; without it there's nothing to train on.
  const features = await loadSlopFeatures(postId);
  if (!features || Object.keys(features).length === 0) return false;

  await appendCorpusEntry({
    id: newCorpusId(),
    ts: Date.now(),
    features,
    label,
    source,
  });
  return true;
}
