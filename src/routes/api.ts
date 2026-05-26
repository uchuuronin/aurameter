/**
 * dashboard api. mounted at /api in src/index.ts.
 *
 * IMPORTANT: the dashboard webview cannot reliably put the subreddit name in
 * the request URL — the platform doesn't pass it as a query param to the
 * entrypoint, and there's no client-side source of truth for it. Instead, the
 * devvit server populates `context.subredditName` on every /api/* request via
 * headers the platform injects. So every route below reads the sub from
 * context, NOT from a path param. The client (bridge.ts) calls flat paths:
 *
 *   GET   /api/health
 *   GET   /api/dashboard              full dashboard payload (config + queue + trends)
 *   GET   /api/config                 subconfig + available presets
 *   GET   /api/queue                  triage queue, hydrated + reconciled
 *   GET   /api/trends                 per-signal sparkline data
 *   GET   /api/log                    unified action log (reverse-chron)
 *   GET   /api/debug/post/:postId     per-post feature breakdown
 *   GET   /api/debug/baseline         learned vs default baseline comparison
 *   POST  /api/config/preset          apply a preset
 *   PATCH /api/config                 patch individual fields
 *   PATCH /api/config/signal/:signal  patch one signal's config
 *   GET   /api/config/automod         export rules as automod yaml
 *   POST  /api/config/rule            add a custom rule
 *   DELETE /api/config/rule/:id       delete a custom rule by id
 *   POST  /api/queue/dismiss          clear a post from the queue (mod decision)
 *   POST  /api/queue/handoff          hand a post off to Reddit's native mod UI
 */

import { Hono } from 'hono';
import { context, reddit } from '@devvit/web/server';
import { isT3 } from '@devvit/shared-types/tid.js';
import type { Context } from 'hono';
import type { SubConfig, SignalConfig } from '../core/config/types.js';
import type { SignalName } from '../core/signals/types.js';
import type { LogEntry } from '../core/dashboard/types.js';
import {
  loadConfig,
  saveConfig,
  getTopQueue,
  loadPostResult,
  loadBaseline,
  removeFromQueue,
  claimResolved,
  logOutcome,
  readLog,
} from '../core/engine/storage.js';
import { readAllTrends } from '../core/engine/trends.js';
import { defaultBaselines } from '../core/calibration/defaults.js';
import { PRESETS, type PresetName } from '../core/config/presets.js';
import { ruleToAutoModYaml, describeRule } from '../core/engine/rules.js';
import { validateRulePayload } from '../core/engine/rule-validate.js';
export const api = new Hono();

/**
 * Resolve the current subreddit from the platform-provided context.
 * Returns undefined (and the caller should 400) if it's somehow absent.
 */
function currentSub(): string | undefined {
  return context.subredditName;
}

/** Small helper to bail out consistently when context has no sub. */
function noSub(c: Context) {
  return c.json({ error: 'could not determine subreddit from context' }, 400);
}

/**
 * Resolve the acting mod's username from the platform-provided context for log
 * attribution. Falls back to 'unknown-mod' rather than failing the action —
 * accountability is best-effort; the dismiss/handoff itself must never break
 * just because identity wasn't resolvable.
 *
 * §9 must-verify #3: confirm the exact context field for the acting user on
 * /api/* requests in playtest. We read it defensively (the field may surface as
 * `username` or be nested) so the typed context surface staying lean doesn't
 * stop us from picking it up when present.
 */
function currentActor(): string {
  const ctx = context as unknown as Record<string, unknown>;
  const direct = ctx['username'] ?? ctx['userName'] ?? ctx['authorName'];
  if (typeof direct === 'string' && direct.length > 0) return direct;
  const user = ctx['user'];
  if (user && typeof user === 'object') {
    const uname = (user as Record<string, unknown>)['username'] ?? (user as Record<string, unknown>)['name'];
    if (typeof uname === 'string' && uname.length > 0) return uname;
  }
  return 'unknown-mod';
}

// ── queue reconciliation (Block 1 §4) ─────────────────────────────────────────

type PostState = 'actionable' | 'gone' | 'unknown';

interface ProbeResult {
  state: PostState;
  /** canonical permalink, when the live read gave us one (actionable case). */
  permalink?: string;
}

