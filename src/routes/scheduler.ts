/**
 * scheduler handlers. mounted at /internal/jobs in src/index.ts.
 *
 * daily-rollup runs at 07:00 utc. for each active sub it reads the
 * calibration sample windows, computes percentile baselines, and writes
 * them back to redis. the hot path (onPostSubmit) then picks them up on
 * the next post.
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
import { readFeatureSamples, saveBaseline, listInstalls } from '../core/engine/storage.js';
import { computeBaseline } from '../core/calibration/baseline.js';

export const scheduler = new Hono();

const minimumSampleSize = 50;

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
}

scheduler.post('/daily-rollup', async (c) => {
  const subs = await listInstalls();

  if (subs.length === 0) {
    console.log('[aurameter] dailyRollup: no active subs in install index');
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

  return c.json<TriggerResponse>({ status: 'success' }, 200);
});
