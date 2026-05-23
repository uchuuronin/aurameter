/**
 * Slop 🤖 : synthetic-text likelihood (0 to 3 robots).
 *
 * 10 stylometric features into a logistic regression. The coefficients in this
 * file are PLACEHOLDER weights based on prior research findings; Day 6–7 of the
 * build sprint replaces them with weights fit on a labelled corpus of 200 real
 * pre-2022 AITAH posts + 200 LLM-generated posts.
 *
 * Frame the public surface as "synthetic-text likelihood", never as a verdict.
 * Per Pangram Labs (2025): perplexity and burstiness alone fail on canonical
 * human writing; combining 6 to 10 features is the practical floor. Cite this
 * in the README.
 *
 * Processing budget: ~25 ms per post : the heaviest extractor.
 *
 * Hard cap: skip Slop scoring entirely if body length > 5000 chars (return 0).
 * Long posts are usually genuine multi-paragraph stories and the false-positive
 * cost is too high.
 */

import type { PostInput, SignalExtractor, SignalResult } from './types.js';
import type { SubConfig } from '../config/types.js';
import {
  splitSentences,
  wordCount,
  countMatches,
  variance,
  typeTokenRatio,
  logistic,
  bucketScore,
} from '../lib/text.js';

const GPT_FINGERPRINT_PATTERN = /\b(delve|delv(ing|ed)|tapestry|navigate the complexities|in the realm of|it['']s important to note|on the other hand|moreover|furthermore|in conclusion|firstly|secondly|nuanced|paramount|underscore|underscores|leverag(e|ing|ed))\b/gi;

const HEDGE_PATTERN = /\b(might|perhaps|generally|tend(s)? to|often|usually|in some cases|it depends|to some extent|in many ways|relatively|somewhat|seemingly)\b/gi;

const PROFANITY_PATTERN = /\b(fuck|shit|damn|hell|ass(hole)?|bitch|crap|piss|bullshit)\w*\b/gi;

const EM_DASH_PATTERN = /:|–/g;
const OXFORD_COMMA_PATTERN = /,\s+(?:and|or)\s+/g;
const QUESTION_PATTERN = /\?/g;

const MAX_BODY_CHARS = 5000;

/**
 * Placeholder logistic-regression coefficients. Replace with fitted values
 * after labelling 400 posts on Day 6.
 *
 * Sign convention: positive coefficient means feature increases synthetic probability.
 * Negative coefficient means feature is more human-like.
 */
const SLOP_WEIGHTS = {
  bias: -1.2,
  // Low variance = more synthetic. We negate variance so high-variance humans get a negative contribution.
  invSentenceLengthVariance: 0.8,
  // GPT fingerprints are the strongest single signal.
  fingerprintRate: 1.5,
  // Hedge density is medium-strength.
  hedgeRate: 0.9,
  // Em-dash rate per 100 words.
  emDashRate: 0.4,
  // Oxford comma rate per sentence.
  oxfordRate: 0.3,
  // Lower TTR (more repetition) is slightly synthetic-ish.
  invTypeTokenRatio: 0.5,
  // High opener diversity is HUMAN; we negate to penalise low diversity.
  invOpenerDiversity: 0.6,
  // Fewer questions = more synthetic (LLMs declare more than they ask).
  invQuestionRate: 0.4,
  // Profanity is HUMAN. Negative coefficient → presence of profanity reduces slop score.
  profanityRate: -1.0,
} as const;

/** First-word diversity: 1 - (top-word frequency / total sentences). */
function sentenceOpenerDiversity(sentences: string[]): number {
  if (sentences.length < 3) return 1; // not enough data to score
  const openers = sentences.map((s) => {
    const firstWord = s.trim().split(/\s+/)[0] ?? '';
    return firstWord.toLowerCase();
  });
  const counts = new Map<string, number>();
  for (const w of openers) {
    counts.set(w, (counts.get(w) ?? 0) + 1);
  }
  const max = Math.max(...counts.values());
  return 1 - max / sentences.length;
}

