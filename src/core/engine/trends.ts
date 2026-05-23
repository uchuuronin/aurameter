/**
 * trend data reader.
 *
 * reads the daily aggregate sorted sets to build per-signal sparkline data
 * for the dashboard. each bucket holds post_ids scored above 0 that day;
 * we use the count of entries and their mean score as the signal strength.
 *
 * pure storage logic — no business logic, no scoring. lives in engine/ because
 * it reads the same redis keys that storage.ts writes.
 */

import { redis } from '@devvit/web/server';
import type { SignalName } from '../signals/types.js';
import { keys, dateBucket } from './storage.js';

export interface dailySignalPoint {
  date: string;         // yyyy-mm-dd
  count: number;        // posts that scored > 0 that day
  meanScore: number;    // mean score across those posts (0 if count=0)
}

export interface trendSeries {
  signal: SignalName;
  points: dailySignalPoint[];
}

/**
 * read trend data for one signal over the last `days` calendar days.
 * reads one sorted set per day — O(days * log n) total.
 */
export async function readSignalTrend(
  sub: string,
  signal: SignalName,
  days: number
): Promise<trendSeries> {
  const points: dailySignalPoint[] = [];
  const now = new Date();

  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(now);
    d.setUTCDate(d.getUTCDate() - i);
    const date = dateBucket(d);
    const key = keys.aggregate(sub, date, signal);

    // zRange with scores returns [{member, score}]
    const entries = await redis.zRange(key, 0, -1, { by: 'score' });

    if (entries.length === 0) {
      points.push({ date, count: 0, meanScore: 0 });
      continue;
    }

    const total = entries.reduce((sum, e) => sum + e.score, 0);
    points.push({
      date,
      count: entries.length,
      meanScore: total / entries.length,
    });
  }

  return { signal, points };
}

/**
 * read trends for all four signals in parallel.
 * returns 4 series, one per signal.
 */
export async function readAllTrends(
  sub: string,
  days: number
): Promise<trendSeries[]> {
  const signals: SignalName[] = ['tea', 'time', 'clown', 'slop'];
  return Promise.all(signals.map((s) => readSignalTrend(sub, s, days)));
}
