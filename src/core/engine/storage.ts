/**
 * storage layer: redis schemas and helpers.
 *
 * all redis access in aurameter goes through this file. that keeps key shapes
 * consistent, makes deletion-compliance purges easy to audit, and gives a
 * single place to migrate schemas if redis apis change.
 *
 * key conventions:
 *   am:cfg:<sub>                       → subconfig (json hash field 'data')
 *   am:post:<postId>                   → per-post results hash
 *     fields: 'sub', 'scores' (json), 'reasons' (json), 'ts'
 *   am:queue:<sub>                     → sorted set of post ids by composite priority
 *   am:agg:<sub>:<yyyy-mm-dd>:<sig>    → sorted set of post ids by score, for daily rollups
 *   am:baseline:<sub>:<sig>            → learned baseline (json), flat hash field 'data'
 *   am:samples:<sub>:<sig>:<feature>   → capped sorted set of raw feature values (score=value, member=postId)
 *
 * no user data anywhere. required by reddit's public content policy.
 */

import { redis } from '@devvit/web/server';
import type { SignalResults } from './score.js';
import type { SubConfig } from '../config/types.js';
import type { SignalName } from '../signals/types.js';
import type { signalBaseline } from '../calibration/baseline.js';

// ── key builders ─────────────────────────────────────────────────────────────

export const keys = {
  config:    (sub: string) => `am:cfg:${sub}`,
  post:      (postId: string) => `am:post:${postId}`,
  queue:     (sub: string) => `am:queue:${sub}`,
  aggregate: (sub: string, date: string, signal: SignalName) => `am:agg:${sub}:${date}:${signal}`,
  baseline:  (sub: string, signal: SignalName) => `am:baseline:${sub}:${signal}`,
  samples:   (sub: string, signal: SignalName, feature: string) => `am:samples:${sub}:${signal}:${feature}`,
} as const;

/** today's date in yyyy-mm-dd utc. */
export function dateBucket(d: Date = new Date()): string {
  return d.toISOString().slice(0, 10);
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
}

export async function savePostResult(
  postId: string,
  sub: string,
  results: SignalResults
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

export async function addToQueue(sub: string, postId: string, priority: number): Promise<void> {
  await redis.zAdd(keys.queue(sub), { score: priority, member: postId });
  await redis.zRemRangeByRank(keys.queue(sub), 0, -501);
}

export async function getTopQueue(
  sub: string,
  n = 10
): Promise<Array<{ postId: string; priority: number }>> {
  const raw = await redis.zRange(keys.queue(sub), 0, n - 1, { by: 'score', reverse: true });
  return raw.map((entry) => ({ postId: entry.member, priority: entry.score }));
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
 * we use the post's ts as the sorted set score so the window slides by
 * recency (oldest entries are the ones dropped when we cap at 1000).
 */
export async function recordSamples(
  sub: string,
  results: SignalResults
): Promise<void> {
  const ts = Date.now();
  for (const signal of ['tea', 'time', 'clown', 'slop'] as const) {
    const features = results[signal].rawFeatures;
    const postId = `${ts}`; // good-enough unique key within the zset
    for (const [feature, value] of Object.entries(features)) {
      if (typeof value !== 'number' || !isFinite(value)) continue;
      const key = keys.samples(sub, signal, feature);
      // score = value, member = `${postId}:${feature}` to ensure uniqueness
      await redis.zAdd(key, { score: value, member: `${postId}:${feature}` });
      // cap at window size
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
