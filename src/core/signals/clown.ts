/**
 * Clown 🤡 : one-sided framing (0 to 5 clowns).
 *
 * The trickiest signal both technically and socially. Conservative thresholds:
 * defaults to 0 unless multiple features fire.
 *
 * Mod-only by default in all presets except `drama` (where mods explicitly opt-in).
 * Public Clown scores are harassment-adjacent; the README must say this.
 *
 * Processing budget: ~15 ms per post : the slowest extractor because the
 * adjective-valence-asymmetry feature requires windowed lookups.
 */

import type { PostInput, SignalExtractor, SignalResult } from './types.js';
import type { SubConfig } from '../config/types.js';
import { countMatches } from '../lib/text.js';

const NEGATIVE_ADJECTIVES = [
  'toxic', 'crazy', 'insane', 'nasty', 'psycho', 'narcissistic', 'controlling',
  'abusive', 'manipulative', 'gaslighting', 'unhinged', 'horrible', 'evil',
  'vile', 'awful', 'terrible', 'monstrous',
];

const OTHER_PRONOUN_PATTERN = /\b(she|he|they|my (mom|mil|sil|bil|fil|mother-in-law|father-in-law|sister-in-law|brother-in-law|dad|father|sister|brother|husband|wife|boyfriend|girlfriend|partner|ex))\b/gi;

const SELF_JUSTIFICATION_PATTERN = /\b(i had every right|anyone would have|obviously|clearly|it['']s not like|in my defen[cs]e|i (was )?just|i only|i merely|to be fair to me|the truth is)\b/gi;

const MISSING_REASONS_OPENER = /\b((i have )?no (idea|clue)|don['']t (know|understand)) why (she|he|they|my)\b/i;

// Enumeration markers that suggest OP IS listing the obvious reasons.
const ENUMERATION_MARKERS_PATTERN = /(\n\s*[-*•]|\n\s*\d+[.)]|;|\balso\b|\band then\b|\bfurthermore\b|\bon top of that\b)/gi;

const STRAWMAN_PATTERN = /(she|he|they) said ['""][^'""]{10,80}['""].*?\b(monster|horrible person|terrible person|the worst|evil)\b/gi;

/**
 * Adjective-valence asymmetry feature.
 *
 * Look at every occurrence of a negative adjective and check if it appears
 * within 10 words after a pronoun pointing at "the other party". This is a
 * cheap proxy for "OP is calling the other party names" without needing a
 * full dependency parser.
 *
 * Returns a number in [0, 1] roughly proportional to how lopsided the
 * adjective placement is.
 */
function adjectiveValenceAsymmetry(text: string): { score: number; hits: number } {
  const lower = text.toLowerCase();
  let hitsNearOther = 0;

  for (const adj of NEGATIVE_ADJECTIVES) {
    const adjRegex = new RegExp(`\\b${adj}\\b`, 'gi');
    let match: RegExpExecArray | null;
    while ((match = adjRegex.exec(lower)) !== null) {
      // Look at the 80 characters before the adjective for an "other-party" pronoun.
      const start = Math.max(0, match.index - 80);
      const window = lower.slice(start, match.index);
      if (OTHER_PRONOUN_PATTERN.test(window)) {
        hitsNearOther++;
      }
      OTHER_PRONOUN_PATTERN.lastIndex = 0;
    }
  }

  // Normalise: 3+ negative adjectives near other-party = max.
  return { score: Math.min(hitsNearOther / 3, 1), hits: hitsNearOther };
}

export const clownExtractor: SignalExtractor = {
  name: 'clown',
  emoji: '🤡',
  maxScore: 5,

  extract(post: PostInput, _subConfig: SubConfig): SignalResult {
    const body = post.body;
    const reasons: string[] = [];

    // 1. Adjective valence asymmetry.
    const { score: asymmetryScore, hits: asymmetryHits } = adjectiveValenceAsymmetry(body);
    if (asymmetryHits >= 2) {
      reasons.push(`Negative adjectives clustered on other party (${asymmetryHits} hits)`);
    }

    // 2. Self-justification.
    const justifyMatches = countMatches(body, SELF_JUSTIFICATION_PATTERN);
    const justifyScore = Math.min(justifyMatches / 3, 1);
    if (justifyMatches >= 2) {
      reasons.push(`Self-justification phrases (${justifyMatches})`);
    }

    // 3. Missing-missing-reasons: requires BOTH conditions.
    const hasMissingOpener = MISSING_REASONS_OPENER.test(body);
    const enumerationCount = countMatches(body, ENUMERATION_MARKERS_PATTERN);
    const missingReasons = hasMissingOpener && enumerationCount >= 2;
    if (missingReasons) {
      reasons.push('Missing-missing-reasons pattern: claims unknown cause + enumerates obvious causes');
    }
    const missingScore = missingReasons ? 1 : 0;

    // 4. Strawman markers.
    const strawmanMatches = countMatches(body, STRAWMAN_PATTERN);
    const strawmanScore = strawmanMatches > 0 ? 1 : 0;
    if (strawmanMatches > 0) {
      reasons.push(`Strawman paraphrase patterns (${strawmanMatches})`);
    }

    // Composite. Missing-reasons gets the heaviest weight because it's the
    // highest-precision tell.
    const composite =
      asymmetryScore * 0.30 +
      justifyScore * 0.20 +
      missingScore * 0.35 +
      strawmanScore * 0.15;

    // Conservative mapping onto 0–5. Require at least 2 features firing to score
    // above 1; lean on the composite to reach the top of the scale.
    const firingFeatures = [
      asymmetryHits >= 2,
      justifyMatches >= 2,
      missingReasons,
      strawmanMatches > 0,
    ].filter(Boolean).length;

    let score: number;
    if (firingFeatures === 0) score = 0;
    else if (firingFeatures === 1 && composite < 0.30) score = 0;
    else if (firingFeatures === 1) score = 1;
    else if (firingFeatures === 2) score = composite >= 0.55 ? 3 : 2;
    else if (firingFeatures === 3) score = composite >= 0.70 ? 5 : 4;
    else score = 5;

    let confidence: 'low' | 'medium' | 'high';
    if (missingReasons || firingFeatures >= 3) confidence = 'high';
    else if (firingFeatures >= 2) confidence = 'medium';
    else confidence = 'low';

    return {
      score,
      reasons: reasons.slice(0, 5),
      confidence,
      rawFeatures: {
        asymmetryHits,
        justifyMatches,
        hasMissingOpener: hasMissingOpener ? 1 : 0,
        enumerationCount,
        strawmanMatches,
        firingFeatures,
        composite,
      },
    };
  },
};
