/**
 * scheduler handlers. mounted at /internal/jobs in src/index.ts.
 *
 * daily-rollup runs at 07:00 utc. for each active sub it reads the
 * calibration sample windows, computes percentile baselines, and writes
 * them back to redis. the hot path (onPostSubmit) then picks them up on
 * the next post.
 *
 * this is the only place that does O(n log n) work. the hot path is O(1).
 */

import { Hono } from 'hono';
import type { TriggerResponse } from '@devvit/web/shared';
import { redis } from '@devvit/web/server';
import type { SignalName } from '../core/signals/types.js';
import { readFeatureSamples, saveBaseline, keys } from '../core/engine/storage.js';
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

/**
 * get the list of subreddits that have config stored.
 * scans keys matching am:cfg:* to find them.
 */
async function getActiveSubs(): Promise<string[]> {
  // devvit's redis client exposes scan or keys depending on version.
  // we use a pattern scan; if the api isn't available we return empty.
  try {
    // @ts-expect-error – redis.keys may not be typed but is available at runtime
    const matched: string[] = await redis.keys('am:cfg:*');
    return matched.map((k) => k.replace('am:cfg:', ''));
  } catch {
    console.warn('[aurameter] rollup: could not enumerate subs via redis.keys');
    return [];
  }
}

scheduler.post('/daily-rollup', async (c) => {
  const subs = await getActiveSubs();

  if (subs.length === 0) {
    console.log('[aurameter] dailyRollup: no active subs found');
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
