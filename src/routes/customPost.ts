/**
 * custom post server handler. mounted at /internal/custom-post.
 *
 * devvit calls GET /internal/custom-post to render the custom post iframe src.
 * all subsequent dashboard interactions go through the api routes — the custom
 * post just loads the client bundle and passes the subreddit name as a query param.
 *
 * message handling: the devvit web sdk proxies postMessage calls from the iframe
 * to the server via /internal/custom-post/message. we handle those here,
 * calling the same api logic as the rest endpoints but returning typed server messages.
 */

import { Hono } from 'hono';
import { context } from '@devvit/web/server';
import type {
  CustomPostRequest,
  CustomPostMessageRequest,
  CustomPostResponse,
  CustomPostMessageResponse,
} from '@devvit/web/shared';
import type { clientMessage } from '../core/dashboard/types.js';
import {
  loadConfig,
  saveConfig,
  getTopQueue,
  loadPostResult,
} from '../core/engine/storage.js';
import { readAllTrends } from '../core/engine/trends.js';
import { PRESETS, type PresetName } from '../core/config/presets.js';
import type { SubConfig, SignalConfig, Aggressiveness } from '../core/config/types.js';
import type { SignalName } from '../core/signals/types.js';
import type { serverMessage, queueEntry } from '../core/dashboard/types.js';
import { ruleToAutoModYaml } from '../core/engine/rules.js';

export const customPost = new Hono();

// ── initial render ────────────────────────────────────────────────────────────

customPost.get('/', async (c) => {
  const sub = context.subredditName ?? '';
  return c.json<CustomPostResponse>({
    // the client bundle is served from dist/client/index.html
    // sub is passed as a query param so the bundle can self-identify
    webViewUrl: `/dashboard/index.html?sub=${encodeURIComponent(sub)}`,
  });
});

// ── message handler ───────────────────────────────────────────────────────────

customPost.post('/message', async (c) => {
  const req = await c.req.json<CustomPostMessageRequest>();
  const msg = req.message as clientMessage;
  const sub = context.subredditName ?? '';

  const send = (payload: serverMessage): Response =>
    c.json<CustomPostMessageResponse>({ message: payload });

  switch (msg.type) {
    case 'ready': {
      const [config, topQueue, trends] = await Promise.all([
        loadConfig(sub),
        getTopQueue(sub, 20),
        readAllTrends(sub, 14),
      ]);

      if (!config) {
        return send({ type: 'error', message: 'no config found for this subreddit' });
      }

      const queue = await hydrateQueue(topQueue);

      return send({
        type: 'init',
        payload: {
          config,
          queue,
          trends,
          presets: Object.entries(PRESETS).map(([name, p]) => ({
            name,
            label: p.name,
            description: p.description,
          })),
        },
      });
    }

    case 'patch_signal': {
      const config = await loadConfig(sub);
      if (!config) return send({ type: 'error', message: 'no config' });
      const patch = msg.patch as Partial<SignalConfig>;
      const signal = msg.signal as SignalName;
      const updated: SubConfig = {
        ...config,
        signals: {
          ...config.signals,
          [signal]: { ...config.signals[signal], ...patch },
        },
      };
      await saveConfig(updated);
      return send({ type: 'config_update', config: updated });
    }

    case 'patch_config': {
      const config = await loadConfig(sub);
      if (!config) return send({ type: 'error', message: 'no config' });
      const patch = msg.patch as { aggressiveness?: Aggressiveness; observeOnly?: boolean };
      const updated: SubConfig = { ...config, ...patch };
      await saveConfig(updated);
      return send({ type: 'config_update', config: updated });
    }

    case 'apply_preset': {
      const presetName = msg.preset;
      if (!(presetName in PRESETS)) {
        return send({ type: 'error', message: `unknown preset: ${presetName}` });
      }
      const newConfig = PRESETS[presetName as PresetName].config(sub);
      await saveConfig(newConfig);
      return send({ type: 'config_update', config: newConfig });
    }

    case 'refresh_queue': {
      const topQueue = await getTopQueue(sub, 20);
      const queue = await hydrateQueue(topQueue);
      return send({ type: 'queue_update', queue });
    }

    case 'refresh_trends': {
      const days = Math.max(1, Math.min(90, msg.days));
      const trends = await readAllTrends(sub, days);
      return send({ type: 'trends_update', trends });
    }

    case 'copy_automod': {
      const config = await loadConfig(sub);
      if (!config) return send({ type: 'error', message: 'no config' });
      const yaml = config.rules
        .filter((r) => r.enabled)
        .map((r) => `---\n${ruleToAutoModYaml(r, config)}\n`)
        .join('\n');
      return send({ type: 'automod_yaml', yaml });
    }

    case 'navigate': {
      // open the post in a new tab — handled client-side, no server action needed
      return send({ type: 'error', message: 'navigate is client-side only' });
    }

    default: {
      const _exhaustive: never = msg;
      return send({ type: 'error', message: 'unknown message type' });
    }
  }
});

// ── helpers ───────────────────────────────────────────────────────────────────

async function hydrateQueue(
  top: Array<{ postId: string; priority: number }>
): Promise<queueEntry[]> {
  return Promise.all(
    top.map(async ({ postId, priority }) => {
      const result = await loadPostResult(postId);
      return { postId, priority, result };
    })
  );
}
