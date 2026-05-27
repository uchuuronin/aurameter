/**
 * Spot-check engine (Block 2, Tasks 5 + 6).
 *
 * Spot-check is a per-sub OPT-IN: a mod asks to be shown a small batch of posts
 * to label as AI / not-AI. Those explicit labels (a) feed the global Slop corpus
 * (bypassing the passive purity gate — the mod is directly labeling) and (b)
 * nudge this sub's Slop percentile baseline so its 2<->3 flagging boundary
 * self-sharpens.
 *
 * Sampling (locked): BORDERLINE_FRACTION (0.7) of the batch is the posts nearest
 * the current 2<->3 Slop boundary (most informative for tuning), the remainder is
 * high-confidence Slop (score 4-5) to catch the model being completely wrong.
 *
 * The batch selector is pure and unit-tested. Opt-in state lives on SubConfig;
 * the pending-review queue is a per-sub sorted set; verdict recording routes to
 * corpus.appendVerdict + a per-sub baseline-sample contribution.
 */

import { redis } from '@devvit/web/server';
import type { SignalName } from '../signals/types.js';
import { keys } from './storage.js';
import { appendVerdict, type SlopLabel } from './corpus.js';

// -- tunables (locked by plan) ------------------------------------------------

export const OPTIN_BATCH = 10;
export const RESET_BATCH = 18; // in the plan's 15-20 range
export const BORDERLINE_FRACTION = 0.7;

/**
 * The 2<->3 boundary in composite01 space. For the 0..5 discretise thresholds
 * [0.20, 0.40, 0.60, 0.80, 1.00] (calibration/baseline.ts), a score crosses
 * from 2 to 3 at 0.60. "Borderline" = composite01 nearest this value.
 */
const SLOP_BOUNDARY_01 = 0.60;

/** A candidate post the selector ranks. composite01 is the continuous reading. */
export interface SpotCheckCandidate {
  postId: string;
  /** discretised 0..5 slop score */
  score: number;
  /** continuous 0..1 slop reading (the calibrated composite) */
  composite01: number;
}

export interface SpotCheckBatchOpts {
  size: number;
  borderlineFraction?: number;
}

/**
 * Select a spot-check batch (pure). Borderline-first (nearest the 2<->3
 * boundary), remainder filled with high-confidence Slop (score >= 4), then any
 * leftover slots backfilled by boundary distance. Never returns duplicates and
 * never returns more than `size` or more than `candidates.length`.
 */
export function selectSpotCheckBatch(
  candidates: SpotCheckCandidate[],
  opts: SpotCheckBatchOpts,
): SpotCheckCandidate[] {
  const size = Math.max(0, Math.min(opts.size, candidates.length));
  if (size === 0) return [];
  const fraction = opts.borderlineFraction ?? BORDERLINE_FRACTION;

  const byBoundary = [...candidates].sort(
    (a, b) => Math.abs(a.composite01 - SLOP_BOUNDARY_01) - Math.abs(b.composite01 - SLOP_BOUNDARY_01),
  );

  const nBorderline = Math.min(size, Math.round(size * fraction));
  const borderline = byBoundary.slice(0, nBorderline);
  const chosen = new Set(borderline.map((c) => c.postId));

  // remainder: high-confidence Slop (score 4-5), highest score first.
  const remainderSlots = size - borderline.length;
  const highConf = candidates
    .filter((c) => c.score >= 4 && !chosen.has(c.postId))
    .sort((a, b) => b.score - a.score)
    .slice(0, remainderSlots);
  for (const c of highConf) chosen.add(c.postId);

  const batch = [...borderline, ...highConf];

  // backfill any remaining slots (not enough high-conf) by boundary distance.
  if (batch.length < size) {
    for (const c of byBoundary) {
      if (batch.length >= size) break;
      if (!chosen.has(c.postId)) {
        batch.push(c);
        chosen.add(c.postId);
      }
    }
  }

  return batch;
}

// -- pending-review queue (per-sub) -------------------------------------------

/** Per-sub set of postIds awaiting a spot-check verdict, scored by enqueue ts. */
const spotcheckKey = (sub: string) => `am:spotcheck:${sub}`;

