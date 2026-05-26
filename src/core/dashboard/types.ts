/**
 * shared types for the dashboard.
 *
 * the custom-post webview communicates with the devvit server via regular HTTP
 * (see bridge.ts and routes/api.ts). this file holds the shapes used on both
 * sides: payload shapes returned by the api, plus display helpers.
 *
 * the older devvit-message postMessage protocol is no longer used for
 * client→server calls. we keep `serverMessage` defined for any future
 * server-pushed updates that might arrive through window.onmessage.
 */

import type { SignalName } from '../signals/types.js';
import type { SubConfig, SignalVisibility } from '../config/types.js';

// ── payload shapes returned by the api ───────────────────────────────────────

export interface queueEntry {
  postId: string;
  priority: number;
  result: {
    sub: string;
    scores: Record<SignalName, number>;
    reasons: Record<SignalName, string[]>;
    ts: number;
  } | null;
  /**
   * Canonical post permalink, populated server-side from the live post read at
   * hydration time (see routes/api.ts reconciliation). Optional because a
   * transient read failure (PostState 'unknown') keeps the entry without a
   * fresh permalink. The client never reconstructs this URL itself — see
   * QueuePanel's openPost() / Block 1 spec §6.
   */
  permalink?: string;
}

export interface trendPoint {
  date: string;
  count: number;
  meanScore: number;
}

export interface trendSeries {
  signal: SignalName;
  points: trendPoint[];
}

export interface dashboardPayload {
  config: SubConfig;
  queue: queueEntry[];
  trends: trendSeries[];
  presets: Array<{ name: string; label: string; description: string }>;
}

// ── the unified action log (Block 1 §3) ──────────────────────────────────────
// One append-only attributed record per subreddit. The queue is the subset of
// posts still awaiting a decision; the log is the full history underneath it.
//
// Privacy line (spec §1.2, enforced at the type level): the log records mod
// usernames (accountability, like Reddit's native mod log) but NEVER post body,
// title, or author identity. There is deliberately no field to put author data
// in — `postId` is enough to build a link-out, and everything human-readable is
// fetched live from Reddit at view time, never persisted.

export type LogOutcome =
  | 'passed-through'  // scored but tripped no rule
  | 'dismissed'       // mod cleared it from the queue in-app
  | 'approved'        // only emitted if approvals turn out observable (§9 #1)
  | 'actioned'        // mod clicked "take action" → handed off to Reddit
  | 'rule-fired'      // a rule matched and an action executed (actor 'auto')
  | 'config-change';  // any successful config mutation

export interface LogEntry {
  /** collision-resistant id; same short-random approach as rule-validate.ts. */
  id: string;
  /** unix ms; also the sorted-set score. */
  ts: number;
  /** null for config-change entries (no single post). */
  postId: string | null;
  outcome: LogOutcome;
  /** mod username, or 'auto' for rule-fired / passed-through / reconciliation. */
  actor: string;
  /** signal scores at the time; null for config-change. */
  scores: Record<SignalName, number> | null;
  /** short human string: rule label, which config field changed, etc. */
  detail?: string;
}

// ── server → client push messages (future use) ───────────────────────────────
// All current data flow is fetch-based; these only fire if the server
// proactively pushes via window.onmessage / devvit-message envelopes.

export type serverMessage =
  | { type: 'init'; payload: dashboardPayload }
  | { type: 'queue_update'; queue: queueEntry[] }
  | { type: 'trends_update'; trends: trendSeries[] }
  | { type: 'config_update'; config: SubConfig }
  | { type: 'automod_yaml'; yaml: string }
  | { type: 'error'; message: string };

// ── display helpers ───────────────────────────────────────────────────────────

export const signalMeta: Record<SignalName, { emoji: string; label: string; color: string }> = {
  tea:   { emoji: '☕', label: 'Tea',   color: '#c47c2b' },
  time:  { emoji: '⏰', label: 'Time',  color: '#3b82f6' },
  clown: { emoji: '🤡', label: 'Clown', color: '#ef4444' },
  slop:  { emoji: '🤖', label: 'Slop',  color: '#8b5cf6' },
};

export const visibilityOptions: Array<{ value: SignalVisibility; label: string }> = [
  { value: 'off',      label: 'Off'      },
  { value: 'mod-only', label: 'Mod only' },
  { value: 'public',   label: 'Public'   },
];
