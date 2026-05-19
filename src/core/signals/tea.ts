/**
 * Tea ☕ : drama intensity (1 to 5 cups).
 *
 * Five features, weighted sum, mapped to 1–5 via thresholds.
 * Minimum is 1 so every post gets at least one cup and the flair always renders.
 *
 * Processing budget: ~5 ms per post. Five regex passes plus one wordCount.
 */

import type { PostInput, SignalExtractor, SignalResult } from './types.js';
import type { SubConfig } from '../config/types.js';
import { countMatches, densityPer100Words } from '../lib/text.js';

const STAKES_PATTERN = /\b(wedding|divorce|funeral|inheritance|will|fired|police|court|custody|affair|cheating|pregnant|baby|engagement|breakup|estranged|disowned)\b/gi;

const CAST_PATTERN = /\b(my (mom|mother|mil|sil|bil|fil|dad|father|sister|brother|husband|wife|boyfriend|girlfriend|partner|son|daughter|aunt|uncle|cousin|stepmom|stepdad))\b/gi;

const CONFLICT_VERB_PATTERN = /\b(told|yelled|screamed|refused|kicked|threw|demanded|stormed|slammed|snapped|exploded|lost it)\b/gi;

const CLIFFHANGER_PATTERN = /\b(now what|don['']t know what to do|need advice|am i wrong|help|what should i do|losing my mind|at my wits|wits['' ]?end)\b/i;

const TITLE_HOOK_PATTERN = /^(aita(h)? for|my (mom|mil|dad|sister|brother|husband|wife|boyfriend|girlfriend) (did|said|wants|just)|i (told|refused|kicked)|update:|\[update\])/i;

export const teaExtractor: SignalExtractor = {
  name: 'tea',
  emoji: '☕',
  maxScore: 5,

  extract(post: PostInput, _subConfig: SubConfig): SignalResult {
    const body = post.body;
    const title = post.title;
    const reasons: string[] = [];

    // 1. Stakes density (per 100 words).
    const stakesDensity = densityPer100Words(body, STAKES_PATTERN);
    const stakesScore = Math.min(stakesDensity / 2, 1); // 2 per 100 words = max
    if (stakesScore > 0.5) {
      reasons.push(`Stakes vocabulary density: ${stakesDensity.toFixed(1)} per 100 words`);
    }

    // 2. Cast size.
    const castMatches = countMatches(body, CAST_PATTERN);
    const castScore = Math.min(castMatches / 4, 1); // 4+ named family = max
    if (castMatches >= 3) {
      reasons.push(`${castMatches} named family/relationship references`);
    }

    // 3. Conflict-verb density.
    const conflictDensity = densityPer100Words(body, CONFLICT_VERB_PATTERN);
    const conflictScore = Math.min(conflictDensity / 1.5, 1);
    if (conflictDensity > 0.5) {
      reasons.push(`Conflict verbs detected: ${conflictDensity.toFixed(1)} per 100 words`);
    }

    // 4. Cliffhanger ending.
    const lastFiftyWords = body.split(/\s+/).slice(-50).join(' ');
    const cliffhanger = CLIFFHANGER_PATTERN.test(lastFiftyWords) || lastFiftyWords.endsWith('?');
    if (cliffhanger) {
      reasons.push('Cliffhanger ending detected');
    }
    const cliffScore = cliffhanger ? 1 : 0;

    // 5. Title hook.
    const titleHook = TITLE_HOOK_PATTERN.test(title);
    if (titleHook) {
      reasons.push('Engagement-bait title pattern');
    }
    const titleScore = titleHook ? 1 : 0;

    // Weighted sum. Stakes and conflict matter most.
    const composite =
      stakesScore * 0.30 +
      castScore * 0.20 +
      conflictScore * 0.20 +
      cliffScore * 0.15 +
      titleScore * 0.15;

    // Map to 1–5. Minimum 1 so flair always renders.
    // Per-sub percentile calibration replaces this fixed mapping post-Day 4.
    let score: number;
    if (composite < 0.15) score = 1;
    else if (composite < 0.30) score = 2;
    else if (composite < 0.50) score = 3;
    else if (composite < 0.70) score = 4;
    else score = 5;

    const confidence: 'low' | 'medium' | 'high' =
      reasons.length >= 3 ? 'high' : reasons.length >= 1 ? 'medium' : 'low';

    return {
      score,
      reasons: reasons.slice(0, 5),
      confidence,
      rawFeatures: {
        stakesDensity,
        castMatches,
        conflictDensity,
        cliffhanger: cliffScore,
        titleHook: titleScore,
        composite,
      },
    };
  },
};
