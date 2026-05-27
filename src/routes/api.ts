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
 *   GET   /api/spotcheck              current spot-check batch (Block 2)
 *   POST  /api/spotcheck/verdict      record an AI / not-AI label (Block 2)
 *   POST  /api/spotcheck/optin        opt in/out + cadence (Block 2)
 *   POST  /api/spotcheck/reset        reset this sub's slop threshold (Block 2)
 *   GET   /api/corpus/export          guarded JSONL training-data tap (Block 2 / CI)
 */

import { Hono } from 'hono';
import { context, reddit } from '@devvit/web/server';
import { isT3 } from '@devvit/shared-types/tid.js';
import type { Context } from 'hono';
import type { SubConfig, SignalConfig, SlopSpotCheckConfig, RuleCondition } from '../core/config/types.js';
import type { SignalName } from '../core/signals/types.js';
import type { LogEntry } from '../core/dashboard/types.js';
import {
  loadConfig,
  saveConfig,
  getTopQueue,
  loadPostResult,
  loadBaseline,
  loadSlopFeatures,
  removeFromQueue,
  claimResolved,
  logOutcome,
  readLog,
} from '../core/engine/storage.js';
import { readAllTrends } from '../core/engine/trends.js';
import { defaultBaselines } from '../core/calibration/defaults.js';
import { PRESETS, type PresetName } from '../core/config/presets.js';
import { ruleToAutoModYaml, describeRule, evaluateConditionsAgainstScores } from '../core/engine/rules.js';
import { validateRulePayload } from '../core/engine/rule-validate.js';
import {
  selectSpotCheckBatch,
  enqueueSpotCheckBatch,
  readSpotCheckQueue,
  recordSpotCheckVerdict,
  resetSlopThreshold,
  OPTIN_BATCH,
  RESET_BATCH,
  type SpotCheckCandidate,
} from '../core/engine/spotcheck.js';
import { exportCorpusJsonl } from '../core/engine/corpus.js';
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
 */
/**
 * Reddit `removedByCategory` values that mean a post is TERMINALLY resolved —
 * a human/admin/author decision that takes it out of triage for good. Any OTHER
 * non-empty category (notably 'automod_filtered' and 'reports') means the post
 * was FILTERED INTO the modqueue and is awaiting review — i.e. exactly what
 * belongs in aurameter's queue, NOT gone.
 *
 * This distinction matters because aurameter's own `send_to_modqueue` rule
 * calls reddit.report(), which makes Reddit populate removedByCategory with a
 * queue-pending value. Treating any non-empty category as "gone" (the old
 * behaviour) made reconciliation drop every post aurameter had just queued —
 * the post would score, fire the rule, get added to the queue, then vanish on
 * the next hydrate. Pending categories must be KEPT.
 */
const TERMINAL_REMOVED_CATEGORIES: ReadonlySet<string> = new Set([
  'moderator',
  'deleted',
  'author',
  'content_takedown',
  'copyright_takedown',
  'reddit',
  'admin',
]);

async function probePostState(postId: string): Promise<ProbeResult> {
  if (!isT3(postId)) return { state: 'unknown' };
  try {
    const post = await reddit.getPostById(postId);
    if (!post) return { state: 'gone' };
    const p = post as unknown as Record<string, unknown>;

    // A post sitting in the modqueue (filtered/reported, awaiting review) is the
    // OPPOSITE of gone — it's the whole reason the queue exists. Only treat the
    // post as gone when removedByCategory is an explicit TERMINAL value (a human
    // mod/admin/author already resolved it). Unknown/empty category -> fall
    // through to the boolean flags below.
    const category = typeof p['removedByCategory'] === 'string' ? (p['removedByCategory'] as string) : '';
    if (category && TERMINAL_REMOVED_CATEGORIES.has(category)) {
      return { state: 'gone' };
    }
    // If a queue-pending category is present, the post is explicitly still in
    // triage — keep it, and don't let the (sometimes co-set) removed/spam flags
    // below false-drop it.
    const queuePending = category !== '' && !TERMINAL_REMOVED_CATEGORIES.has(category);
    if (!queuePending) {
      const removed = p['removed'] === true || p['spam'] === true || p['isRemoved'] === true;
      if (removed) return { state: 'gone' };
    }

    const permalink = typeof post.permalink === 'string' && post.permalink.length > 0
      ? canonicalPermalink(post.permalink)
      : undefined;
    return permalink ? { state: 'actionable', permalink } : { state: 'actionable' };
  } catch {
    return { state: 'unknown' };
  }
}

