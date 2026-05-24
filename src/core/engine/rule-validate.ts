// src/core/engine/rule-validate.ts
/**
 * Pure validator for client-submitted custom rules.
 *
 * The dashboard add-form only emits `>=` and `<=`; this validator enforces the
 * same subset server-side and constructs a well-formed discriminated-union
 * RuleAction so a malformed action can never reach config.rules (where it would
 * later throw in evaluateRules / ruleToAutoModYaml). No redis, no I/O — unit-testable.
 */
import type { RuleConfig, RuleCondition, RuleAction } from '../config/types.js';
import type { SignalName } from '../signals/types.js';

export type ValidateResult = { rule: RuleConfig } | { error: string };

const SIGNALS: readonly SignalName[] = ['tea', 'time', 'clown', 'slop'];
// Builder subset only — NOT the full engine set. Engine still supports =,>,< for preset rules.
const ADD_FORM_COMPARATORS: readonly RuleCondition['comparator'][] = ['>=', '<='];

function newRuleId(): string {
  // No uuid dep needed; collision-resistant enough for per-sub rule lists.
  return `rule-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

function validateCondition(raw: unknown): RuleCondition | string {
  if (!isObj(raw)) return 'condition is not an object';
  const { signal, comparator, threshold } = raw;
  if (typeof signal !== 'string' || !SIGNALS.includes(signal as SignalName)) {
    return `unknown signal: ${String(signal)}`;
  }
  if (typeof comparator !== 'string' || !ADD_FORM_COMPARATORS.includes(comparator as RuleCondition['comparator'])) {
    return `comparator must be one of ${ADD_FORM_COMPARATORS.join(', ')}`;
  }
  if (typeof threshold !== 'number' || !Number.isInteger(threshold) || threshold < 0 || threshold > 5) {
    return 'threshold must be an integer 0..5';
  }
  return { signal: signal as SignalName, comparator: comparator as RuleCondition['comparator'], threshold };
}

function validateAction(raw: unknown): RuleAction | string {
  if (!isObj(raw)) return 'action is not an object';
  const type = raw.type;
  switch (type) {
    case 'send_to_modqueue': {
      const reason = typeof raw.reason === 'string' ? raw.reason.trim() : '';
      if (!reason) return 'send_to_modqueue requires a non-empty reason';
      return { type, reason };
    }
    case 'set_flair': {
      const flairText = typeof raw.flairText === 'string' ? raw.flairText.trim() : '';
      if (!flairText) return 'set_flair requires non-empty flairText';
      return { type, flairText };
    }
    case 'ping_modmail': {
      const subject = typeof raw.subject === 'string' ? raw.subject.trim() : '';
      const body = typeof raw.body === 'string' ? raw.body.trim() : '';
      if (!subject) return 'ping_modmail requires a non-empty subject';
      if (!body) return 'ping_modmail requires a non-empty body';
      return { type, subject, body };
    }
    case 'require_manual_review':
      return { type };
    default:
      return `unknown action type: ${String(type)}`;
  }
}

export function validateRulePayload(raw: unknown): ValidateResult {
  if (!isObj(raw)) return { error: 'payload is not an object' };

  const label = typeof raw.label === 'string' ? raw.label.trim() : '';
  if (!label) return { error: 'label is required' };

  if (!Array.isArray(raw.conditions) || raw.conditions.length < 1 || raw.conditions.length > 3) {
    return { error: 'a rule needs 1 to 3 conditions' };
  }
  const conditions: RuleCondition[] = [];
  for (const c of raw.conditions) {
    const v = validateCondition(c);
    if (typeof v === 'string') return { error: v };
    conditions.push(v);
  }

  const action = validateAction(raw.action);
  if (typeof action === 'string') return { error: action };

  return {
    rule: { id: newRuleId(), label, conditions, action, enabled: true },
  };
}
