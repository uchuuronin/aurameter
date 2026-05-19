/**
 * Dashboard API. Mounted at /api in src/index.ts.
 *
 * Called by the dashboard custom post (Day 5 build) to read state and mutate
 * config. Each route is short and delegates to core/engine modules.
 *
 * The dashboard is mod-only by virtue of being launched from a mod-only menu;
 * Devvit Web scopes calls to the calling user automatically.
 */

import { Hono } from 'hono';
import { loadConfig, saveConfig, getTopQueue, loadPostResult } from '../core/engine/storage.js';
import { PRESETS, type PresetName } from '../core/config/presets.js';
import { ruleToAutoModYaml, describeRule } from '../core/engine/rules.js';
import type { SubConfig } from '../core/config/types.js';

export const api = new Hono();

// Health check.
api.get('/health', (c) => c.json({ ok: true, service: 'aurameter' }));

// Read endpoints
/** Returns the SubConfig + a list of available presets. */
api.get('/config/:sub', async (c) => {
  const sub = c.req.param('sub');
  const config = await loadConfig(sub);
  return c.json({
    config,
    presets: Object.entries(PRESETS).map(([name, p]) => ({
      name,
      label: p.name,
      description: p.description,
    })),
  });
});

/** Top N posts in the triage queue, hydrated with per-post results. */
api.get('/queue/:sub', async (c) => {
  const sub = c.req.param('sub');
  const n = Number(c.req.query('n') ?? '10');
  const top = await getTopQueue(sub, n);
  const hydrated = await Promise.all(
    top.map(async ({ postId, priority }) => {
      const result = await loadPostResult(postId);
      return { postId, priority, result };
    })
  );
  return c.json({ queue: hydrated });
});

// Write endpoints
/** Apply a preset to the subreddit. Replaces existing config. */
api.post('/config/:sub/preset', async (c) => {
  const sub = c.req.param('sub');
  const body = await c.req.json<{ preset?: string }>();
  const presetName = body.preset;
  if (!presetName || !(presetName in PRESETS)) {
    return c.json({ error: 'Unknown preset' }, 400);
  }
  const preset = PRESETS[presetName as PresetName];
  const config = preset.config(sub);
  await saveConfig(config);
  return c.json({ ok: true, config });
});

/** Update individual config fields (visibility, aggressiveness, observe-only). */
api.patch('/config/:sub', async (c) => {
  const sub = c.req.param('sub');
  const existing = await loadConfig(sub);
  if (!existing) {
    return c.json({ error: 'No config for sub' }, 404);
  }
  const patch = await c.req.json<Partial<SubConfig>>();
  const merged: SubConfig = { ...existing, ...patch };
  await saveConfig(merged);
  return c.json({ ok: true, config: merged });
});

/** Export all rules as AutoMod YAML. */
api.get('/config/:sub/automod', async (c) => {
  const sub = c.req.param('sub');
  const config = await loadConfig(sub);
  if (!config) {
    return c.json({ error: 'No config for sub' }, 404);
  }
  const yaml = config.rules
    .filter((r) => r.enabled)
    .map((r) => `---\n${ruleToAutoModYaml(r, config)}\n`)
    .join('\n');
  return c.json({
    yaml,
    rules: config.rules.map((r) => ({ id: r.id, label: r.label, description: describeRule(r) })),
  });
});
