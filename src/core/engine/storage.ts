/**
 * Storage layer: Redis schemas and helpers.
 *
 * All Redis access in aurameter goes through this file. That keeps key shapes
 * consistent, makes the deletion-compliance purges easy to audit, and gives a
 * single place to migrate schemas if Redis APIs change.
 *
 * Key conventions:
 *   am:cfg:<sub>                    → SubConfig (JSON hash field 'data')
 *   am:post:<postId>                → per-post results hash
 *     fields: 'sub', 'scores' (JSON), 'reasons' (JSON), 'ts'
 *   am:queue:<sub>                  → sorted set of post IDs by composite priority
 *   am:agg:<sub>:<yyyy-mm-dd>:<sig> → sorted set of post IDs by score, for daily rollups
 *   am:baseline:<sub>:<sig>         → per-sub baseline stats (JSON hash)
 *
 * No user data anywhere. Required by Reddit's Public Content Policy. If you
 * find yourself reaching for a `user:` key, stop.
 */

import { redis } from '@devvit/web/server';
import type { SignalResults } from './score.js';
import type { SubConfig } from '../config/types.js';
import type { SignalName } from '../signals/types.js';

// Key builders. Pure functions, easy to test.
// Prefix `am:` for aurameter (was `vc:` for vibecheck in the design doc).

export const keys = {
  config: (sub: string) => `am:cfg:${sub}`,
  post: (postId: string) => `am:post:${postId}`,
  queue: (sub: string) => `am:queue:${sub}`,
  aggregate: (sub: string, date: string, signal: SignalName) => `am:agg:${sub}:${date}:${signal}`,
  baseline: (sub: string, signal: SignalName) => `am:baseline:${sub}:${signal}`,
} as const;

/** Today's date in YYYY-MM-DD UTC. Used for aggregate bucket keys. */
export function dateBucket(d: Date = new Date()): string {
  return d.toISOString().slice(0, 10);
}

// Config helpers.

export async function loadConfig(sub: string): Promise<SubConfig | null> {
  const raw = await redis.hGet(keys.config(sub), 'data');
  if (!raw) return null;
  try {
    return JSON.parse(raw) as SubConfig;
  } catch {
    return null;
  }
}

export async function saveConfig(config: SubConfig): Promise<void> {
  await redis.hSet(keys.config(config.subreddit), { data: JSON.stringify(config) });
}

// Per-post results.

export interface StoredPostResult {
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
  // Set TTL: 30 days. Per-post features purged automatically after this; only
  // aggregates persist longer. Aligns with the deletion-compliance posture.
  await redis.expire(keys.post(postId), 60 * 60 * 24 * 30);
}

export async function loadPostResult(
  postId: string
): Promise<StoredPostResult | null> {
  const raw = await redis.hGetAll(keys.post(postId));
  if (!raw || !raw['sub']) return null;
  try {
    return {
      sub: raw['sub'],
      scores: JSON.parse(raw['scores'] ?? '{}'),
      reasons: JSON.parse(raw['reasons'] ?? '{}'),
      ts: Number(raw['ts'] ?? 0),
    };
  } catch {
    return null;
  }
}

// Triage queue: sorted set keyed by composite priority score.
// Priority = slop*3 + (heat-like signals). Higher = more important to review.

export function computePriority(results: SignalResults): number {
  // Heuristic weighting. Tweak as we learn from mod feedback.
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
  priority: number
): Promise<void> {
  await redis.zAdd(keys.queue(sub), { score: priority, member: postId });
  // Cap queue size to last 500 posts to keep dashboard reads fast.
  // Trim oldest by removing entries with rank 0..-501.
  await redis.zRemRangeByRank(keys.queue(sub), 0, -501);
}

export async function getTopQueue(
  sub: string,
  n = 10
): Promise<Array<{ postId: string; priority: number }>> {
  // Get top N by score, descending.
  const raw = await redis.zRange(keys.queue(sub), 0, n - 1, { by: 'score', reverse: true });
  return raw.map((entry) => ({
    postId: entry.member,
    priority: entry.score,
  }));
}

// Daily aggregates for the trend charts. One zAdd per signal per post.

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

// Deletion compliance. Called from onPostDelete trigger.

export async function purgePostData(postId: string): Promise<void> {
  // Load to find sub, then drop from queue too.
  const result = await loadPostResult(postId);
  if (result) {
    await redis.zRem(keys.queue(result.sub), [postId]);
    // Also drop from today's aggregate buckets (sets the precedent for full
    // deletion-on-purge; older buckets may still contain the post ID until
    // their TTL expires).
    const date = dateBucket();
    for (const signal of ['tea', 'time', 'clown', 'slop'] as const) {
      await redis.zRem(keys.aggregate(result.sub, date, signal), [postId]);
    }
  }
  await redis.del(keys.post(postId));
}
