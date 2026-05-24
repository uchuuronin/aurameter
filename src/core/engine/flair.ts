/**
 * Flair composition.
 *
 * Turn SignalResults into the flair string that gets set on the post.
 * Each public signal renders as a single emoji followed by its score digit,
 * e.g. "☕4 ⏰2 🤖3". Signals scoring 0 are omitted.
 *
 * Respects per-signal visibility (public vs mod-only): only `public` signals
 * appear in the flair.
 *
 * Cap-safety: the old emoji-repetition scheme could hit Reddit's 10-emoji
 * limit (worst case 5+3+3+3 = 14 emoji). The digit-suffix scheme uses at most
 * one emoji per signal (4 total) plus single-digit numbers, so it is always
 * well under both the 10-emoji and 64-character flair limits — no drop logic
 * is needed.
 */

import type { SubConfig } from '../config/types.js';
import type { SignalResults } from './score.js';
import { ALL_EXTRACTORS, effectiveEmoji } from './score.js';

/**
 * Build the flair string from results + config.
 * Returns empty string if no signals are public (mod team has everything
 * mod-only) or every public signal scored 0.
 */
export function composeFlair(results: SignalResults, subConfig: SubConfig): string {
  const parts: string[] = [];

  // Canonical order: Tea, Time, Clown, Slop (ALL_EXTRACTORS order).
  for (const extractor of ALL_EXTRACTORS) {
    const cfg = subConfig.signals[extractor.name];
    if (cfg.visibility !== 'public') continue;

    const score = results[extractor.name].score;
    if (score > 0) {
      parts.push(`${effectiveEmoji(extractor, subConfig)}${score}`);
    }
  }

  return parts.join(' ');
}

/**
 * Build a mod-only summary string (all signals visible regardless of visibility).
 * Uses per-sub emoji overrides if set. Used in the dashboard per-post drilldown
 * and the "check vibe" toast.
 */
export function composeModSummary(results: SignalResults, subConfig: SubConfig): string {
  const parts: string[] = [];
  for (const extractor of ALL_EXTRACTORS) {
    const score = results[extractor.name].score;
    if (score > 0) {
      parts.push(`${effectiveEmoji(extractor, subConfig)}${score}`);
    }
  }
  return parts.join(' ') || '(no signals fired)';
}
