/**
 * scheduler handlers. mounted at /internal/jobs in src/index.ts.
 *
 * daily-rollup runs at 07:00 utc. for each active sub it reads the
 * calibration sample windows, computes percentile baselines, and writes
 * them back to redis. the hot path (onPostSubmit) then picks them up on
 * the next post.
 *
 * it also purges action-log entries older than the 90-day retention window
 * (Block 1 §3): the actionlog sorted set is trimmed by rank on every write to
 * a hard cap, but the time-based purge is what enforces the actual retention
 * policy and keeps a low-traffic sub's log from holding ancient entries.
 *
 * Block 2 (Task 9): after the per-sub rollup, it does ONE global check — is the
 * pooled Slop corpus due for an offline retrain? — and logs a flag if so. The
 * app only flags; it never fits (Devvit has no training runtime). A maintainer
 * acts on the flag via tools/slop-trainer/RETRAIN.md.
 *
 * this is the only place that does O(n log n) work. the hot path is O(1).
 *
 * active subs come from an explicit sorted-set index (am:installs),
 * NOT from redis.keys() — which devvit's redis doesn't support and which
 * would be O(n) blocking anyway.
 */

import { Hono } from 'hono';
import type { TriggerResponse } from '@devvit/web/shared';
import type { SignalName } from '../core/signals/types.js';
import {
  readFeatureSamples,
  saveBaseline,
  listInstalls,
  purgeLogOlderThan,
} from '../core/engine/storage.js';
import {
  corpusSize,
  loadLastRetrainAt,
  isRetrainDue,
  MIN_RETRAIN_CORPUS,
} from '../core/engine/corpus.js';
import { computeBaseline } from '../core/calibration/baseline.js';

export const scheduler = new Hono();

const minimumSampleSize = 50;

/** Action-log retention: 90 days, matching the am:resolved marker TTL. */
const logRetentionMs = 90 * 24 * 60 * 60 * 1000;

const signalFeatures: Record<SignalName, string[]> = {
  tea:   ['stakesDensity', 'castMatches', 'conflictDensity', 'cliffhanger', 'titleHook'],
  time:  ['futureMatches', 'crisisMatches', 'deadlineMatches'],
  clown: ['asymmetryHits', 'justifyMatches', 'enumerationCount', 'strawmanMatches'],
  slop:  ['fingerprintHits', 'sentLenVariance', 'hedgeRate', 'openerDiversity', 'probability'],
};

/**
 * roll up one subreddit: read sample windows, compute baselines, persist.
 */
async function rollupSubreddit(sub: string): Promise<void> {
  const signals: SignalName[] = ['tea', 'time', 'clown', 'slop'];

  for (const signal of signals) {
    const features = signalFeatures[signal];
    const samples: Record<string, number[]> = {};

    for (const feature of features) {
      samples[feature] = await readFeatureSamples(sub, signal, feature);
    }

    const baseline = computeBaseline(samples, minimumSampleSize);
    if (!baseline) {
      console.log(`[aurameter] ${sub}/${signal}: below minimum sample size, keeping defaults`);
      continue;
    }

    await saveBaseline(sub, signal, baseline);
    console.log(`[aurameter] ${sub}/${signal}: baseline updated, sampleSize=${baseline.sampleSize}`);
  }

  // Purge action-log entries past the retention window. Cheap (one
  // zRemRangeByScore) and idempotent — safe to run every day even if nothing
  // is old enough to remove yet.
  try {
    await purgeLogOlderThan(sub, Date.now() - logRetentionMs);
  } catch (err) {
    console.error(`[aurameter] ${sub}: action-log purge failed:`, err);
  }
}

/**
 * Block 2 Task 9: ONE global check (not per-sub — the corpus + model are
 * global). Logs a retrain-due flag when the pooled corpus is both big enough
 * and stale enough. Flag only — the offline trainer (tools/slop-trainer) does
 * the actual fit. Never throws into the rollup; a failure here must not abort
 * the (more important) baseline work.
 */
async function checkRetrainReadiness(): Promise<void> {
  try {
    const [n, lastAt] = await Promise.all([corpusSize(), loadLastRetrainAt()]);
    if (isRetrainDue(n, lastAt, Date.now())) {
      const lastLabel = lastAt > 0 ? new Date(lastAt).toISOString() : 'never';
      console.log(
        `[aurameter] RETRAIN DUE: slop corpus has ${n} entries (>= ${MIN_RETRAIN_CORPUS}), ` +
        `last retrain ${lastLabel}. Run tools/slop-trainer/RETRAIN.md.`
      );
    } else {
      console.log(`[aurameter] retrain check: corpus=${n}, not due`);
    }
  } catch (err) {
    console.error('[aurameter] retrain-readiness check failed:', err);
  }
}

scheduler.post('/daily-rollup', async (c) => {
  const subs = await listInstalls();

  if (subs.length === 0) {
    console.log('[aurameter] dailyRollup: no active subs in install index');
    // Still run the global retrain check — the corpus is global and may be due
    // even on a quiet day. (No subs is unusual but shouldn't skip it.)
    await checkRetrainReadiness();
    return c.json<TriggerResponse>({ status: 'success' }, 200);
  }

  console.log(`[aurameter] dailyRollup: rolling up ${subs.length} subreddit(s)`);

  // run sequentially to avoid saturating redis connection pool
  for (const sub of subs) {
    try {
      await rollupSubreddit(sub);
    } catch (err) {
      // one sub failing shouldn't abort the rest
      console.error(`[aurameter] dailyRollup: error on ${sub}:`, err);
    }
  }

  // Block 2: global retrain-readiness flag, once per rollup.
  await checkRetrainReadiness();

  return c.json<TriggerResponse>({ status: 'success' }, 200);
});
