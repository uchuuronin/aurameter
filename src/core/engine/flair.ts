/**
 * Flair composition.
 *
 * Turn SignalResults into the emoji flair string that gets set on the post.
 * Respects per-signal visibility (public vs mod-only): only `public` signals
 * appear in the flair.
 *
 * Reddit's hard limit is 10 emoji per flair. Worst case is
 *  ☕☕☕☕☕ ⏰⏰⏰ 🤡🤡🤡 🤖🤖🤖 = 14 emoji.
 * Drop order when over budget: third 🤖, third 🤡, third ⏰, fifth ☕, fourth ☕.
 */

import type { SubConfig } from '../config/types.js';
import type { SignalResults } from './score.js';
import { ALL_EXTRACTORS, effectiveEmoji } from './score.js';

const MAX_EMOJI = 10;

/**
 * Drop priority: when over budget, remove these in order until we fit.
 * Format: [signal-name, score-to-drop]. We drop the Nth emoji of that signal,
 * not the whole signal.
 */
const DROP_ORDER: ReadonlyArray<readonly [string, number]> = [
  ['slop', 3],
  ['clown', 3],
  ['time', 3],
  ['tea', 5],
  ['tea', 4],
] as const;

/**
 * Build the flair string from results + config.
 * Returns empty string if no signals are public (mod team has everything mod-only).
 */
export function composeFlair(results: SignalResults, subConfig: SubConfig): string {
  const counts: Record<string, number> = {};

  for (const extractor of ALL_EXTRACTORS) {
    const cfg = subConfig.signals[extractor.name];
    if (cfg.visibility !== 'public') {
      counts[extractor.name] = 0;
      continue;
    }
    counts[extractor.name] = results[extractor.name].score;
  }

  // Apply drop rules until total ≤ MAX_EMOJI.
  let total = Object.values(counts).reduce((a, b) => a + b, 0);
  for (const [signal, targetCount] of DROP_ORDER) {
    if (total <= MAX_EMOJI) break;
    if (counts[signal] !== undefined && counts[signal] >= targetCount) {
      counts[signal]!--;
      total--;
    }
  }

  // Build emoji string in canonical order: Tea, Time, Clown, Slop.
  // Use per-sub emoji override if set, else the extractor default.
  const parts: string[] = [];
  for (const extractor of ALL_EXTRACTORS) {
    const c = counts[extractor.name] ?? 0;
    if (c > 0) {
      parts.push(effectiveEmoji(extractor, subConfig).repeat(c));
    }
  }
  return parts.join(' ');
}

/**
 * Build a mod-only summary string (all signals visible regardless of visibility).
 * Uses per-sub emoji overrides if set. Used in the dashboard per-post drilldown.
 */
export function composeModSummary(results: SignalResults, subConfig: SubConfig): string {
  const parts: string[] = [];
  for (const extractor of ALL_EXTRACTORS) {
    const score = results[extractor.name].score;
    if (score > 0) {
      parts.push(effectiveEmoji(extractor, subConfig).repeat(score));
    }
  }
  return parts.join(' ') || '(no signals fired)';
}