export const slopExtractor: SignalExtractor = {
  name: 'slop',
  emoji: '🤖',
  maxScore: 3,

  extract(post: PostInput, _subConfig: SubConfig): SignalResult {
    const body = post.body;

    // Hard cap: skip extremely long posts to keep false positives down.
    if (body.length > MAX_BODY_CHARS) {
      return {
        score: 0,
        reasons: ['Post too long for synthetic-text scoring (>5000 chars)'],
        confidence: 'low',
        rawFeatures: { skipped: 1 },
      };
    }

    const sentences = splitSentences(body);
    const words = wordCount(body);
    if (words < 30 || sentences.length < 2) {
      return {
        score: 0,
        reasons: ['Post too short for reliable synthetic-text scoring'],
        confidence: 'low',
        rawFeatures: { skipped: 1, words, sentenceCount: sentences.length },
      };
    }

    // Feature extraction.
    const sentenceLengths = sentences.map((s) => wordCount(s));
    const sentLenVariance = variance(sentenceLengths);
    // Inverse: low variance → high feature value.
    const invSentLenVar = 1 / (1 + sentLenVariance / 50);

    const fingerprintHits = countMatches(body, GPT_FINGERPRINT_PATTERN);
    const fingerprintRate = (fingerprintHits / words) * 100;

    const hedgeHits = countMatches(body, HEDGE_PATTERN);
    const hedgeRate = (hedgeHits / words) * 100;

    const emDashHits = countMatches(body, EM_DASH_PATTERN);
    const emDashRate = (emDashHits / words) * 100;

    const oxfordHits = countMatches(body, OXFORD_COMMA_PATTERN);
    const oxfordRate = oxfordHits / sentences.length;

    const ttr = typeTokenRatio(body);
    const invTtr = 1 - ttr;

    const openerDiversity = sentenceOpenerDiversity(sentences);
    const invOpenerDiv = 1 - openerDiversity;

    const questionHits = countMatches(body, QUESTION_PATTERN);
    const questionRate = (questionHits / sentences.length);
    const invQuestionRate = 1 / (1 + questionRate * 5);

    const profanityHits = countMatches(body, PROFANITY_PATTERN);
    const profanityRate = (profanityHits / words) * 100;

    // Logistic regression score.
    const linear =
      SLOP_WEIGHTS.bias +
      SLOP_WEIGHTS.invSentenceLengthVariance * invSentLenVar +
      SLOP_WEIGHTS.fingerprintRate * fingerprintRate +
      SLOP_WEIGHTS.hedgeRate * hedgeRate +
      SLOP_WEIGHTS.emDashRate * emDashRate +
      SLOP_WEIGHTS.oxfordRate * oxfordRate +
      SLOP_WEIGHTS.invTypeTokenRatio * invTtr +
      SLOP_WEIGHTS.invOpenerDiversity * invOpenerDiv +
      SLOP_WEIGHTS.invQuestionRate * invQuestionRate +
      SLOP_WEIGHTS.profanityRate * profanityRate;

    const probability = logistic(linear);

    // Threshold breakpoints for 0–3 mapping.
    const score = bucketScore(probability, [0.5, 0.7, 0.85]);

    // Reason chips.
    const reasons: string[] = [];
    if (fingerprintHits >= 3) {
      reasons.push(`${fingerprintHits} GPT-style phrases ("delve", "nuanced", etc.)`);
    }
    if (sentLenVariance < 20) {
      reasons.push(`Low sentence-length variance (${sentLenVariance.toFixed(1)})`);
    }
    if (hedgeRate > 2) {
      reasons.push(`High hedge phrase density (${hedgeRate.toFixed(1)}%)`);
    }
    if (invOpenerDiv > 0.5) {
      reasons.push('Low sentence-opener diversity');
    }
    if (profanityHits === 0 && words > 200) {
      reasons.push('No profanity in a long post (mild signal)');
    }

    let confidence: 'low' | 'medium' | 'high';
    if (fingerprintHits >= 3 && sentLenVariance < 20) confidence = 'high';
    else if (reasons.length >= 2) confidence = 'medium';
    else confidence = 'low';

    return {
      score,
      reasons: reasons.slice(0, 5),
      confidence,
      rawFeatures: {
        sentenceCount: sentences.length,
        wordCount: words,
        sentLenVariance,
        fingerprintHits,
        fingerprintRate,
        hedgeRate,
        emDashRate,
        oxfordRate,
        ttr,
        openerDiversity,
        questionRate,
        profanityRate,
        probability,
      },
    };
  },
};
