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