/**
 * Read a post's current state from Reddit so the queue can omit posts that are
 * no longer actionable (removed / spam / deleted / not-found). Also captures the
 * canonical permalink from the same read so the client never reconstructs a
 * fragile URL (§6).
 *
 * - `gone`: read says the post is removed/spam/deleted, or it can't be found
 *   (a thrown not-found error). No longer needs a mod decision → drop it.
 * - `actionable`: live, non-removed post → keep it.
 * - `unknown`: read failed for a transient reason (network/rate-limit). Treated
 *   as `actionable` by callers — we never drop a post because a read flaked
 *   (graceful degradation, §2). We can't distinguish "not found" from "network
 *   blip" without inspecting the error, so we keep the conservative default of
 *   NOT dropping on a thrown error; only an explicit removed/deleted flag on a
 *   successfully-read post drops it. (§9 must-verify #2 refines this in playtest.)
 */
async function probePostState(postId: string): Promise<ProbeResult> {
  // getPostById requires a T3 id. A queue member that isn't a valid T3 can't be
  // read, so treat it like a flaked read: 'unknown' → kept, never silently
  // dropped (§4.2 graceful degradation).
  if (!isT3(postId)) return { state: 'unknown' };
  try {
    const post = await reddit.getPostById(postId);
    if (!post) return { state: 'gone' };
    const p = post as unknown as Record<string, unknown>;
    const removed = p['removed'] === true || p['spam'] === true || p['isRemoved'] === true;
    const removedCategory = typeof p['removedByCategory'] === 'string' && p['removedByCategory'].length > 0;
    if (removed || removedCategory) return { state: 'gone' };
    const permalink = typeof post.permalink === 'string' && post.permalink.length > 0
      ? canonicalPermalink(post.permalink)
      : undefined;
    return permalink ? { state: 'actionable', permalink } : { state: 'actionable' };
  } catch {
    // Transient failure (or not-found we can't disambiguate). Conservative:
    // treat as actionable so a flaked read never silently loses a real item.
    return { state: 'unknown' };
  }
}

/**
 * Normalise whatever permalink shape the platform returns into a full
 * https://www.reddit.com/... URL. Reddit's `permalink` is typically a
 * site-relative path like `/r/<sub>/comments/<id>/slug/`; if it already carries
 * a scheme we leave it untouched.
 */
