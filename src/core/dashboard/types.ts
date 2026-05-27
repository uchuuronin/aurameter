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
    /**
     * Post title, captured at score time and stored on the post-result hash.
     * Surfaced in the queue row for mod identification (a wall of emoji-bars is
     * unworkable for non-technical mods). See the storage-policy note on
     * LogEntry below — titles ARE persisted by deliberate choice.
     */
    title?: string;
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
// STORAGE POLICY (updated): the log records mod usernames (accountability, like
// Reddit's native mod log) and, by deliberate choice, a snapshot of the post
// TITLE at action time — titles give non-technical mods a human reference in
// the queue and log without opening every post. Titles are short, mod-only
// surfaces, and Reddit already hands moderators full post content; storing a
// title snapshot is an accepted tradeoff for usability. We still NEVER store
// post BODY or author identity — `postId` builds the link-out, and body/author
// stay live-fetched from Reddit at view time, never persisted.

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
  /**
   * Post title snapshot at action time (see STORAGE POLICY above). Optional:
   * config-change entries have no post, and older entries written before this
   * field existed won't carry it.
   */
  title?: string;
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
  clown: { emoji: '🤡', label: 'Bias',  color: '#ef4444' },
  slop:  { emoji: '🤖', label: 'Slop',  color: '#8b5cf6' },
};

export const visibilityOptions: Array<{ value: SignalVisibility; label: string }> = [
  { value: 'off',      label: 'Off'      },
  { value: 'mod-only', label: 'Mod only' },
  { value: 'public',   label: 'Public'   },
];
