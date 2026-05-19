/**
 * Scheduler handlers. Mounted at /internal/jobs in src/index.ts.
 *
 * Currently one job:
 *   daily-rollup : 07:00 UTC. Rolls up the previous day's aggregates into
 *   the per-sub baseline used for percentile calibration.
 *
 * The endpoint is defined in devvit.json under scheduler.tasks. Devvit calls
 * the endpoint at the scheduled time.
 */

import { Hono } from 'hono';
import type { TriggerResponse } from '@devvit/web/shared';

export const scheduler = new Hono();

scheduler.post('/daily-rollup', async (c) => {
  // TODO Day 4-5: read previous day's aggregate sets, update baseline
  // distributions, recompute percentile thresholds per sub.
  //
  // For the foundational scaffold this is a no-op. The trigger fires and
  // returns success so Devvit's scheduler stays happy.
  console.log('[aurameter] dailyRollup tick (no-op pending Day 4-5)');
  return c.json<TriggerResponse>({ status: 'success' }, 200);
});
