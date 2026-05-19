/**
 * dashboard api. mounted at /api in src/index.ts.
 *
 * endpoints:
 *   GET  /api/health
 *   GET  /api/dashboard/:sub          full dashboard payload (config + queue + trends)
 *   GET  /api/config/:sub             subconfig + available presets
 *   GET  /api/queue/:sub              triage queue, hydrated
 *   GET  /api/trends/:sub             per-signal sparkline data
 *   GET  /api/debug/post/:postId      per-post feature breakdown
 *   GET  /api/debug/baseline/:sub     learned vs default baseline comparison
 *   POST /api/config/:sub/preset      apply a preset
 *   PATCH /api/config/:sub            patch individual fields
 *   PATCH /api/config/:sub/signal/:signal  patch one signal's config
 *   GET  /api/config/:sub/automod     export rules as automod yaml
 */

import { Hono } from 'hono';
import type { SubConfig, SignalConfig } from '../core/config/types.js';
import type { SignalName } from '../core/signals/types.js';
import {
  loadConfig,
  saveConfig,
  getTopQueue,
  loadPostResult,
  loadBaseline,
} from '../core/engine/storage.js';
import { readAllTrends } from '../core/engine/trends.js';
import { defaultBaselines } from '../core/calibration/defaults.js';
import { PRESETS, type PresetName } from '../core/config/presets.js';
import { ruleToAutoModYaml, describeRule } from '../core/engine/rules.js';

export const api = new Hono();

// ── health ────────────────────────────────────────────────────────────────────

api.get('/health', (c) => c.json({ ok: true, service: 'aurameter' }));

// ── dashboard (single-call payload for initial render) ────────────────────────

/**
 * returns everything the dashboard needs in one round trip:
 *   config, queue (top 20), trends (14 days).
 * the client can refresh individual sections via their own endpoints.
 */
api.get('/dashboard/:sub', async (c) => {
  const sub = c.req.param('sub');
  const trendDays = Number(c.req.query('days') ?? '14');
  const queueSize = Number(c.req.query('q') ?? '20');

  const [config, topQueue, trends] = await Promise.all([
    loadConfig(sub),
    getTopQueue(sub, queueSize),
    readAllTrends(sub, trendDays),
  ]);

  if (!config) return c.json({ error: 'no config for sub' }, 404);

  const queue = await Promise.all(
    topQueue.map(async ({ postId, priority }) => {
      const result = await loadPostResult(postId);
      return { postId, priority, result };
    })
  );

  return c.json({
    config,
    queue,
    trends,
    presets: presetMeta(),
  });
});

// ── config ────────────────────────────────────────────────────────────────────

api.get('/config/:sub', async (c) => {
  const sub = c.req.param('sub');
  const config = await loadConfig(sub);
  return c.json({ config, presets: presetMeta() });
});

api.post('/config/:sub/preset', async (c) => {
  const sub = c.req.param('sub');
  const body = await c.req.json<{ preset?: string }>();
  if (!body.preset || !(body.preset in PRESETS)) {
    return c.json({ error: 'unknown preset' }, 400);
  }
  const config = PRESETS[body.preset as PresetName].config(sub);
  await saveConfig(config);
  return c.json({ ok: true, config });
});

/** patch top-level config fields (aggressiveness, observeOnly, rules, etc.) */
api.patch('/config/:sub', async (c) => {
  const sub = c.req.param('sub');
  const existing = await loadConfig(sub);
  if (!existing) return c.json({ error: 'no config for sub' }, 404);
  const patch = await c.req.json<Partial<SubConfig>>();
  // don't allow overwriting subreddit or installedAt via patch
  const merged: SubConfig = {
    ...existing,
    ...patch,
    subreddit: existing.subreddit,
    installedAt: existing.installedAt,
  };
  await saveConfig(merged);
  return c.json({ ok: true, config: merged });
});

/** patch a single signal's config without touching the rest */
api.patch('/config/:sub/signal/:signal', async (c) => {
  const sub = c.req.param('sub');
  const signal = c.req.param('signal') as SignalName;
  const validSignals: SignalName[] = ['tea', 'time', 'clown', 'slop'];
  if (!validSignals.includes(signal)) return c.json({ error: 'unknown signal' }, 400);

  const existing = await loadConfig(sub);
  if (!existing) return c.json({ error: 'no config for sub' }, 404);

  const patch = await c.req.json<Partial<SignalConfig>>();
  const updated: SubConfig = {
    ...existing,
    signals: {
      ...existing.signals,
      [signal]: { ...existing.signals[signal], ...patch },
    },
  };
  await saveConfig(updated);
  return c.json({ ok: true, signal, config: updated.signals[signal] });
});

// ── queue ─────────────────────────────────────────────────────────────────────

api.get('/queue/:sub', async (c) => {
  const sub = c.req.param('sub');
  const n = Number(c.req.query('n') ?? '20');
  const top = await getTopQueue(sub, n);
  const queue = await Promise.all(
    top.map(async ({ postId, priority }) => {
      const result = await loadPostResult(postId);
      return { postId, priority, result };
    })
  );
  return c.json({ queue });
});

// ── trends ────────────────────────────────────────────────────────────────────

api.get('/trends/:sub', async (c) => {
  const sub = c.req.param('sub');
  const days = Math.max(1, Math.min(90, Number(c.req.query('days') ?? '14')));
  const trends = await readAllTrends(sub, days);
  return c.json({ trends });
});

// ── debug ─────────────────────────────────────────────────────────────────────

/** full per-post feature breakdown for the drilldown modal */
api.get('/debug/post/:postId', async (c) => {
  const postId = c.req.param('postId');
  const result = await loadPostResult(postId);
  if (!result) return c.json({ error: 'post not found' }, 404);
  return c.json({ result });
});

/**
 * shows what the scoring model currently knows about a sub:
 *   learned baseline (if any) vs default baseline, side by side.
 * mods can see exactly why score thresholds are where they are.
 */
api.get('/debug/baseline/:sub', async (c) => {
  const sub = c.req.param('sub');
  const signals: SignalName[] = ['tea', 'time', 'clown', 'slop'];

  const learned = Object.fromEntries(
    await Promise.all(
      signals.map(async (s) => [s, await loadBaseline(sub, s)])
    )
  );

  return c.json({
    learned,
    defaults: defaultBaselines,
    note: 'learned is null when sample size < minimum (50 posts per signal)',
  });
});

// ── automod export ────────────────────────────────────────────────────────────

api.get('/config/:sub/automod', async (c) => {
  const sub = c.req.param('sub');
  const config = await loadConfig(sub);
  if (!config) return c.json({ error: 'no config for sub' }, 404);

  const yaml = config.rules
    .filter((r) => r.enabled)
    .map((r) => `---\n${ruleToAutoModYaml(r, config)}\n`)
    .join('\n');

  return c.json({
    yaml,
    rules: config.rules.map((r) => ({
      id: r.id,
      label: r.label,
      description: describeRule(r),
    })),
  });
});

// ── helpers ───────────────────────────────────────────────────────────────────

function presetMeta() {
  return Object.entries(PRESETS).map(([name, p]) => ({
    name,
    label: p.name,
    description: p.description,
  }));
}
