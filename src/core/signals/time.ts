/**
 * Time ⏰ : urgency (0 to 3 clocks).
 *
 * Four features: future-time anchors, crisis-now markers, calendar-deadline
 * words, and past-anchored suppressors. Past markers SUBTRACT from the score,
 * not just fail to add to it. This is what makes the "story from 2019" case
 * correctly score 0 even if the body has plenty of stakes.
 *
 * Score 0 means the ⏰ is omitted from the flair entirely. Never display 0 clocks.
 *
 * Processing budget: ~5 ms per post.
 */

import type { PostInput, SignalExtractor, SignalResult } from './types.js';
import type { SubConfig } from '../config/types.js';
import { countMatches } from '../lib/text.js';

const FUTURE_TIME_PATTERN = /\b(tomorrow|tonight|this (weekend|morning|evening|afternoon|saturday|sunday|monday|tuesday|wednesday|thursday|friday)|in \d+ (hours?|minutes?|days?|weeks?)|next (monday|tuesday|wednesday|thursday|friday|saturday|sunday|weekend|week|month))\b/gi;

const CRISIS_NOW_PATTERN = /\b(is happening|happening right now|just walked out|just told me|currently sitting|am sitting (here|in)|literally just|right (now|this minute)|as we speak)\b/gi;

const DEADLINE_PATTERN = /\b(court date|deadline|hearing|surgery|funeral|wedding day|closing( date)?|move[ -]?out|due date|moving day|signing)\b/gi;

const PAST_SUPPRESSOR_PATTERN = /\b(years ago|when i was (a kid|younger|in (school|college|high school))|throwback|repost|update from 20[01]\d|back in 20[01]\d|long ago|a while back)\b/gi;

export const timeExtractor: SignalExtractor = {
  name: 'time',
  emoji: '⏰',
  maxScore: 3,

  extract(post: PostInput, _subConfig: SubConfig): SignalResult {
    const body = post.body;
    const title = post.title;
    const combined = `${title} ${body}`;
    const reasons: string[] = [];

    const futureMatches = countMatches(combined, FUTURE_TIME_PATTERN);
    const crisisMatches = countMatches(combined, CRISIS_NOW_PATTERN);
    const deadlineMatches = countMatches(combined, DEADLINE_PATTERN);
    const pastMatches = countMatches(combined, PAST_SUPPRESSOR_PATTERN);

    // Capture sample matches for the reason chips.
    if (crisisMatches > 0) {
      reasons.push(`Present-tense crisis markers (${crisisMatches})`);
    }
    if (deadlineMatches > 0) {
      reasons.push(`Calendar-deadline language (${deadlineMatches})`);
    }
    if (futureMatches > 0) {
      reasons.push(`Future time anchors (${futureMatches})`);
    }
    if (pastMatches > 0) {
      reasons.push(`Past-tense markers (${pastMatches}) : urgency suppressed`);
    }

    // Weighted sum. Crisis-now matters most (within 24h); deadlines next;
    // future anchors weakest. Past markers subtract aggressively.
    const raw =
      crisisMatches * 3 +
      deadlineMatches * 2 +
      futureMatches * 1 -
      pastMatches * 3;

    let score: number;
    if (raw <= 0) score = 0;
    else if (raw <= 2) score = 1;
    else if (raw <= 4) score = 2;
    else score = 3;

    // Confidence: low if only future anchors fire, high if crisis + deadline both fire.
    let confidence: 'low' | 'medium' | 'high';
    if (crisisMatches > 0 && deadlineMatches > 0) confidence = 'high';
    else if (crisisMatches > 0 || deadlineMatches > 0) confidence = 'medium';
    else confidence = 'low';

    return {
      score,
      reasons: reasons.slice(0, 5),
      confidence,
      rawFeatures: {
        futureMatches,
        crisisMatches,
        deadlineMatches,
        pastMatches,
        rawSum: raw,
      },
    };
  },
};