function canonicalPermalink(raw: string): string {
  if (/^https?:\/\//i.test(raw)) return raw;
  const path = raw.startsWith('/') ? raw : `/${raw}`;
  return `https://www.reddit.com${path}`;
}

/**
 * The idempotent resolution side effect for a post that reconciliation is
 * dropping. Gated on claimResolved() so repeated refreshes (by one mod or
 * several) write at most one "resolved on Reddit" log entry. Fire-and-forget at
 * the call site: a logging hiccup must not break queue hydration.
 */
async function resolveDropped(sub: string, postId: string): Promise<void> {
  await removeFromQueue(sub, postId);
  const firstClaim = await claimResolved(postId);
  if (!firstClaim) return; // already resolved in-app or by an earlier reconcile
  const stored = await loadPostResult(postId);
  await logOutcome(sub, {
    postId,
    outcome: 'actioned',
    actor: 'auto',
    scores: stored ? stored.scores : null,
    detail: 'resolved on Reddit',
  });
}

/**
 * Hydrate the top-N queue with reconciliation folded in. Probes each entry's
 * live state, keeps the actionable ones (attaching the fresh permalink), and
 * fires the idempotent resolution side effect for the dropped ones without
 * blocking the response.
 */
async function hydrateQueue(sub: string, n: number) {
  const top = await getTopQueue(sub, n);
  const probes = await Promise.all(top.map((e) => probePostState(e.postId)));

  const dropped: string[] = [];
  const kept: Array<{ postId: string; priority: number; permalink?: string }> = [];
  top.forEach((entry, i) => {
    const probe = probes[i] ?? { state: 'unknown' as PostState };
    if (probe.state === 'gone') {
      dropped.push(entry.postId);
    } else {
      kept.push(
        probe.permalink !== undefined
          ? { postId: entry.postId, priority: entry.priority, permalink: probe.permalink }
          : { postId: entry.postId, priority: entry.priority }
      );
    }
  });

  // fire-and-forget: clear resolved posts + log once; never blocks hydration.
  if (dropped.length > 0) {
    void Promise.all(dropped.map((postId) => resolveDropped(sub, postId))).catch((err) => {
      console.error('[aurameter] reconciliation side effect failed:', err);
    });
  }

  const queue = await Promise.all(
    kept.map(async (k) => {
      const result = await loadPostResult(k.postId);
      return k.permalink !== undefined
        ? { postId: k.postId, priority: k.priority, result, permalink: k.permalink }
        : { postId: k.postId, priority: k.priority, result };
    })
  );
  return queue;
}

api.get('/health', (c) => c.json({ ok: true, service: 'aurameter' }));

/**
 * returns everything the dashboard needs in one round trip:
 *   config, queue (top 20, reconciled), trends (14 days).
 * the client can refresh individual sections via their own endpoints.
 */
api.get('/dashboard', async (c) => {
  const sub = currentSub();
  if (!sub) return noSub(c);

  const trendDays = Number(c.req.query('days') ?? '14');
  const queueSize = Number(c.req.query('q') ?? '20');

  const [config, queue, trends] = await Promise.all([
    loadConfig(sub),
    hydrateQueue(sub, queueSize),
    readAllTrends(sub, trendDays),
  ]);

  if (!config) return c.json({ error: 'no config for sub' }, 404);

  return c.json({
    config,
    queue,
    trends,
    presets: presetMeta(),
  });
});

api.get('/config', async (c) => {
  const sub = currentSub();
  if (!sub) return noSub(c);
  const config = await loadConfig(sub);
  return c.json({ config, presets: presetMeta() });
});

api.post('/config/preset', async (c) => {
  const sub = currentSub();
  if (!sub) return noSub(c);
  const body = await c.req.json<{ preset?: string }>();
  if (!body.preset || !(body.preset in PRESETS)) {
    return c.json({ error: 'unknown preset' }, 400);
  }
  const config = PRESETS[body.preset as PresetName].config(sub);
  await saveConfig(config);
  void logOutcome(sub, {
    postId: null,
    outcome: 'config-change',
    actor: currentActor(),
    scores: null,
    detail: `applied preset "${body.preset}"`,
  }).catch((err) => console.error('[aurameter] config-change log failed:', err));
  return c.json({ ok: true, config });
});

/** patch top-level config fields (aggressiveness, observeOnly, rules, etc.) */
api.patch('/config', async (c) => {
  const sub = currentSub();
  if (!sub) return noSub(c);
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
  const changed = Object.keys(patch).filter((k) => k !== 'subreddit' && k !== 'installedAt');
  void logOutcome(sub, {
    postId: null,
    outcome: 'config-change',
    actor: currentActor(),
    scores: null,
    detail: changed.length > 0 ? `updated ${changed.join(', ')}` : 'updated config',
  }).catch((err) => console.error('[aurameter] config-change log failed:', err));
  return c.json({ ok: true, config: merged });
});

/** patch a single signal's config without touching the rest */
api.patch('/config/signal/:signal', async (c) => {
  const sub = currentSub();
  if (!sub) return noSub(c);
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
  void logOutcome(sub, {
    postId: null,
    outcome: 'config-change',
    actor: currentActor(),
    scores: null,
    detail: `changed ${signal} signal (${Object.keys(patch).join(', ') || 'config'})`,
  }).catch((err) => console.error('[aurameter] config-change log failed:', err));
  return c.json({ ok: true, signal, config: updated.signals[signal] });
});

/** add a custom automation rule (append to config.rules) */
api.post('/config/rule', async (c) => {
  const sub = currentSub();
  if (!sub) return noSub(c);

  const existing = await loadConfig(sub);
  if (!existing) return c.json({ error: 'no config for sub' }, 404);

  const raw = await c.req.json<unknown>().catch(() => null);
  const result = validateRulePayload(raw);
  if ('error' in result) return c.json({ error: result.error }, 400);

  const updated: SubConfig = {
    ...existing,
    rules: [...existing.rules, result.rule],
  };
  await saveConfig(updated);
  void logOutcome(sub, {
    postId: null,
    outcome: 'config-change',
    actor: currentActor(),
    scores: null,
    detail: `added rule "${result.rule.label}"`,
  }).catch((err) => console.error('[aurameter] config-change log failed:', err));
  return c.json({ ok: true, rule: result.rule, config: updated });
});

/** delete a custom automation rule by id */
api.delete('/config/rule/:id', async (c) => {
  const sub = currentSub();
  if (!sub) return noSub(c);

  const id = c.req.param('id');
  const existing = await loadConfig(sub);
  if (!existing) return c.json({ error: 'no config for sub' }, 404);

  const removedRule = existing.rules.find((r) => r.id === id);
  const rules = existing.rules.filter((r) => r.id !== id);
  if (rules.length === existing.rules.length) {
    return c.json({ error: 'rule not found' }, 404);
  }

  const updated: SubConfig = { ...existing, rules };
  await saveConfig(updated);
  void logOutcome(sub, {
    postId: null,
    outcome: 'config-change',
    actor: currentActor(),
    scores: null,
    detail: removedRule ? `deleted rule "${removedRule.label}"` : 'deleted a rule',
  }).catch((err) => console.error('[aurameter] config-change log failed:', err));
  return c.json({ ok: true, config: updated });
});

api.get('/queue', async (c) => {
  const sub = currentSub();
  if (!sub) return noSub(c);
  const n = Number(c.req.query('n') ?? '20');
  const queue = await hydrateQueue(sub, n);
  return c.json({ queue });
});

// ── dismiss / handoff (Block 1 §5) ────────────────────────────────────────────

/**
 * Dismiss a post from the queue — the safe, reversible, ~80% action. Removes it
 * from the worklist, marks it resolved (so reconciliation won't also log it),
 * and records an attributed `dismissed` entry with the scores at the time.
 */
api.post('/queue/dismiss', async (c) => {
  const sub = currentSub();
  if (!sub) return noSub(c);
  const body = await c.req.json<{ postId?: string }>().catch(() => ({} as { postId?: string }));
  const postId = body.postId;
  if (!postId) return c.json({ error: 'postId is required' }, 400);

  await removeFromQueue(sub, postId);
  await claimResolved(postId); // dashboard resolution shouldn't be reconciliation-logged
  const stored = await loadPostResult(postId);
  await logOutcome(sub, {
    postId,
    outcome: 'dismissed',
    actor: currentActor(),
    scores: stored ? stored.scores : null,
  });

  return c.json({ ok: true, postId });
});

/**
 * Hand a post off to Reddit's native mod UI — the deliberate escalation.
 * aurameter NEVER removes/bans itself (§1.1); it logs intent (`actioned`),
 * removes the post from the worklist immediately (the mod has declared intent;
 * if they bail in Reddit's UI, reconciliation simply won't find it removed next
 * time, and it's recoverable from the log), and returns the canonical permalink
 * for the client to open.
 */
api.post('/queue/handoff', async (c) => {
  const sub = currentSub();
  if (!sub) return noSub(c);
  const body = await c.req.json<{ postId?: string }>().catch(() => ({} as { postId?: string }));
  const postId = body.postId;
  if (!postId) return c.json({ error: 'postId is required' }, 400);

  // Capture the canonical permalink from a live read (same read reconciliation
  // does). Fall back to the canonical r/<sub>/comments/<id>/ shape if the read
  // doesn't surface one, so the client always gets a usable URL.
  const probe = await probePostState(postId);
  const permalink = probe.permalink ?? `https://www.reddit.com/r/${sub}/comments/${postId.replace('t3_', '')}/`;

  await claimResolved(postId);
  const stored = await loadPostResult(postId);
  await logOutcome(sub, {
    postId,
    outcome: 'actioned',
    actor: currentActor(),
    scores: stored ? stored.scores : null,
    detail: 'handed off to Reddit',
  });
  await removeFromQueue(sub, postId);

  return c.json({ ok: true, postId, permalink });
});

/**
 * Read the unified action log, newest-first. `limit` caps the page size;
 * `before` (a ts in ms) pages further back. This is the data behind the log tab
 * and the "N passed through in last 24h" line.
 */
api.get('/log', async (c) => {
  const sub = currentSub();
  if (!sub) return noSub(c);
  const limit = Math.max(1, Math.min(500, Number(c.req.query('limit') ?? '100')));
  const beforeRaw = c.req.query('before');
  const before = beforeRaw !== undefined ? Number(beforeRaw) : undefined;
  const entries: LogEntry[] = await readLog(
    sub,
    before !== undefined && Number.isFinite(before) ? { limit, before } : { limit }
  );
  return c.json({ entries });
});

api.get('/trends', async (c) => {
  const sub = currentSub();
  if (!sub) return noSub(c);
  const days = Math.max(1, Math.min(90, Number(c.req.query('days') ?? '14')));
  const trends = await readAllTrends(sub, days);
  return c.json({ trends });
});

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
api.get('/debug/baseline', async (c) => {
  const sub = currentSub();
  if (!sub) return noSub(c);
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


api.get('/config/automod', async (c) => {
  const sub = currentSub();
  if (!sub) return noSub(c);
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

function presetMeta() {
  return Object.entries(PRESETS).map(([name, p]) => ({
    name,
    label: p.name,
    description: p.description,
  }));
}