/** Enqueue a selected batch for review. Idempotent per postId (zAdd upsert). */
export async function enqueueSpotCheckBatch(
  sub: string,
  batch: SpotCheckCandidate[],
): Promise<void> {
  const now = Date.now();
  for (const c of batch) {
    await redis.zAdd(spotcheckKey(sub), { score: now, member: c.postId });
  }
}

/** Read the postIds currently awaiting review (newest-first). */
export async function readSpotCheckQueue(sub: string, n = OPTIN_BATCH): Promise<string[]> {
  const raw = await redis.zRange(spotcheckKey(sub), 0, -1, { by: 'score', reverse: true });
  return raw.slice(0, n).map((e) => e.member);
}

/** Remove a post from the pending-review queue (after a verdict, or on dismiss). */
export async function removeFromSpotCheck(sub: string, postId: string): Promise<void> {
  await redis.zRem(spotcheckKey(sub), [postId]);
}

// -- verdict recording + baseline feedback (Task 6) ---------------------------

/**
 * Record an explicit spot-check verdict:
 *   1. append to the global corpus (source:'spotcheck' bypasses the purity gate).
 *   2. contribute a weighted sample into this sub's Slop baseline window so the
 *      2<->3 boundary moves as verdicts accumulate (reuses recordSamples'
 *      am:samples:<sub>:slop:<feature> sets that the nightly rollup reads).
 *   3. drop the post from the pending queue.
 *
 * Returns whether the corpus accepted the entry (false only if the post had no
 * stored feature vector — e.g. it was skipped at scoring time).
 */
export async function recordSpotCheckVerdict(
  sub: string,
  postId: string,
  label: SlopLabel,
): Promise<boolean> {
  const appended = await appendVerdict({ postId, label, source: 'spotcheck' });
  await feedVerdictIntoBaseline(sub, postId, label);
  await removeFromSpotCheck(sub, postId);
  return appended;
}

/**
 * Nudge the sub's Slop baseline using a verdict. The baseline is the percentile
 * model over the `probability` feature (among others). A spot-check verdict is
 * high-signal, so we weight it more than a single passive sample by writing the
 * post's stored `probability` into the slop probability sample window multiple
 * times. The nightly rollup (scheduler.ts) recomputes percentiles from that
 * window, shifting the 2<->3 border toward the mod's judgments.
 *
 * Implementation detail: we read the persisted slop feature vector for the
 * post's `probability` and re-add it with a verdict-weighted member key so it
 * counts as several samples. If the vector is missing we no-op (nothing to
 * weight).
 */
const VERDICT_SAMPLE_WEIGHT = 5;

async function feedVerdictIntoBaseline(
  sub: string,
  postId: string,
  label: SlopLabel,
): Promise<void> {
  // Read the post's stored slop feature vector for its probability reading.
  const raw = await redis.hGet(keys.slopfeatures(postId), 'data');
  if (!raw) return;
  let features: Record<string, number>;
  try {
    features = JSON.parse(raw) as Record<string, number>;
  } catch {
    return;
  }
  const probability = features['probability'];
  if (typeof probability !== 'number' || !isFinite(probability)) return;

  // Write VERDICT_SAMPLE_WEIGHT weighted samples into the slop `probability`
  // window. label=1 (ai) pushes the high end, label=0 (not-ai) the low end; we
  // bias the written value slightly toward the verdict so the percentile border
  // moves in the right direction without discarding the measured probability.
  const signal: SignalName = 'slop';
  const key = keys.samples(sub, signal, 'probability');
  const biased = label === 1
    ? Math.min(1, probability + 0.1)
    : Math.max(0, probability - 0.1);
  for (let i = 0; i < VERDICT_SAMPLE_WEIGHT; i++) {
    await redis.zAdd(key, { score: biased, member: `verdict:${postId}:${i}` });
  }
  // mirror recordSamples' cap so the window stays bounded.
  await redis.zRemRangeByRank(key, 0, -(1000 + 1));
}

// -- reset (Task 6) -----------------------------------------------------------

/**
 * Reset this sub's Slop threshold to the global default: delete the learned
 * baseline so calibrate() falls back to defaultBaselines.slop. Global model
 * weights are untouched (nothing per-sub to reset there). Caller then enqueues a
 * RESET_BATCH spot-check to re-establish the border from fresh verdicts.
 */
export async function resetSlopThreshold(sub: string): Promise<void> {
  await redis.del(keys.baseline(sub, 'slop'));
}
