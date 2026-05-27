/**
 * storage layer: redis schemas and helpers.
 *
 * all redis access in aurameter goes through this file. that keeps key shapes
 * consistent, makes deletion-compliance purges easy to audit, and gives a
 * single place to migrate schemas if redis apis change.
 *
 * key conventions:
 *   am:installs                        → sorted set of installed subs (score=installedAt)
 *   am:cfg:<sub>                       → subconfig (json hash field 'data')
 *   am:post:<postId>                   → per-post results hash
 *     fields: 'sub', 'scores' (json), 'reasons' (json), 'ts'
 *   am:queue:<sub>                     → sorted set of post ids by composite priority
 *   am:queuereason:<postId>            → why a post was queued (json hash field 'data'); Slop purity filter (Block 2)
 *   am:slopfeatures:<postId>           → raw Slop feature vector at scoring time (json hash field 'data'); corpus harvesting (Block 2)
 *   am:agg:<sub>:<yyyy-mm-dd>:<sig>    → sorted set of post ids by score, for daily rollups
 *   am:baseline:<sub>:<sig>            → learned baseline (json), flat hash field 'data'
 *   am:samples:<sub>:<sig>:<feature>   → capped sorted set of raw feature values (score=value, member=postId)
 *   am:actionlog:<sub>                 → sorted set of log entries by ts (score=ts, member=json LogEntry)
 *   am:resolved:<postId>               → resolution marker (NX, TTL ~90d) so a post is logged-as-resolved once
 *
 * no user data anywhere. required by reddit's public content policy.
 */

import { redis } from '@devvit/web/server';
import type { SignalResults } from './score.js';
import type { SubConfig } from '../config/types.js';
import type { SignalName } from '../signals/types.js';
import type { signalBaseline } from '../calibration/baseline.js';
import type { LogEntry } from '../dashboard/types.js';
import type { QueueReason } from './corpus.js';

// ── key builders ─────────────────────────────────────────────────────────────

export const keys = {
  installs:    () => `am:installs`,
  config:      (sub: string) => `am:cfg:${sub}`,
  post:        (postId: string) => `am:post:${postId}`,
  queue:       (sub: string) => `am:queue:${sub}`,
  queuereason: (postId: string) => `am:queuereason:${postId}`,
  slopfeatures:(postId: string) => `am:slopfeatures:${postId}`,
  aggregate:   (sub: string, date: string, signal: SignalName) => `am:agg:${sub}:${date}:${signal}`,
  baseline:    (sub: string, signal: SignalName) => `am:baseline:${sub}:${signal}`,
  samples:     (sub: string, signal: SignalName, feature: string) => `am:samples:${sub}:${signal}:${feature}`,
  actionlog:   (sub: string) => `am:actionlog:${sub}`,
  resolved:    (postId: string) => `am:resolved:${postId}`,
} as const;

/** today's date in yyyy-mm-dd utc. */
export function dateBucket(d: Date = new Date()): string {
  return d.toISOString().slice(0, 10);
}

// ── install index ────────────────────────────────────────────────────────────

/** Register a sub as installed. Called from onAppInstall. Idempotent. */
export async function registerInstall(sub: string): Promise<void> {
  await redis.zAdd(keys.installs(), { score: Date.now(), member: sub });
}

/** Mark a sub as uninstalled. Called from onAppRemoved if/when wired. */
export async function unregisterInstall(sub: string): Promise<void> {
  await redis.zRem(keys.installs(), [sub]);
}

/** Enumerate all installed subs. Used by the daily rollup. */
export async function listInstalls(): Promise<string[]> {
  const entries = await redis.zRange(keys.installs(), 0, -1, { by: 'score' });
  return entries.map((e) => e.member);
}

// ── config helpers ────────────────────────────────────────────────────────────

export async function loadConfig(sub: string): Promise<SubConfig | null> {
  const raw = await redis.hGet(keys.config(sub), 'data');
  if (!raw) return null;
  try { return JSON.parse(raw) as SubConfig; }
  catch { return null; }
}

export async function saveConfig(config: SubConfig): Promise<void> {
  await redis.hSet(keys.config(config.subreddit), { data: JSON.stringify(config) });
}

// ── per-post results ──────────────────────────────────────────────────────────

export interface storedPostResult {
  sub: string;
  scores: Record<SignalName, number>;
  reasons: Record<SignalName, string[]>;
  ts: number;
  /** Post title snapshot, for mod identification in the queue/log. May be ''
   *  for posts scored before this field existed. */
  title: string;
}

