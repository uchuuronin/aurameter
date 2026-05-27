// src/core/engine/__tests__/rules.test.ts
//
// Block 3 dry-run: pure predicate tests for evaluating a candidate rule's
// conditions against a post's stored 0–5 scores. No Redis — pure logic.

import { describe, it, expect } from 'vitest';
import {
  evaluateConditionScore,
  evaluateConditionsAgainstScores,
} from '../rules.js';
import type { RuleCondition } from '../../config/types.js';
import type { SignalName } from '../../signals/types.js';

const scores = (partial: Partial<Record<SignalName, number>>): Record<SignalName, number> => ({
  tea: 0, time: 0, clown: 0, slop: 0, ...partial,
});

describe('evaluateConditionScore (pure comparator)', () => {
  const c = (comparator: RuleCondition['comparator'], threshold: number): RuleCondition =>
    ({ signal: 'slop', comparator, threshold });

  it('>= is inclusive', () => {
    expect(evaluateConditionScore(c('>=', 2), 2)).toBe(true);
    expect(evaluateConditionScore(c('>=', 2), 1)).toBe(false);
  });
  it('> is strict', () => {
    expect(evaluateConditionScore(c('>', 2), 3)).toBe(true);
    expect(evaluateConditionScore(c('>', 2), 2)).toBe(false);
  });
  it('= is exact', () => {
    expect(evaluateConditionScore(c('=', 3), 3)).toBe(true);
    expect(evaluateConditionScore(c('=', 3), 4)).toBe(false);
  });
  it('<= is inclusive', () => {
    expect(evaluateConditionScore(c('<=', 1), 1)).toBe(true);
    expect(evaluateConditionScore(c('<=', 1), 2)).toBe(false);
  });
  it('< is strict', () => {
    expect(evaluateConditionScore(c('<', 1), 0)).toBe(true);
    expect(evaluateConditionScore(c('<', 1), 1)).toBe(false);
  });
});

describe('evaluateConditionsAgainstScores (dry-run predicate)', () => {
  it('single condition matches', () => {
    expect(
      evaluateConditionsAgainstScores(
        [{ signal: 'slop', comparator: '>=', threshold: 2 }],
        scores({ slop: 2 }),
      ),
    ).toBe(true);
  });

  it('single condition fails below threshold', () => {
    expect(
      evaluateConditionsAgainstScores(
        [{ signal: 'slop', comparator: '>=', threshold: 2 }],
        scores({ slop: 1 }),
      ),
    ).toBe(false);
  });

  it('AND semantics: all conditions must meet', () => {
    const conds: RuleCondition[] = [
      { signal: 'slop', comparator: '>=', threshold: 2 },
      { signal: 'time', comparator: '>=', threshold: 2 },
    ];
    expect(evaluateConditionsAgainstScores(conds, scores({ slop: 3, time: 2 }))).toBe(true);
    expect(evaluateConditionsAgainstScores(conds, scores({ slop: 3, time: 1 }))).toBe(false);
  });

  it('a missing signal is treated as score 0', () => {
    // clown absent from the map entirely -> 0, so clown>=1 fails.
    expect(
      evaluateConditionsAgainstScores(
        [{ signal: 'clown', comparator: '>=', threshold: 1 }],
        { tea: 2 } as Record<SignalName, number>,
      ),
    ).toBe(false);
  });

  it('empty conditions never match-all (returns false)', () => {
    expect(evaluateConditionsAgainstScores([], scores({ slop: 5, tea: 5 }))).toBe(false);
  });

  it('<= condition matches a low score', () => {
    expect(
      evaluateConditionsAgainstScores(
        [{ signal: 'slop', comparator: '<=', threshold: 1 }],
        scores({ slop: 0 }),
      ),
    ).toBe(true);
  });
});
