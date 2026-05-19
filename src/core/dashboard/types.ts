/**
 * shared types for the dashboard custom post message protocol.
 *
 * the custom post iframe communicates with the devvit server via
 * postMessage (window.parent.postMessage). both sides import from here
 * so the protocol is typed end-to-end.
 */

import type { SignalName } from '../signals/types.js';
import type { SubConfig, SignalConfig, Aggressiveness, SignalVisibility } from '../config/types.js';

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

// ── messages from iframe → parent (devvit server) ─────────────────────────────

export type clientMessage =
  | { type: 'ready' }
  | { type: 'navigate'; postId: string }
  | { type: 'patch_signal'; signal: SignalName; patch: Partial<SignalConfig> }
  | { type: 'patch_config'; patch: { aggressiveness?: Aggressiveness; observeOnly?: boolean } }
  | { type: 'apply_preset'; preset: string }
  | { type: 'copy_automod' }
  | { type: 'refresh_queue' }
  | { type: 'refresh_trends'; days: number };

// ── messages from parent → iframe ─────────────────────────────────────────────

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