/**
 * Normalise whatever permalink shape the platform returns into a full
 * https://www.reddit.com/... URL.
 */
function canonicalPermalink(raw: string): string {
  if (/^https?:\/\//i.test(raw)) return raw;
  const path = raw.startsWith('/') ? raw : `/${raw}`;
  return `https://www.reddit.com${path}`;
}

/**
 * The idempotent resolution side effect for a post that reconciliation is
 * dropping. Gated on claimResolved() so repeated refreshes write at most one
 * "resolved on Reddit" log entry.
 */
async function resolveDropped(sub: string, postId: string): Promise<void> {
  await removeFromQueue(sub, postId);
  const firstClaim = await claimResolved(postId);
  if (!firstClaim) return;
  const stored = await loadPostResult(postId);
  await logOutcome(sub, {
    postId,
    outcome: 'actioned',
    actor: 'auto',
    scores: stored ? stored.scores : null,
    detail: 'resolved on Reddit',
    ...(stored?.title ? { title: stored.title } : {}),
  });
}

/**
 * Hydrate the top-N queue with reconciliation folded in.
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

api.patch('/config', async (c) => {
  const sub = currentSub();
  if (!sub) return noSub(c);
  const existing = await loadConfig(sub);
  if (!existing) return c.json({ error: 'no config for sub' }, 404);
  const patch = await c.req.json<Partial<SubConfig>>();
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

// ── per-rule dry-run preview (Block 3) ────────────────────────────────────────
//
// "This rule would have fired on N posts in the last 7 days." Replays a
// CANDIDATE rule (not necessarily saved) over the action log — which already
// carries {postId, scores, ts, title} on every scored post (passed-through +
// rule-fired entries cover every post). No new storage, no per-post reads, no
// key enumeration (Devvit has no redis.keys()). Pure evaluator shared with the
// live rule engine via evaluateConditionsAgainstScores, so preview and reality
// can't diverge.

const DRYRUN_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const DRYRUN_SAMPLE_CAP = 20;
const DRYRUN_BROAD_THRESHOLD = 100;

api.post('/rules/dryrun', async (c) => {
  const sub = currentSub();
  if (!sub) return noSub(c);

  const body = await c.req.json<{ conditions?: unknown }>().catch(() => ({} as { conditions?: unknown }));
  const conditions = body.conditions;
  if (!Array.isArray(conditions) || conditions.length === 0) {
    return c.json({ error: 'conditions (1–3) are required' }, 400);
  }

  // Pull a generous log slice; keep only the last 7 days of post-bearing,
  // scored entries (passed-through / rule-fired and any other entry that
  // carries a postId + scores). Dedup by postId — a post can appear multiple
  // times (rule-fired then dismissed); keep the first scored sighting.
  const cutoff = Date.now() - DRYRUN_WINDOW_MS;
  const entries = await readLog(sub, { limit: 1000 });

  const seen = new Set<string>();
  let count = 0;
  const sample: Array<{ postId: string; scores: Record<SignalName, number>; title?: string; ts: number }> = [];

  for (const e of entries) {
    if (e.ts < cutoff) continue;
    if (!e.postId || !e.scores) continue;
    if (seen.has(e.postId)) continue;
    seen.add(e.postId);

    if (evaluateConditionsAgainstScores(conditions as RuleCondition[], e.scores)) {
      count++;
      if (sample.length < DRYRUN_SAMPLE_CAP) {
        sample.push(
          e.title
            ? { postId: e.postId, scores: e.scores, title: e.title, ts: e.ts }
            : { postId: e.postId, scores: e.scores, ts: e.ts }
        );
      }
    }
  }

  return c.json({
    count,
    tooBroad: count > DRYRUN_BROAD_THRESHOLD,
    sampleCap: DRYRUN_SAMPLE_CAP,
    windowDays: 7,
    poolSize: seen.size,
    sample,
  });
});

api.get('/queue', async (c) => {
  const sub = currentSub();
  if (!sub) return noSub(c);
  const n = Number(c.req.query('n') ?? '20');
  const queue = await hydrateQueue(sub, n);
  return c.json({ queue });
});

// ── dismiss / handoff (Block 1 §5) ────────────────────────────────────────────

api.post('/queue/dismiss', async (c) => {
  const sub = currentSub();
  if (!sub) return noSub(c);
  const body = await c.req.json<{ postId?: string }>().catch(() => ({} as { postId?: string }));
  const postId = body.postId;
  if (!postId) return c.json({ error: 'postId is required' }, 400);

  await removeFromQueue(sub, postId);
  await claimResolved(postId);
  const stored = await loadPostResult(postId);
  await logOutcome(sub, {
    postId,
    outcome: 'dismissed',
    actor: currentActor(),
    scores: stored ? stored.scores : null,
    ...(stored?.title ? { title: stored.title } : {}),
  });

  return c.json({ ok: true, postId });
});

api.post('/queue/handoff', async (c) => {
  const sub = currentSub();
  if (!sub) return noSub(c);
  const body = await c.req.json<{ postId?: string }>().catch(() => ({} as { postId?: string }));
  const postId = body.postId;
  if (!postId) return c.json({ error: 'postId is required' }, 400);

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
    ...(stored?.title ? { title: stored.title } : {}),
  });
  await removeFromQueue(sub, postId);

  return c.json({ ok: true, postId, permalink });
});

// ── spot-check (Block 2 Tasks 5–7) ────────────────────────────────────────────

/**
 * Build spot-check candidates from the sub's current triage queue: those are
 * the flagged posts, exactly the pool to sample. Each candidate's continuous
 * reading is the persisted slop `probability` (Task 3); its discrete score is
 * the stored slop score. Posts without persisted features are skipped (no
 * continuous reading to rank on).
 */
async function buildSpotCheckCandidates(sub: string): Promise<SpotCheckCandidate[]> {
  const top = await getTopQueue(sub, 100);
  const candidates: SpotCheckCandidate[] = [];
  for (const { postId } of top) {
    const features = await loadSlopFeatures(postId);
    const stored = await loadPostResult(postId);
    if (!features) continue;
    const probability = features['probability'];
    if (typeof probability !== 'number' || !isFinite(probability)) continue;
    const score = stored?.scores?.slop ?? 0;
    candidates.push({ postId, score, composite01: probability });
  }
  return candidates;
}

/** GET current spot-check batch, hydrated with permalinks + stored scores. */
api.get('/spotcheck', async (c) => {
  const sub = currentSub();
  if (!sub) return noSub(c);
  const config = await loadConfig(sub);
  const optedIn = config?.slopSpotCheck?.enabled ?? false;

  const postIds = await readSpotCheckQueue(sub, OPTIN_BATCH);
  const items = await Promise.all(
    postIds.map(async (postId) => {
      const [probe, result] = await Promise.all([probePostState(postId), loadPostResult(postId)]);
      return probe.permalink !== undefined
        ? { postId, result, permalink: probe.permalink }
        : { postId, result };
    })
  );
  return c.json({
    optedIn,
    cadence: config?.slopSpotCheck?.cadence ?? 'weekly',
    batch: items,
  });
});

/** POST a verdict: record the label, feed the baseline, drop from the queue. */
api.post('/spotcheck/verdict', async (c) => {
  const sub = currentSub();
  if (!sub) return noSub(c);
  const body = await c.req.json<{ postId?: string; label?: number }>().catch(() => ({} as { postId?: string; label?: number }));
  const postId = body.postId;
  const label = body.label;
  if (!postId) return c.json({ error: 'postId is required' }, 400);
  if (label !== 0 && label !== 1) return c.json({ error: 'label must be 0 or 1' }, 400);

  const appended = await recordSpotCheckVerdict(sub, postId, label);
  return c.json({ ok: true, postId, appended });
});

/** POST opt-in/out + cadence. On enable, select + enqueue an opt-in batch. */
api.post('/spotcheck/optin', async (c) => {
  const sub = currentSub();
  if (!sub) return noSub(c);
  const existing = await loadConfig(sub);
  if (!existing) return c.json({ error: 'no config for sub' }, 404);

  const body = await c.req.json<{ enabled?: boolean; cadence?: 'weekly' | 'monthly' }>().catch(() => ({} as { enabled?: boolean; cadence?: 'weekly' | 'monthly' }));
  const enabled = body.enabled ?? false;
  const cadence: 'weekly' | 'monthly' = body.cadence === 'monthly' ? 'monthly' : 'weekly';

  let enqueued = 0;
  if (enabled) {
    const candidates = await buildSpotCheckCandidates(sub);
    const batch = selectSpotCheckBatch(candidates, { size: OPTIN_BATCH });
    await enqueueSpotCheckBatch(sub, batch);
    enqueued = batch.length;
  }

  const slopSpotCheck: SlopSpotCheckConfig = {
    enabled,
    cadence,
    lastBatchAt: enabled ? Date.now() : (existing.slopSpotCheck?.lastBatchAt ?? 0),
  };
  const updated: SubConfig = { ...existing, slopSpotCheck };
  await saveConfig(updated);

  void logOutcome(sub, {
    postId: null,
    outcome: 'config-change',
    actor: currentActor(),
    scores: null,
    detail: enabled ? `spot-check opt-in (${cadence}), ${enqueued} queued` : 'spot-check opt-out',
  }).catch((err) => console.error('[aurameter] config-change log failed:', err));

  return c.json({ ok: true, config: updated, enqueued });
});

/** POST reset: clear this sub's learned slop baseline + enqueue a reset batch. */
api.post('/spotcheck/reset', async (c) => {
  const sub = currentSub();
  if (!sub) return noSub(c);

  await resetSlopThreshold(sub);
  const candidates = await buildSpotCheckCandidates(sub);
  const batch = selectSpotCheckBatch(candidates, { size: RESET_BATCH });
  await enqueueSpotCheckBatch(sub, batch);

  void logOutcome(sub, {
    postId: null,
    outcome: 'config-change',
    actor: currentActor(),
    scores: null,
    detail: `reset slop threshold to global default, ${batch.length} queued`,
  }).catch((err) => console.error('[aurameter] config-change log failed:', err));

  return c.json({ ok: true, enqueued: batch.length });
});

// ── corpus export (Block 2 Task 9, CI tap) ────────────────────────────────────

/**
 * Guarded JSONL export of the global Slop corpus, consumed by the offline CI
 * retrain workflow (tools/slop-trainer), NOT by the dashboard. Guarded by a
 * shared secret header: set CORPUS_EXPORT_SECRET in the app's environment and
 * have CI send it as `x-corpus-export-secret`. If the secret isn't configured,
 * the endpoint is closed (403) — fail safe, since this is the training-data tap.
 */
api.get('/corpus/export', async (c) => {
  const secret = (context as unknown as Record<string, unknown>)['CORPUS_EXPORT_SECRET'];
  const expected = typeof secret === 'string' ? secret : process.env['CORPUS_EXPORT_SECRET'];
  if (!expected) return c.json({ error: 'export not configured' }, 403);
  const provided = c.req.header('x-corpus-export-secret');
  if (provided !== expected) return c.json({ error: 'forbidden' }, 403);

  const jsonl = await exportCorpusJsonl();
  return c.body(jsonl, 200, { 'content-type': 'application/x-ndjson' });
});

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

api.get('/debug/post/:postId', async (c) => {
  const postId = c.req.param('postId');
  const result = await loadPostResult(postId);
  if (!result) return c.json({ error: 'post not found' }, 404);
  return c.json({ result });
});

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
