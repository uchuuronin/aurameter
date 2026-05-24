/**
 * baseline types and calibration.
 *
 * a signal baseline is the learned percentile model for one signal in one sub.
 * calibrate() converts raw feature values into a composite 0..1 score using
 * either the learned baseline or a hardcoded default fallback.
 *
 * calibration/ knows nothing about redis. storage is handled elsewhere.
 * the two layers meet only in engine/score.ts.
 */

import type { percentileBreakpoints } from './percentile.js';
import { valueToPercentile, computePercentiles } from './percentile.js';

export const schema_version = '1';

export interface signalBaseline {
  schemaVersion: string;
  computedAt: number;
  sampleSize: number;
  features: Record<string, percentileBreakpoints>;
}

export interface calibratedScore {
  /** composite 0..1, continuous */
  composite01: number;
  /** per-feature 0..1, for explainability in the debug endpoint */
  perFeature01: Record<string, number>;
}

/**
 * apply baseline percentile breakpoints to raw feature values.
 *
 * if baseline is null or its schemaVersion doesn't match, falls back to
 * the provided defaults. extractors never know which path was taken.
 */
export function calibrate(
  rawFeatures: Record<string, number>,
  baseline: signalBaseline | null,
  defaults: signalBaseline
): calibratedScore {
  const active =
    baseline !== null && baseline.schemaVersion === schema_version
      ? baseline
      : defaults;

  const perFeature01: Record<string, number> = {};
  let weightedSum = 0;
  let weightSum = 0;

  for (const [feature, value] of Object.entries(rawFeatures)) {
    const bp = active.features[feature];
    if (!bp) continue;
    const pct = valueToPercentile(value, bp);
    perFeature01[feature] = pct;
    // equal weighting across features that have a baseline entry
    weightedSum += pct;
    weightSum += 1;
  }

  const composite01 = weightSum > 0 ? weightedSum / weightSum : 0;

  return { composite01, perFeature01 };
}

/**
 * discretise a 0..1 composite score into an integer score for a given signal.
 *
 * For the canonical 0..5 and 0..3 scales we use hand-tuned thresholds:
 *   maxScore=5: [0.20, 0.40, 0.60, 0.80]
 *   maxScore=3: [0.33, 0.66, 0.85]
 * For any other maxScore (e.g. a per-sub override of 2 or 4) we fall back to
 * evenly-spaced thresholds so the full range is still reachable.
 *
 * All signals can score 0; there is no longer a per-signal minimum.
 */
export function discretise(
  composite01: number,
  maxScore: number,
  _signalName: string
): number {
  const thresholds =
    maxScore === 5
      ? [0.20, 0.40, 0.60, 0.80, 1.00]
      : maxScore === 3
        ? [0.33, 0.66, 0.85]
        : Array.from({ length: Math.max(0, maxScore) }, (_, i) => (i + 1) / (maxScore + 1));

  let score = 0;
  for (const t of thresholds) {
    if (composite01 >= t) score++;
    else break;
  }

  score = Math.min(score, maxScore);

  return score;
}

/**
 * build a baseline from arrays of sample values per feature.
 * returns null if any feature has fewer than the required minimum samples.
 */
export function computeBaseline(
  samples: Record<string, number[]>,
  minSamples = 50
): signalBaseline | null {
  const features: Record<string, percentileBreakpoints> = {};

  for (const [feature, values] of Object.entries(samples)) {
    if (values.length < minSamples) return null;
    const bp = computePercentiles(values);
    if (!bp) return null;
    features[feature] = bp;
  }

  if (Object.keys(features).length === 0) return null;

  return {
    schemaVersion: schema_version,
    computedAt: Date.now(),
    sampleSize: Math.min(...Object.values(samples).map((v) => v.length)),
    features,
  };
}
