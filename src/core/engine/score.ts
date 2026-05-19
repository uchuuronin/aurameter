/**
 * Score engine: run the four extractors against a post and return the results.
 *
 * Pure function : no I/O, no Redis, no Reddit API. Caller (the trigger handler
 * in routes/triggers.ts) is responsible for persisting the results and acting on them.
 */

import type { PostInput, SignalExtractor, SignalName, SignalResult } from '../signals/types.js';
import type { SubConfig } from '../config/types.js';
import { teaExtractor } from '../signals/tea.js';
import { timeExtractor } from '../signals/time.js';
import { clownExtractor } from '../signals/clown.js';
import { slopExtractor } from '../signals/slop.js';

/** All extractors in stable declaration order. Tea first because it's the default-public signal. */
export const ALL_EXTRACTORS: readonly SignalExtractor[] = [
  teaExtractor,
  timeExtractor,
  clownExtractor,
  slopExtractor,
] as const;

export type SignalResults = Record<SignalName, SignalResult>;

/**
 * Empty SignalResult, used when a signal is configured `off`.
 * Storing zeroes makes downstream rule evaluation cleaner: rules can always
 * reference a signal score without null-checking visibility.
 */
const ZERO_RESULT: SignalResult = {
  score: 0,
  reasons: [],
  confidence: 'low',
  rawFeatures: {},
};

/**
 * Run all extractors that are not configured `off`. Returns results keyed by
 * signal name. Off signals get a zero-result placeholder.
 */
export function scorePost(post: PostInput, subConfig: SubConfig): SignalResults {
  const results = {} as SignalResults;

  for (const extractor of ALL_EXTRACTORS) {
    const signalConfig = subConfig.signals[extractor.name];
    if (signalConfig.visibility === 'off') {
      results[extractor.name] = ZERO_RESULT;
      continue;
    }
    results[extractor.name] = extractor.extract(post, subConfig);
  }

  return results;
}

/**
 * Resolve the effective emoji for a signal : config override if set, else extractor default.
 * Surgical helper so flair composition and dashboard rendering pull from one source.
 */
export function effectiveEmoji(extractor: SignalExtractor, subConfig: SubConfig): string {
  return subConfig.signals[extractor.name].emoji ?? extractor.emoji;
}

/**
 * Resolve the effective maximum score for a signal : config override if set, else extractor default.
 * Clamped to [1, 5] regardless of what the config says.
 */
export function effectiveMaxScore(extractor: SignalExtractor, subConfig: SubConfig): number {
  const override = subConfig.signals[extractor.name].maxScore;
  const max = override ?? extractor.maxScore;
  return Math.max(1, Math.min(5, max));
}

/**
 * Rescale a 0..defaultMax score onto a 0..effectiveMax range.
 * Tea floor stays at 1 (universal indicator); others can go to 0.
 */
function rescaleScore(
  rawScore: number,
  defaultMax: number,
  effectiveMax: number,
  isTeaSignal: boolean
): number {
  if (defaultMax === effectiveMax) return rawScore;
  const minScore = isTeaSignal ? 1 : 0;
  const proportional = (rawScore / defaultMax) * effectiveMax;
  return Math.max(minScore, Math.min(effectiveMax, Math.round(proportional)));
}

/**
 * Apply per-sub aggressiveness scaling AND per-sub maxScore overrides to results.
 *
 * Conservative: shift scores down by 1. Aggressive: shift up by 1.
 * Then rescale onto the per-sub effective max for each signal.
 *
 * Tea's minimum stays at 1 (so flair always renders); other signals can go to 0.
 */
export function applyAggressiveness(
  results: SignalResults,
  subConfig: SubConfig
): SignalResults {
  const shift = subConfig.aggressiveness === 'conservative'
    ? -1
    : subConfig.aggressiveness === 'aggressive'
      ? 1
      : 0;

  const adjusted = {} as SignalResults;
  for (const extractor of ALL_EXTRACTORS) {
    const original = results[extractor.name];
    const effectiveMax = effectiveMaxScore(extractor, subConfig);
    const isTea = extractor.name === 'tea';
    const minScore = isTea ? 1 : 0;

    // Aggressiveness shift first, clamped to default range.
    const shifted = Math.max(
      minScore,
      Math.min(extractor.maxScore, original.score + shift)
    );

    // Then rescale onto the effective max.
    const final = rescaleScore(shifted, extractor.maxScore, effectiveMax, isTea);

    adjusted[extractor.name] = { ...original, score: final };
  }
  return adjusted;
}
