// src/core/engine/__tests__/spotcheck.test.ts
//
// Block 2 Tasks 5 + 6.
//   Task 5: selectSpotCheckBatch (pure) + queue enqueue/read round-trip.
//   Task 6: resetSlopThreshold clears the learned slop baseline; verdict
//           recording feeds the slop sample window.

import { describe, it, expect, beforeEach } from 'vitest';
import {
  selectSpotCheckBatch,
  enqueueSpotCheckBatch,
  readSpotCheckQueue,
  recordSpotCheckVerdict,
  resetSlopThreshold,
  OPTIN_BATCH,
  type SpotCheckCandidate,
} from '../spotcheck.js';
import {
  saveSlopFeatures,
  saveBaseline,
  loadBaseline,
  readFeatureSamples,
  recordQueueReason,
} from '../storage.js';
import { __resetRedis } from '../../../../test/devvit-server-mock.js';
import type { signalBaseline } from '../../calibration/baseline.js';

beforeEach(() => {
  __resetRedis();
});

function candidate(postId: string, score: number, composite01: number): SpotCheckCandidate {
  return { postId, score, composite01 };
}

// ── Task 5: selectSpotCheckBatch (pure) ───────────────────────────────────────

describe('selectSpotCheckBatch', () => {
  const candidates: SpotCheckCandidate[] = [
    candidate('p_low', 1, 0.10),
    candidate('p_b1', 2, 0.55),
    candidate('p_b2', 3, 0.62),
    candidate('p_b3', 3, 0.60), // exactly on the 2<->3 boundary
    candidate('p_b4', 2, 0.50),
    candidate('p_hi1', 4, 0.82),
    candidate('p_hi2', 5, 0.95),
    candidate('p_hi3', 5, 0.99),
    candidate('p_b5', 3, 0.66),
    candidate('p_low2', 1, 0.20),
  ];

  it('returns exactly `size` items when enough candidates exist', () => {
    const batch = selectSpotCheckBatch(candidates, { size: 6 });
    expect(batch).toHaveLength(6);
  });

  it('has no duplicates', () => {
    const batch = selectSpotCheckBatch(candidates, { size: 8 });
    const ids = batch.map((c) => c.postId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('prefers borderline posts (nearest the 2<->3 boundary)', () => {
    const batch = selectSpotCheckBatch(candidates, { size: 4, borderlineFraction: 0.75 });
    // round(4*0.75)=3 borderline. The post exactly on 0.60 must be included.
    expect(batch.map((c) => c.postId)).toContain('p_b3');
  });

  it('fills the remainder with high-confidence (score 4-5) posts', () => {
    const batch = selectSpotCheckBatch(candidates, { size: 4, borderlineFraction: 0.5 });
    // 2 borderline + 2 high-conf. At least one score>=4 should appear.
    expect(batch.some((c) => c.score >= 4)).toBe(true);
  });

  it('handles fewer candidates than size (returns all, no dupes)', () => {
    const few = candidates.slice(0, 3);
    const batch = selectSpotCheckBatch(few, { size: 10 });
    expect(batch).toHaveLength(3);
    expect(new Set(batch.map((c) => c.postId)).size).toBe(3);
  });

  it('returns empty for size 0 or no candidates', () => {
    expect(selectSpotCheckBatch(candidates, { size: 0 })).toHaveLength(0);
    expect(selectSpotCheckBatch([], { size: 5 })).toHaveLength(0);
  });
});

// ── Task 5: queue round-trip ──────────────────────────────────────────────────

describe('enqueueSpotCheckBatch + readSpotCheckQueue', () => {
  it('enqueued posts are read back', async () => {
    const batch = [candidate('t3_a', 3, 0.6), candidate('t3_b', 4, 0.82)];
    await enqueueSpotCheckBatch('testsub', batch);
    const ids = await readSpotCheckQueue('testsub', OPTIN_BATCH);
    expect(new Set(ids)).toEqual(new Set(['t3_a', 't3_b']));
  });

  it('recordSpotCheckVerdict removes the post from the queue', async () => {
    await enqueueSpotCheckBatch('testsub', [candidate('t3_a', 3, 0.6)]);
    // give it features + a (tea-only) reason: spotcheck bypasses purity.
    await recordQueueReason('t3_a', {
      ruleId: 'tea', conditions: [{ signal: 'tea', comparator: '>=', threshold: 4 }],
    });
    await saveSlopFeatures('t3_a', { probability: 0.7 });

    await recordSpotCheckVerdict('testsub', 't3_a', 1);
    const ids = await readSpotCheckQueue('testsub', OPTIN_BATCH);
    expect(ids).not.toContain('t3_a');
  });

  it('recordSpotCheckVerdict feeds the slop probability sample window', async () => {
    await saveSlopFeatures('t3_a', { probability: 0.7 });
    await recordSpotCheckVerdict('testsub', 't3_a', 1);
    const samples = await readFeatureSamples('testsub', 'slop', 'probability');
    // VERDICT_SAMPLE_WEIGHT (5) weighted samples written.
    expect(samples.length).toBeGreaterThanOrEqual(5);
  });
});

// ── Task 6: reset ─────────────────────────────────────────────────────────────

describe('resetSlopThreshold', () => {
  it('clears the learned slop baseline so loadBaseline returns null', async () => {
    const baseline: signalBaseline = {
      schemaVersion: '1', computedAt: 1, sampleSize: 100,
      features: { probability: { p25: 0.1, p50: 0.3, p70: 0.5, p85: 0.7, p95: 0.9 } },
    };
    await saveBaseline('testsub', 'slop', baseline);
    expect(await loadBaseline('testsub', 'slop')).not.toBeNull();

    await resetSlopThreshold('testsub');
    expect(await loadBaseline('testsub', 'slop')).toBeNull();
  });

  it('leaves OTHER signals\u2019 baselines intact', async () => {
    const baseline: signalBaseline = {
      schemaVersion: '1', computedAt: 1, sampleSize: 100,
      features: { stakesDensity: { p25: 0, p50: 0.4, p70: 1.1, p85: 2.3, p95: 4 } },
    };
    await saveBaseline('testsub', 'tea', baseline);
    await resetSlopThreshold('testsub');
    expect(await loadBaseline('testsub', 'tea')).not.toBeNull();
  });
});