export async function savePostResult(
  postId: string,
  sub: string,
  results: SignalResults,
  title = ''
): Promise<void> {
  const scores: Record<string, number> = {};
  const reasons: Record<string, string[]> = {};
  for (const signal of ['tea', 'time', 'clown', 'slop'] as const) {
    scores[signal] = results[signal].score;
    reasons[signal] = results[signal].reasons;
  }
  const ts = Date.now();
  await redis.hSet(keys.post(postId), {
    sub,
    scores: JSON.stringify(scores),
    reasons: JSON.stringify(reasons),
    ts: String(ts),
    title,
  });
  await redis.expire(keys.post(postId), 60 * 60 * 24 * 30);
}

export async function loadPostResult(postId: string): Promise<storedPostResult | null> {
  const raw = await redis.hGetAll(keys.post(postId));
  if (!raw || !raw['sub']) return null;
  try {
    return {
      sub: raw['sub'],
      scores: JSON.parse(raw['scores'] ?? '{}'),
      reasons: JSON.parse(raw['reasons'] ?? '{}'),
      ts: Number(raw['ts'] ?? 0),
      title: raw['title'] ?? '',
    };
  } catch { return null; }
}

// ── triage queue ──────────────────────────────────────────────────────────────

export function computePriority(results: SignalResults): number {
  return (
    results.slop.score * 3 +
    results.clown.score * 2 +
    results.time.score * 2 +
    results.tea.score * 1
  );
}

export async function addToQueue(
  sub: string,
  postId: string,
  priority: number,
  reason?: QueueReason
): Promise<void> {
  await redis.zAdd(keys.queue(sub), { score: priority, member: postId });
  // Cap at 500 most recent high-priority posts. Stale low-priority entries
  // (and entries whose underlying am:post:<id> hash expired after 30 days)
  // can still linger; we accept that for now.
  await redis.zRemRangeByRank(keys.queue(sub), 0, -501);
  // Block 2 purity filter: record WHY this post was queued so a later mod
  // verdict can be admitted to (or rejected from) the Slop corpus. Optional so
  // non-rule queueing paths (reconciliation, future passes) don't have to set
  // it; only rule-fired queueing carries a reason.
  if (reason) {
    await recordQueueReason(postId, reason);
  }
}

export async function getTopQueue(
  sub: string,
  n = 10
): Promise<Array<{ postId: string; priority: number }>> {
  const raw = await redis.zRange(keys.queue(sub), 0, n - 1, { by: 'score', reverse: true });
  return raw.map((entry) => ({ postId: entry.member, priority: entry.score }));
}

/**
 * Remove a single post from a sub's triage queue. Used by the dismiss/handoff
 * endpoints (routes/api.ts) and by queue reconciliation. Idempotent: zRem on a
 * member that isn't present is a no-op.
 */
export async function removeFromQueue(sub: string, postId: string): Promise<void> {
  await redis.zRem(keys.queue(sub), [postId]);
}

// ── queue reason (Block 2 Task 1, Slop purity filter) ─────────────────────────
//
// One per-post marker recording why a post entered the queue: the fired rule's
// id + the union of fired conditions. corpus.ts :: wasQueuedOnSlop reads this to
// decide whether a passive mod verdict on the post is Slop-corpus-eligible.
// Stored as a hash field 'data' (mirrors am:cfg / am:baseline), TTL 90d to
// match the resolution marker + log retention window.

const QUEUE_REASON_TTL_SECONDS = 60 * 60 * 24 * 90; // 90 days

/** Record why a post was queued. Idempotent (last write wins). */
export async function recordQueueReason(postId: string, reason: QueueReason): Promise<void> {
  await redis.hSet(keys.queuereason(postId), { data: JSON.stringify(reason) });
  await redis.expire(keys.queuereason(postId), QUEUE_REASON_TTL_SECONDS);
}

/** Read a post's queue reason back, or null if absent/unparseable. */
export async function loadQueueReason(postId: string): Promise<QueueReason | null> {
  const raw = await redis.hGet(keys.queuereason(postId), 'data');
  if (!raw) return null;
  try { return JSON.parse(raw) as QueueReason; }
  catch { return null; }
}

// ── raw Slop feature vector (Block 2 Task 3, corpus harvesting) ───────────────
//
// The corpus needs the post's raw Slop feature COMPONENTS (the rawFeatures map
// slopExtractor returns), not the 0–5 score. We persist them in a separate hash
// (not the hot am:post hash) so a verdict handler can rebuild the canonical
// training vector later via slopFeatureVector(). Written from triggers.ts using
// the PRE-aggressiveness rawResults.slop.rawFeatures, matching recordSamples.
// 90d TTL to match the resolution / queue-reason markers.

