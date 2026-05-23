/**
 * default baselines.
 *
 * these are the fallback percentile breakpoints used when a sub has no learned
 * baseline yet (redis empty, sample size below minimum, or schema mismatch).
 *
 * values were eyeballed from the feature distributions implied by the extractor
 * code. they should be replaced by corpus-derived values after day 6.
 *
 * shape must exactly match signalBaseline. extractors are unaware of whether
 * their baseline is learned or default.
 */

import type { signalBaseline } from './baseline.js';

export const defaultBaselines: Record<string, signalBaseline> = {
  tea: {
    schemaVersion: '1',
    computedAt: 0,
    sampleSize: 0,
    features: {
      stakesDensity: { p25: 0.0, p50: 0.4, p70: 1.1, p85: 2.3, p95: 4.0 },
      castMatches:   { p25: 0.0, p50: 1.0, p70: 3.0, p85: 5.0, p95: 8.0 },
      conflictDensity: { p25: 0.0, p50: 0.3, p70: 0.8, p85: 1.5, p95: 2.5 },
      cliffhanger:   { p25: 0.0, p50: 0.0, p70: 1.0, p85: 1.0, p95: 1.0 },
      titleHook:     { p25: 0.0, p50: 0.0, p70: 1.0, p85: 1.0, p95: 1.0 },
    },
  },

  time: {
    schemaVersion: '1',
    computedAt: 0,
    sampleSize: 0,
    features: {
      futureMatches:  { p25: 0.0, p50: 0.0, p70: 1.0, p85: 2.0, p95: 4.0 },
      crisisMatches:  { p25: 0.0, p50: 0.0, p70: 1.0, p85: 2.0, p95: 3.0 },
      deadlineMatches:{ p25: 0.0, p50: 0.0, p70: 1.0, p85: 2.0, p95: 3.0 },
    },
  },

  clown: {
    schemaVersion: '1',
    computedAt: 0,
    sampleSize: 0,
    features: {
      asymmetryHits:  { p25: 0.0, p50: 0.0, p70: 1.0, p85: 2.0, p95: 4.0 },
      justifyMatches: { p25: 0.0, p50: 0.0, p70: 1.0, p85: 2.0, p95: 4.0 },
      enumerationCount:{ p25: 0.0, p50: 1.0, p70: 3.0, p85: 6.0, p95: 10.0 },
      strawmanMatches:{ p25: 0.0, p50: 0.0, p70: 0.0, p85: 1.0, p95: 2.0 },
    },
  },

  slop: {
    schemaVersion: '1',
    computedAt: 0,
    sampleSize: 0,
    features: {
      fingerprintHits:  { p25: 0.0, p50: 0.0, p70: 1.0, p85: 3.0, p95: 6.0 },
      sentLenVariance:  { p25: 5.0, p50: 20.0, p70: 50.0, p85: 100.0, p95: 200.0 },
      hedgeRate:        { p25: 0.0, p50: 0.5, p70: 1.5, p85: 3.0, p95: 5.0 },
      openerDiversity:  { p25: 0.5, p50: 0.7, p70: 0.85, p85: 0.95, p95: 1.0 },
      probability:      { p25: 0.1, p50: 0.3, p70: 0.5, p85: 0.7, p95: 0.9 },
    },
  },
};
