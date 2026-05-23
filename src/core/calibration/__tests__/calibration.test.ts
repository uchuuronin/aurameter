import { describe, it, expect } from 'vitest';
import { computePercentiles, valueToPercentile } from '../percentile.js';
import { calibrate, discretise, computeBaseline } from '../baseline.js';
import type { signalBaseline } from '../baseline.js';

// ── percentile.ts tests ──────────────────────────────────────────────────────

describe('computePercentiles', () => {
  it('returns null for empty array', () => {
    expect(computePercentiles([])).toBeNull();
  });

  it('handles single value', () => {
    const bp = computePercentiles([42]);
    expect(bp).not.toBeNull();
    expect(bp!.p25).toBe(42);
    expect(bp!.p50).toBe(42);
    expect(bp!.p95).toBe(42);
  });

  it('computes correct percentiles for known distribution', () => {
    // 0..99 → p50 should be ~49.5
    const vals = Array.from({ length: 100 }, (_, i) => i);
    const bp = computePercentiles(vals);
    expect(bp).not.toBeNull();
    expect(bp!.p50).toBeCloseTo(49.5, 0);
    expect(bp!.p95).toBeCloseTo(94.05, 0);
  });

  it('handles unsorted input', () => {
    const vals = [10, 1, 5, 3, 8];
    const sorted = computePercentiles([1, 3, 5, 8, 10]);
    const unsorted = computePercentiles(vals);
    expect(unsorted!.p50).toBeCloseTo(sorted!.p50, 5);
  });
});

describe('valueToPercentile', () => {
  const bp = { p25: 1, p50: 2, p70: 3, p85: 4, p95: 5 };

  it('returns 0 for value at or below minimum', () => {
    expect(valueToPercentile(0, bp)).toBe(0);
    expect(valueToPercentile(-1, bp)).toBe(0);
  });

  it('returns 0.50 exactly at p50', () => {
    expect(valueToPercentile(2, bp)).toBeCloseTo(0.5, 5);
  });

  it('interpolates between breakpoints', () => {
    // halfway between p25 (1) and p50 (2) → between 0.25 and 0.50
    const mid = valueToPercentile(1.5, bp);
    expect(mid).toBeGreaterThan(0.25);
    expect(mid).toBeLessThan(0.50);
    expect(mid).toBeCloseTo(0.375, 5);
  });

  it('caps at 1.0 for very large values', () => {
    const big = valueToPercentile(1000, bp);
    expect(big).toBeLessThanOrEqual(1.0);
  });

  it('is monotonically increasing', () => {
    const vals = [0, 0.5, 1, 1.5, 2, 2.5, 3, 4, 5, 10];
    const pcts = vals.map((v) => valueToPercentile(v, bp));
    for (let i = 1; i < pcts.length; i++) {
      expect(pcts[i]).toBeGreaterThanOrEqual(pcts[i - 1]!);
    }
  });
});

// ── baseline.ts tests ────────────────────────────────────────────────────────

const makeFakeBaseline = (): signalBaseline => ({
  schemaVersion: '1',
  computedAt: 1000000,
  sampleSize: 100,
  features: {
    foo: { p25: 1, p50: 2, p70: 3, p85: 4, p95: 5 },
    bar: { p25: 10, p50: 20, p70: 30, p85: 40, p95: 50 },
  },
});

describe('calibrate', () => {
  it('returns 0 composite when no features match baseline', () => {
    const result = calibrate({ unknown: 99 }, makeFakeBaseline(), makeFakeBaseline());
    expect(result.composite01).toBe(0);
  });

  it('uses default when baseline is null', () => {
    const defaults = makeFakeBaseline();
    const r1 = calibrate({ foo: 3 }, null, defaults);
    const r2 = calibrate({ foo: 3 }, defaults, defaults);
    expect(r1.composite01).toBeCloseTo(r2.composite01, 5);
  });

  it('uses default when schema version mismatches', () => {
    const stale: signalBaseline = { ...makeFakeBaseline(), schemaVersion: '0' };
    const defaults = makeFakeBaseline();
    const r = calibrate({ foo: 3 }, stale, defaults);
    // should behave like null baseline
    const r2 = calibrate({ foo: 3 }, null, defaults);
    expect(r.composite01).toBeCloseTo(r2.composite01, 5);
  });

  it('produces composite as mean of per-feature scores', () => {
    // foo=2 → p50=0.50, bar=20 → p50=0.50
    const r = calibrate({ foo: 2, bar: 20 }, makeFakeBaseline(), makeFakeBaseline());
    expect(r.composite01).toBeCloseTo(0.50, 3);
    expect(r.perFeature01['foo']).toBeCloseTo(0.50, 3);
    expect(r.perFeature01['bar']).toBeCloseTo(0.50, 3);
  });
});

describe('discretise', () => {
  it('maps 0..1 to 0..5 for maxScore=5', () => {
    expect(discretise(0.0, 5, 'clown')).toBe(0);
    expect(discretise(0.19, 5, 'clown')).toBe(0);
    expect(discretise(0.20, 5, 'clown')).toBe(1);
    expect(discretise(0.40, 5, 'clown')).toBe(2);
    expect(discretise(0.60, 5, 'clown')).toBe(3);
    expect(discretise(0.80, 5, 'clown')).toBe(4);
    expect(discretise(1.00, 5, 'clown')).toBe(5);
  });

  it('maps 0..1 to 0..3 for maxScore=3', () => {
    expect(discretise(0.0, 3, 'slop')).toBe(0);
    expect(discretise(0.33, 3, 'slop')).toBe(1);
    expect(discretise(0.66, 3, 'slop')).toBe(2);
    expect(discretise(0.85, 3, 'slop')).toBe(3);
  });

  it('clamps tea to min 1', () => {
    expect(discretise(0.0, 5, 'tea')).toBe(1);
    expect(discretise(0.19, 5, 'tea')).toBe(1);
  });

  it('allows 0 for non-tea signals', () => {
    expect(discretise(0.0, 3, 'slop')).toBe(0);
  });
});

describe('computeBaseline', () => {
  it('returns null when samples are below minimum', () => {
    const samples = { foo: [1, 2, 3] };
    expect(computeBaseline(samples, 50)).toBeNull();
  });

  it('returns null for empty samples object', () => {
    expect(computeBaseline({}, 50)).toBeNull();
  });

  it('builds a valid baseline when samples meet minimum', () => {
    const vals = Array.from({ length: 100 }, () => Math.random() * 10);
    const result = computeBaseline({ foo: vals }, 50);
    expect(result).not.toBeNull();
    expect(result!.schemaVersion).toBe('1');
    expect(result!.sampleSize).toBe(100);
    expect(result!.features['foo']).toBeDefined();
  });

  it('returns null if any feature is below minimum even if others are ok', () => {
    const big = Array.from({ length: 100 }, () => 1);
    const small = [1, 2, 3];
    expect(computeBaseline({ big, small }, 50)).toBeNull();
  });
});