const SLOP_FEATURES_TTL_SECONDS = 60 * 60 * 24 * 90; // 90 days

/** Persist a post's raw Slop feature components. Idempotent (last write wins). */
export async function saveSlopFeatures(
  postId: string,
  features: Record<string, number>
): Promise<void> {
  await redis.hSet(keys.slopfeatures(postId), { data: JSON.stringify(features) });
  await redis.expire(keys.slopfeatures(postId), SLOP_FEATURES_TTL_SECONDS);
}

/** Read a post's raw Slop feature components, or null if absent/unparseable. */
export async function loadSlopFeatures(
  postId: string
): Promise<Record<string, number> | null> {
  const raw = await redis.hGet(keys.slopfeatures(postId), 'data');
  if (!raw) return null;
  try { return JSON.parse(raw) as Record<string, number>; }
  catch { return null; }
}

// ── the unified action log (Block 1 §3) ───────────────────────────────────────
//
// One sorted set per sub, scored by ts(ms), member = JSON-encoded LogEntry.
// Mirrors how am:queue and am:agg:* sets are already used (range-by-time reads,
// range-by-rank trims, zRemRangeByScore for the purge) — not a new primitive.

/** Hard cap on log size between daily purges so a busy sub can't grow unbounded. */
const LOG_HARD_CAP = 5000;

/**
 * Short, collision-resistant id embedded in each log entry's JSON so that two
 * entries written in the same millisecond are still distinct sorted-set members
 * (members must be unique). Same shape as rule-validate.ts::newRuleId.
 */
