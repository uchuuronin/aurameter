/**
 * score engine: run the four extractors against a post and return results.
 *
 * calibration is the only scoring path. extractors return raw features;
 * this module converts them to 0..1 via percentile baseline, then discretises.
 * the fallback for an empty/missing baseline is the hardcoded default in
 * calibration/defaults.ts — same shape, same code path.
 *
 * no redis, no reddit api. caller is responsible for i/o.
 */

import type { PostInput, SignalExtractor, SignalName, SignalResult } from '../signals/types.js';
import type { SubConfig } from '../config/types.js';
import type { signalBaseline } from '../calibration/baseline.js';
import { teaExtractor } from '../signals/tea.js';
import { timeExtractor } from '../signals/time.js';
import { clownExtractor } from '../signals/clown.js';
import { slopExtractor } from '../signals/slop.js';
import { calibrate, discretise } from '../calibration/baseline.js';
import { defaultBaselines } from '../calibration/defaults.js';

export const allExtractors: readonly SignalExtractor[] = [
  teaExtractor,
  timeExtractor,
  clownExtractor,
  slopExtractor,
] as const;

// keep the old export name as an alias so existing imports don't break
export { allExtractors as ALL_EXTRACTORS };

export type SignalResults = Record<SignalName, SignalResult>;

const zeroResult: SignalResult = {
  score: 0,
  reasons: [],
  confidence: 'low',
  rawFeatures: {},
};

/**
 * run all extractors that are not configured `off`.
 *
 * baselines is the map loaded from redis (one read per post).
 * if a baseline is null the default is used transparently.
 */
export function scorePost(
  post: PostInput,
  subConfig: SubConfig,
  baselines: Record<SignalName, signalBaseline | null>
): SignalResults {
  const results = {} as SignalResults;

  for (const extractor of allExtractors) {
    const signalConfig = subConfig.signals[extractor.name];
    if (signalConfig.visibility === 'off') {
      results[extractor.name] = zeroResult;
      continue;
    }

    // 1. extract raw features (pure, sync, fast)
    const raw = extractor.extract(post, subConfig);

    // 2. calibrate: raw features → 0..1 composite via percentile baseline
    const baseline = baselines[extractor.name];
    const defaults = defaultBaselines[extractor.name] ?? null;
    if (!defaults) {
      // should never happen — every signal has a default
      results[extractor.name] = raw;
      continue;
    }

    const calibrated = calibrate(raw.rawFeatures, baseline, defaults);

    // 3. discretise: 0..1 → integer score
    const score = discretise(calibrated.composite01, extractor.maxScore, extractor.name);

    results[extractor.name] = {
      ...raw,
      score,
      rawFeatures: {
        ...raw.rawFeatures,
        _composite01: calibrated.composite01,
      },
    };
  }

  return results;
}

/**
 * resolve the effective emoji for a signal.
 */
export function effectiveEmoji(extractor: SignalExtractor, subConfig: SubConfig): string {
  return subConfig.signals[extractor.name].emoji ?? extractor.emoji;
}

/**
 * resolve the effective maximum score for a signal, clamped to [1, 5].
 */
export function effectiveMaxScore(extractor: SignalExtractor, subConfig: SubConfig): number {
  const override = subConfig.signals[extractor.name].maxScore;
  const max = override ?? extractor.maxScore;
  return Math.max(1, Math.min(5, max));
}

/**
 * apply per-sub aggressiveness shift to already-calibrated results.
 * conservative: -1. aggressive: +1.
 * tea minimum stays at 1.
 */
export function applyAggressiveness(
  results: SignalResults,
  subConfig: SubConfig
): SignalResults {
  const shift =
    subConfig.aggressiveness === 'conservative' ? -1 :
    subConfig.aggressiveness === 'aggressive'   ?  1 :
    0;

  const adjusted = {} as SignalResults;
  for (const extractor of allExtractors) {
    const original = results[extractor.name];
    const effectiveMax = effectiveMaxScore(extractor, subConfig);
    const isTea = extractor.name === 'tea';
    const minScore = isTea ? 1 : 0;

    const shifted = Math.max(minScore, Math.min(extractor.maxScore, original.score + shift));
    const final = Math.max(minScore, Math.min(effectiveMax, shifted));

    adjusted[extractor.name] = { ...original, score: final };
  }
  return adjusted;
}
