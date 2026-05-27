/**
 * Per-subreddit configuration types.
 *
 * SubConfig is what mods edit through the dashboard. Each install gets one
 * SubConfig stored in Redis under `vc:cfg:<sub>`. Defaults come from
 * presets.ts on install.
 */

import type { SignalName } from '../signals/types.js';

/** Visibility for a signal: off entirely, mod-only, or public in the flair. */
export type SignalVisibility = 'off' | 'mod-only' | 'public';

/**
 * Overall aggressiveness scaling applied to all thresholds.
 * Conservative = fewer flags, higher precision. Aggressive = more flags, lower precision.
 */
export type Aggressiveness = 'conservative' | 'balanced' | 'aggressive';

/**
 * Per-signal config: visibility, emoji and scale overrides, and threshold overrides.
 * Per-sub percentile baselines live in Redis separately, not here.
 */
export interface SignalConfig {
  visibility: SignalVisibility;
  /**
   * Optional emoji override. If unset, uses the extractor's default emoji.
   * Single-codepoint emoji only (no ZWJ sequences) : flair-render width on
   * mobile becomes unpredictable with multi-codepoint emoji.
   */
  emoji?: string;
  /**
   * Optional maximum score override. If unset, uses the extractor's default
   * (Tea=5, others=3). Valid range: 1 to 5. The aggressiveness slider and
   * custom rule thresholds rescale proportionally when this is changed.
   */
  maxScore?: number;
  /**
   * Optional per-sub threshold overrides. If unset, fall back to the
   * defaults that ship in each extractor.
   */
  thresholdOverrides?: number[];
}

/**
 * A custom automation rule. Mods build these in the dashboard.
 * Evaluated against the post's SignalResults after scoring.
 */
export interface RuleConfig {
  id: string;
  /** Human-readable label, surfaced in the dashboard. */
  label: string;
  /** All conditions must be true for the rule to fire (AND semantics). */
  conditions: RuleCondition[];
  action: RuleAction;
  enabled: boolean;
}

export interface RuleCondition {
  signal: SignalName;
  comparator: '>=' | '>' | '=' | '<' | '<=';
  threshold: number;
}

export type RuleAction =
  | { type: 'send_to_modqueue'; reason: string }
  | { type: 'set_flair'; flairText: string }
  | { type: 'ping_modmail'; subject: string; body: string }
  | { type: 'require_manual_review' };

/**
 * Per-sub Slop spot-check opt-in state (Block 2). When enabled, the dashboard
 * surfaces batches of posts for the mod to label AI / not-AI; those labels feed
 * the global corpus and nudge this sub's Slop threshold. Optional: absent means
 * not opted in (the default).
 */
export interface SlopSpotCheckConfig {
  enabled: boolean;
  cadence: 'weekly' | 'monthly';
  /** Unix epoch ms of the last batch enqueue; 0 if never. */
  lastBatchAt: number;
}

/** The full per-subreddit config. One per install. */
export interface SubConfig {
  subreddit: string;
  /** Which preset was used at install time. For 'reset to defaults' button. */
  presetName: string;
  /**
   * If true, scores are computed and cached but no public flair is set and no
   * automation rules fire. 7-day default on new installs to build mod trust.
   */
  observeOnly: boolean;
  /** Global aggressiveness multiplier applied to all thresholds. */
  aggressiveness: Aggressiveness;
  /** Per-signal config. */
  signals: Record<SignalName, SignalConfig>;
  /** Custom automation rules, evaluated in declaration order. */
  rules: RuleConfig[];
  /** Unix epoch ms; used to auto-flip out of observe mode after 7 days. */
  installedAt: number;
  /** Slop spot-check opt-in state (Block 2). Absent = not opted in. */
  slopSpotCheck?: SlopSpotCheckConfig;
}
