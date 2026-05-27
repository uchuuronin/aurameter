/**
 * Custom rule evaluator.
 *
 * Mods build automation rules in the dashboard: "IF 🤖≥2 AND ⏰≥2 THEN
 * send_to_modqueue". This module evaluates rules against a post's SignalResults
 * and returns the list of actions to execute.
 *
 * Pure function. The caller (the trigger handler) is responsible for actually
 * calling the Reddit API to perform each action.
 *
 * Conditions are AND semantics within a rule, OR semantics across rules.
 * All matching rules fire; the trigger handler deduplicates conflicting actions
 * (e.g. two rules both setting flair : last write wins, in declaration order).
 */

import type { RuleAction, RuleCondition, RuleConfig, SubConfig } from '../config/types.js';
import type { SignalName } from '../signals/types.js';
import type { SignalResults } from './score.js';

export interface RuleMatch {
  rule: RuleConfig;
  action: RuleAction;
}

/**
 * Evaluate one condition against a plain 0–5 scores map. The single source of
 * truth for comparator semantics — both the live evaluator (over SignalResults)
 * and the dry-run preview (over stored scores) route through this so they can
 * never diverge. Pure.
 */
export function evaluateConditionScore(
  condition: RuleCondition,
  score: number
): boolean {
  switch (condition.comparator) {
    case '>=': return score >= condition.threshold;
    case '>': return score > condition.threshold;
    case '=': return score === condition.threshold;
    case '<': return score < condition.threshold;
    case '<=': return score <= condition.threshold;
    default: return false;
  }
}

function evaluateCondition(condition: RuleCondition, results: SignalResults): boolean {
  return evaluateConditionScore(condition, results[condition.signal].score);
}

export function evaluateRules(
  results: SignalResults,
  subConfig: SubConfig
): RuleMatch[] {
  // Observe-only mode: compute matches but caller MUST NOT execute them.
  // We still return them so the dashboard can show "would have fired" counts.
  const matches: RuleMatch[] = [];

  for (const rule of subConfig.rules) {
    if (!rule.enabled) continue;
    const allConditionsMet = rule.conditions.every((c) => evaluateCondition(c, results));
    if (allConditionsMet) {
      matches.push({ rule, action: rule.action });
    }
  }

  return matches;
}

/**
 * Dry-run predicate (Block 3): does a candidate rule's conditions ALL match a
 * post's stored 0–5 scores? AND semantics within the rule, mirroring
 * evaluateRules. Pure — used by the /api/rules/dryrun endpoint to replay a
 * not-yet-saved rule over the last 7 days of logged post scores.
 *
 * A missing signal in the scores map is treated as score 0 (a post that never
 * scored that signal). `conditions` must be non-empty (a zero-condition rule is
 * rejected upstream by rule-validate); an empty array returns false here so a
 * malformed candidate can't "match everything".
 */
export function evaluateConditionsAgainstScores(
  conditions: RuleCondition[],
  scores: Record<SignalName, number>
): boolean {
  if (!Array.isArray(conditions) || conditions.length === 0) return false;
  return conditions.every((c) => evaluateConditionScore(c, scores[c.signal] ?? 0));
}

/**
 * Render a rule as plain English for the dashboard.
 * Example: "IF slop ≥ 2 AND time ≥ 2 THEN send to mod queue"
 */
export function describeRule(rule: RuleConfig): string {
  const conditionText = rule.conditions
    .map((c) => `${c.signal} ${c.comparator} ${c.threshold}`)
    .join(' AND ');
  const actionText = describeAction(rule.action);
  return `IF ${conditionText} THEN ${actionText}`;
}

function describeAction(action: RuleAction): string {
  switch (action.type) {
    case 'send_to_modqueue':
      return `send to mod queue (reason: "${action.reason}")`;
    case 'set_flair':
      return `set flair to "${action.flairText}"`;
    case 'ping_modmail':
      return `ping modmail`;
    case 'require_manual_review':
      return `require manual review`;
    default:
      return 'unknown action';
  }
}

/**
 * Export a rule as AutoMod YAML for mods to paste into their sub's automod wiki.
 * This is the most important feature for Community Impact scoring: it converts
 * aurameter-only rules into native AutoMod that survives uninstall.
 *
 * Uses the per-sub emoji and scale overrides so the exported YAML references
 * the same flair strings aurameter will actually write — i.e. the digit-suffix
 * form "🤖2", matching composeFlair() in engine/flair.ts.
 */
export function ruleToAutoModYaml(rule: RuleConfig, subConfig: SubConfig): string {
  // We can only export rules whose conditions reference the flair text.
  // Other rule types stay aurameter-internal.
  const flairConditions = rule.conditions
    .map((c) => flairConditionToYaml(c, subConfig))
    .filter((s): s is string => s !== null);

  if (flairConditions.length === 0) {
    return `# Rule "${rule.label}" cannot be exported to AutoMod (no flair-based conditions).`;
  }

  const action = autoModActionFor(rule.action);
  if (!action) {
    return `# Rule "${rule.label}" cannot be exported (action not supported in AutoMod).`;
  }

  return [
    `# aurameter-generated rule: ${rule.label}`,
    ...flairConditions,
    action,
  ].join('\n');
}

function flairConditionToYaml(condition: RuleCondition, subConfig: SubConfig): string | null {
  // Default emoji per signal; per-sub override applied below.
  const defaultEmojis: Record<string, string> = {
    tea: '☕',
    time: '⏰',
    clown: '🤡',
    slop: '🤖',
  };
  const emoji = subConfig.signals[condition.signal].emoji ?? defaultEmojis[condition.signal];
  if (!emoji) return null;

  // List all integer counts (1..effectiveMax) that satisfy this comparator.
  // Default max is now 5 for every signal (configurable per sub).
  const defaultMax = 5;
  const max = subConfig.signals[condition.signal].maxScore ?? defaultMax;
  const satisfying: number[] = [];
  for (let n = 1; n <= max; n++) {
    const ok = (() => {
      switch (condition.comparator) {
        case '>=': return n >= condition.threshold;
        case '>': return n > condition.threshold;
        case '=': return n === condition.threshold;
        case '<': return n < condition.threshold;
        case '<=': return n <= condition.threshold;
      }
    })();
    if (ok) satisfying.push(n);
  }
  if (satisfying.length === 0) return null;
  // Digit-suffix flair strings, e.g. "🤖2", to match what aurameter writes.
  const flairStrings = satisfying.map((n) => `${emoji}${n}`);
  const quoted = flairStrings.map((s) => `'${s}'`).join(', ');
  return `~link_flair_text (includes-word): [${quoted}]`;
}

function autoModActionFor(action: RuleAction): string | null {
  switch (action.type) {
    case 'send_to_modqueue':
      return `action: filter\naction_reason: "${action.reason}"`;
    case 'set_flair':
      return `set_flair: "${action.flairText}"`;
    case 'require_manual_review':
      return `action: filter\naction_reason: "Requires manual review"`;
    case 'ping_modmail':
      // Modmail pings are not first-class in AutoMod; fall back to filter + comment.
      return `action: filter\naction_reason: "${action.subject}"`;
    default:
      return null;
  }
}
