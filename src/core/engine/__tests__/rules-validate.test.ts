// src/core/engine/__tests__/rules-validate.test.ts
import { describe, it, expect } from 'vitest';
import { validateRulePayload } from '../rule-validate.js';

describe('validateRulePayload', () => {
  it('accepts a minimal valid queue rule', () => {
    const r = validateRulePayload({
      label: 'Queue slop',
      conditions: [{ signal: 'slop', comparator: '>=', threshold: 2 }],
      action: { type: 'send_to_modqueue', reason: 'suspected synthetic' },
    });
    expect('rule' in r).toBe(true);
    if ('rule' in r) {
      expect(r.rule.enabled).toBe(true);
      expect(r.rule.id).toMatch(/.+/);
      expect(r.rule.conditions).toHaveLength(1);
      expect(r.rule.action).toEqual({ type: 'send_to_modqueue', reason: 'suspected synthetic' });
    }
  });

  it('rejects zero conditions', () => {
    const r = validateRulePayload({
      label: 'x',
      conditions: [],
      action: { type: 'require_manual_review' },
    });
    expect('error' in r).toBe(true);
  });

  it('rejects more than 3 conditions', () => {
    const c = { signal: 'tea', comparator: '>=', threshold: 1 };
    const r = validateRulePayload({ label: 'x', conditions: [c, c, c, c], action: { type: 'require_manual_review' } });
    expect('error' in r).toBe(true);
  });

  it('rejects an unknown signal', () => {
    const r = validateRulePayload({
      label: 'x',
      conditions: [{ signal: 'vibes', comparator: '>=', threshold: 1 }],
      action: { type: 'require_manual_review' },
    });
    expect('error' in r).toBe(true);
  });

  it('rejects a comparator outside the add-form subset', () => {
    // builder only emits >= and <=; server enforces that too
    const r = validateRulePayload({
      label: 'x',
      conditions: [{ signal: 'tea', comparator: '=', threshold: 1 }],
      action: { type: 'require_manual_review' },
    });
    expect('error' in r).toBe(true);
  });

  it('rejects a threshold outside 0..5', () => {
    const r = validateRulePayload({
      label: 'x',
      conditions: [{ signal: 'tea', comparator: '>=', threshold: 9 }],
      action: { type: 'require_manual_review' },
    });
    expect('error' in r).toBe(true);
  });

  it('rejects non-integer threshold', () => {
    const r = validateRulePayload({
      label: 'x',
      conditions: [{ signal: 'tea', comparator: '>=', threshold: 1.5 }],
      action: { type: 'require_manual_review' },
    });
    expect('error' in r).toBe(true);
  });

  it('builds a set_flair action and drops extra fields', () => {
    const r = validateRulePayload({
      label: 'flair it',
      conditions: [{ signal: 'clown', comparator: '<=', threshold: 1 }],
      action: { type: 'set_flair', flairText: '🤡 mild', reason: 'should be ignored' },
    });
    expect('rule' in r).toBe(true);
    if ('rule' in r) expect(r.rule.action).toEqual({ type: 'set_flair', flairText: '🤡 mild' });
  });

  it('builds a ping_modmail action with subject+body', () => {
    const r = validateRulePayload({
      label: 'mail it',
      conditions: [{ signal: 'time', comparator: '>=', threshold: 3 }],
      action: { type: 'ping_modmail', subject: 'Urgent', body: 'flagged' },
    });
    expect('rule' in r).toBe(true);
    if ('rule' in r) expect(r.rule.action).toEqual({ type: 'ping_modmail', subject: 'Urgent', body: 'flagged' });
  });

  it('rejects set_flair with empty flairText', () => {
    const r = validateRulePayload({
      label: 'x',
      conditions: [{ signal: 'tea', comparator: '>=', threshold: 1 }],
      action: { type: 'set_flair', flairText: '   ' },
    });
    expect('error' in r).toBe(true);
  });

  it('rejects an unknown action type', () => {
    const r = validateRulePayload({
      label: 'x',
      conditions: [{ signal: 'tea', comparator: '>=', threshold: 1 }],
      action: { type: 'banhammer' },
    });
    expect('error' in r).toBe(true);
  });

  it('rejects a missing/blank label', () => {
    const r = validateRulePayload({
      label: '   ',
      conditions: [{ signal: 'tea', comparator: '>=', threshold: 1 }],
      action: { type: 'require_manual_review' },
    });
    expect('error' in r).toBe(true);
  });

  it('produces unique ids across calls', () => {
    const mk = () => validateRulePayload({
      label: 'x', conditions: [{ signal: 'tea', comparator: '>=', threshold: 1 }],
      action: { type: 'require_manual_review' },
    });
    const a = mk(), b = mk();
    if ('rule' in a && 'rule' in b) expect(a.rule.id).not.toBe(b.rule.id);
    else throw new Error('both should be valid');
  });
});