function newLogId(): string {
  return `log-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Append a fully-formed log entry. Callers normally use logOutcome() instead,
 * which stamps id + ts for them. zAdd then trim-by-rank to the hard cap.
 */
export async function appendLog(sub: string, entry: LogEntry): Promise<void> {
  await redis.zAdd(keys.actionlog(sub), { score: entry.ts, member: JSON.stringify(entry) });
  // keep only the most recent LOG_HARD_CAP entries (lowest-score = oldest get trimmed)
  await redis.zRemRangeByRank(keys.actionlog(sub), 0, -(LOG_HARD_CAP + 1));
}

/**
 * Convenience wrapper: stamps id + ts and appends. So callers in triggers.ts
 * and api.ts never hand-build an entry (and can't forget the id, which would
 * risk same-ms member collisions).
 */
export async function logOutcome(
  sub: string,
  partial: Omit<LogEntry, 'id' | 'ts'> & { ts?: number }
): Promise<void> {
  const entry: LogEntry = {
    id: newLogId(),
    ts: partial.ts ?? Date.now(),
    postId: partial.postId,
    outcome: partial.outcome,
    actor: partial.actor,
    scores: partial.scores,
    ...(partial.detail !== undefined ? { detail: partial.detail } : {}),
    ...(partial.title !== undefined ? { title: partial.title } : {}),
  };
  await appendLog(sub, entry);
}

/**
 * Read log entries newest-first. `limit` caps the number returned; `before`
 * (a ts in ms) pages further back by returning only entries strictly older
 * than it. Unparseable members are dropped (forward-compatible if the shape
 * evolves).
 */
export async function readLog(
  sub: string,
  opts: { limit: number; before?: number }
): Promise<LogEntry[]> {
  const max = opts.before !== undefined ? opts.before - 1 : Date.now();
  const raw = await redis.zRange(keys.actionlog(sub), 0, max, { by: 'score', reverse: true });
  const entries: LogEntry[] = [];
  for (const { member } of raw) {
    if (entries.length >= opts.limit) break;
    try {
      entries.push(JSON.parse(member) as LogEntry);
    } catch {
      // drop unparseable members
    }
  }
  return entries;
}

/** Purge log entries older than `cutoffMs`. Used by the daily scheduler. */
export async function purgeLogOlderThan(sub: string, cutoffMs: number): Promise<void> {
  await redis.zRemRangeByScore(keys.actionlog(sub), 0, cutoffMs);
}

// ── resolution marker (Block 1 §4.4) ──────────────────────────────────────────

const RESOLVED_TTL_SECONDS = 60 * 60 * 24 * 90; // 90 days, matching log retention

/**
 * Try to claim a post as "resolved" (left the queue) exactly once. Returns true
 * if THIS caller is the first to mark it resolved, false if a prior
 * dismiss/handoff/reconcile already did.
 *
 * Dismiss and handoff call this so an in-app resolution isn't ALSO logged by
 * reconciliation; reconciliation gates its own "resolved on Reddit" log entry
 * on winning this claim, so repeated refreshes by multiple mods don't duplicate.
 *
 * Implementation note: we use the read-then-write pattern (get → set → expire)
 * because that's the redis surface the rest of storage.ts already relies on
 * (menu.ts uses redis.set(key,value) with two args; TTLs go through
 * redis.expire(key,seconds)). This is NOT a fully atomic check-and-set: under a
 * genuine same-millisecond race between two refreshes the marker can be claimed
 * twice, producing at most one duplicate reconciliation log entry. That is the
 * exact failure §4.3/§4.4 tolerate (the log is append-only history, not a
 * correctness gate), so the simpler portable pattern is the right trade here.
 * If a stronger guarantee is wanted later, swap the body for a native SET ... NX
 * once that option shape is confirmed in playtest (§9) — callers don't change.
 */
export async function claimResolved(postId: string): Promise<boolean> {
  const key = keys.resolved(postId);
  const existing = await redis.get(key);
  if (existing) return false;
  await redis.set(key, String(Date.now()));
  await redis.expire(key, RESOLVED_TTL_SECONDS);
  return true;
}

// ── daily aggregates ──────────────────────────────────────────────────────────

export async function recordDailyAggregate(
  sub: string,
  postId: string,
  results: SignalResults
): Promise<void> {
  const date = dateBucket();
  for (const signal of ['tea', 'time', 'clown', 'slop'] as const) {
    const score = results[signal].score;
    if (score > 0) {
      await redis.zAdd(keys.aggregate(sub, date, signal), { score, member: postId });
    }
  }
}

// ── calibration samples ───────────────────────────────────────────────────────

const sampleWindowSize = 1000;

/**
 * record raw feature values for one post into capped sorted sets.
 * one zadd per (signal, feature) pair. fire-and-forget: failures don't block scoring.
 *
 * the sorted-set score is the raw feature value (that's what the rollup reads).
 * the member is `${postId}:${feature}` so two posts with identical feature values
 * don't collide and overwrite each other.
 */
export async function recordSamples(
  sub: string,
  postId: string,
  results: SignalResults
): Promise<void> {
  for (const signal of ['tea', 'time', 'clown', 'slop'] as const) {
    const features = results[signal].rawFeatures;
    for (const [feature, value] of Object.entries(features)) {
      if (typeof value !== 'number' || !isFinite(value)) continue;
      // skip the synthetic _composite01 field — that's not a raw feature
      if (feature.startsWith('_')) continue;
      const key = keys.samples(sub, signal, feature);
      await redis.zAdd(key, { score: value, member: `${postId}:${feature}` });
      await redis.zRemRangeByRank(key, 0, -(sampleWindowSize + 1));
    }
  }
}

/**
 * read all samples for one (sub, signal, feature) from the sorted set.
 * returns the scores (which are the raw feature values).
 */
export async function readFeatureSamples(
  sub: string,
  signal: SignalName,
  feature: string
): Promise<number[]> {
  const key = keys.samples(sub, signal, feature);
  const entries = await redis.zRange(key, 0, -1, { by: 'score' });
  return entries.map((e) => e.score);
}

// ── baseline persistence ──────────────────────────────────────────────────────

export async function loadBaseline(
  sub: string,
  signal: SignalName
): Promise<signalBaseline | null> {
  const raw = await redis.hGet(keys.baseline(sub, signal), 'data');
  if (!raw) return null;
  try { return JSON.parse(raw) as signalBaseline; }
  catch { return null; }
}

export async function saveBaseline(
  sub: string,
  signal: SignalName,
  baseline: signalBaseline
): Promise<void> {
  await redis.hSet(keys.baseline(sub, signal), { data: JSON.stringify(baseline) });
}

/**
 * load all four baselines for a sub in one logical call.
 * returns a map of signal → baseline (or null if not yet learned).
 * called once per post in the hot path.
 */
export async function loadBaselines(
  sub: string
): Promise<Record<SignalName, signalBaseline | null>> {
  const [tea, time, clown, slop] = await Promise.all([
    loadBaseline(sub, 'tea'),
    loadBaseline(sub, 'time'),
    loadBaseline(sub, 'clown'),
    loadBaseline(sub, 'slop'),
  ]);
  return { tea, time, clown, slop };
}

// ── deletion compliance ───────────────────────────────────────────────────────

export async function purgePostData(postId: string): Promise<void> {
  const result = await loadPostResult(postId);
  if (result) {
    await redis.zRem(keys.queue(result.sub), [postId]);
    const date = dateBucket();
    for (const signal of ['tea', 'time', 'clown', 'slop'] as const) {
      await redis.zRem(keys.aggregate(result.sub, date, signal), [postId]);
    }
  }
  await redis.del(keys.post(postId));
}
