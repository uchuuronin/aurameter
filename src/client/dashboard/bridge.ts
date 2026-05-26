/**
 * api bridge — typed wrapper around the dashboard's HTTP endpoints.
 *
 * the custom-post webview talks to the devvit server via regular fetch.
 * there is no postMessage transport for client→server in devvit web;
 * the iframe runs on the platform's webview host and makes normal HTTP
 * requests to /api/* routes (handled by routes/api.ts on the server).
 *
 * IMPORTANT: the webview URL does NOT carry the subreddit name as a query
 * param. the platform routes every server request through a context-aware
 * proxy, so `context.subredditName` is available SERVER-SIDE on every
 * /api/* request. the client therefore does not need to (and cannot
 * reliably) include the sub in the request URL. all routes are flat:
 *   /api/dashboard               (was /api/dashboard/:sub)
 *   /api/queue                   (was /api/queue/:sub)
 *   /api/trends                  (was /api/trends/:sub)
 *   /api/config                  (was /api/config/:sub)
 *   /api/config/signal/:signal   (was /api/config/:sub/signal/:signal)
 *   /api/config/preset           (was /api/config/:sub/preset)
 *   /api/config/automod          (was /api/config/:sub/automod)
 *   /api/queue/dismiss           clear a post from the queue
 *   /api/queue/handoff           hand a post off to Reddit's native mod UI
 *   /api/log                     unified action log
 *
 * server→client pushes (if we ever want them) arrive via window.onmessage
 * wrapped as { type: 'devvit-message', data: { message } }. we keep a
 * listener registered so future push updates work, but the dashboard
 * currently uses request/response only.
 */

import type {
  dashboardPayload,
  queueEntry,
  trendSeries,
  serverMessage,
  LogEntry,
} from '../../core/dashboard/types.js';
import type { SignalName } from '../../core/signals/types.js';
import type {
  SubConfig,
  SignalConfig,
  Aggressiveness,
  RuleConfig,
  RuleCondition,
  RuleAction,
} from '../../core/config/types.js';


type messageHandler = (msg: serverMessage) => void;

async function http<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status} on ${path}: ${text}`);
  }
  return res.json() as Promise<T>;
}

class ApiBridge {
  private handlers: messageHandler[] = [];

  constructor() {
    // Keep the devvit-message listener alive for any future server pushes.
    window.addEventListener('message', (ev) => {
      const raw = ev.data as { type?: string; data?: { message?: unknown } };
      if (raw?.type !== 'devvit-message') return;
      const msg = raw?.data?.message as serverMessage | undefined;
      if (!msg) return;
      for (const h of this.handlers) h(msg);
    });
  }

  async init(): Promise<dashboardPayload> {
    return http<dashboardPayload>(`/api/dashboard?days=14&q=20`);
  }

  async refreshQueue(): Promise<{ queue: queueEntry[] }> {
    return http<{ queue: queueEntry[] }>(`/api/queue?n=20`);
  }

  async refreshTrends(days: number): Promise<{ trends: trendSeries[] }> {
    return http<{ trends: trendSeries[] }>(`/api/trends?days=${days}`);
  }

  async patchSignal(
    signal: SignalName,
    patch: Partial<SignalConfig>
  ): Promise<{ ok: boolean; signal: SignalName; config: SignalConfig }> {
    return http(`/api/config/signal/${signal}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    });
  }

  async patchConfig(
    patch: { aggressiveness?: Aggressiveness; observeOnly?: boolean }
  ): Promise<{ ok: boolean; config: SubConfig }> {
    return http(`/api/config`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    });
  }

  async applyPreset(preset: string): Promise<{ ok: boolean; config: SubConfig }> {
    return http(`/api/config/preset`, {
      method: 'POST',
      body: JSON.stringify({ preset }),
    });
  }

  async copyAutomod(): Promise<{ yaml: string }> {
    return http<{ yaml: string }>(`/api/config/automod`);
  }
  
  async addRule(payload: {
    label: string;
    conditions: RuleCondition[];
    action: RuleAction;
  }): Promise<{ ok: boolean; rule: RuleConfig; config: SubConfig }> {
    return http(`/api/config/rule`, {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  }

  async deleteRule(id: string): Promise<{ ok: boolean; config: SubConfig }> {
    return http(`/api/config/rule/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    });
  }

  /** Dismiss a post from the queue (safe, reversible). */
  async dismiss(postId: string): Promise<{ ok: boolean; postId: string }> {
    return http(`/api/queue/dismiss`, {
      method: 'POST',
      body: JSON.stringify({ postId }),
    });
  }

  /**
   * Hand a post off to Reddit's native mod UI. Returns the canonical permalink
   * for the client to open (the server builds it; the client never does).
   */
  async handoff(postId: string): Promise<{ ok: boolean; postId: string; permalink: string }> {
    return http(`/api/queue/handoff`, {
      method: 'POST',
      body: JSON.stringify({ postId }),
    });
  }

  /**
   * Read the unified action log, newest-first. `before` (ts ms) pages back.
   * This is the data behind the log tab and the 24h passed-through count.
   */
  async readLog(opts?: { limit?: number; before?: number }): Promise<{ entries: LogEntry[] }> {
    const params = new URLSearchParams();
    params.set('limit', String(opts?.limit ?? 100));
    if (opts?.before !== undefined) params.set('before', String(opts.before));
    return http<{ entries: LogEntry[] }>(`/api/log?${params.toString()}`);
  }

  onMessage(handler: messageHandler): () => void {
    this.handlers.push(handler);
    return () => {
      this.handlers = this.handlers.filter((h) => h !== handler);
    };
  }
}

export const bridge = new ApiBridge();
