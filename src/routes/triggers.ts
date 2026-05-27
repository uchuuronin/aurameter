/**
 * trigger handlers. mounted at /internal/triggers in src/index.ts.
 *
 *   onAppInstall      : seed a default subconfig + register in install index
 *   onPostSubmit      : score the post, set flair, evaluate rules
 *   onPostDelete      : purge cached features (deletion compliance)
 *   onCommentDelete   : no-op (reserved for comment-heat lens)
 *
 * onPostSubmit self-heals: if no config exists when a post arrives, it seeds
 * one inline. that way an app installed before onAppInstall was wired up,
 * or any sub where the install trigger silently missed, still gets bootstrapped
 * on the next post submission.
 */

import { Hono } from 'hono';
import { reddit, context } from '@devvit/web/server';
import type {
  OnAppInstallRequest,
  OnPostSubmitRequest,
  OnPostDeleteRequest,
  OnCommentDeleteRequest,
  TriggerResponse,
} from '@devvit/web/shared';
import { isT3 } from '@devvit/shared-types/tid.js';
import type { T3 } from '@devvit/shared-types/tid.js';

import { scorePost, applyAggressiveness } from '../core/engine/score.js';
import { composeFlair } from '../core/engine/flair.js';
import { evaluateRules } from '../core/engine/rules.js';
import {
  loadConfig,
  saveConfig,
  savePostResult,
  addToQueue,
  computePriority,
  recordDailyAggregate,
  recordSamples,
  saveSlopFeatures,
  loadBaselines,
  purgePostData,
  registerInstall,
  logOutcome,
  claimResolved,
} from '../core/engine/storage.js';
import { PRESETS, suggestPreset } from '../core/config/presets.js';
import type { PostInput, SignalName } from '../core/signals/types.js';
import type { RuleAction, RuleCondition, SubConfig } from '../core/config/types.js';
import { appendVerdict, classifyModAction } from '../core/engine/corpus.js';
import type { QueueReason } from '../core/engine/corpus.js';
import type { RuleMatch } from '../core/engine/rules.js';

export const triggers = new Hono();

/**
 * Seed a config for a sub. Idempotent — caller checks for existing config first.
 * Returns the seeded config. Used by both onAppInstall and the lazy path in
 * onPostSubmit.
 */
async function seedConfig(sub: string): Promise<SubConfig> {
  await registerInstall(sub);
  const presetName = suggestPreset(sub);
  const preset = PRESETS[presetName];
  const config = preset.config(sub);
  await saveConfig(config);
  console.log(`[aurameter] seeded ${sub} with preset "${presetName}", observe-only mode`);
  return config;
}

/**
 * Build the queue reason (Block 2 Task 1) from the rules that matched a post.
 * A post can match multiple rules; we record the UNION of their conditions so
 * corpus.ts::wasQueuedOnSlop can check whether ANY was a Slop condition. The
 * ruleId is the first match's id (debugging/attribution only — the purity
 * decision is made on the conditions, not the id).
 */
function buildQueueReason(matches: RuleMatch[]): QueueReason | undefined {
  if (matches.length === 0) return undefined;
  const conditions: RuleCondition[] = [];
  for (const match of matches) {
    conditions.push(...match.rule.conditions);
  }
  return { ruleId: matches[0]!.rule.id, conditions };
}

/** Defensive payload read: first string-valued field among `names`. */
function pickString(obj: Record<string, unknown>, names: string[]): string | undefined {
  for (const n of names) {
    const v = obj[n];
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return undefined;
}

/** Defensive nested read: obj[outer] is an object; first string field among `names`. */
function pickNestedString(
  obj: Record<string, unknown>,
  outer: string,
  names: string[],
): string | undefined {
  const inner = obj[outer];
  if (inner && typeof inner === 'object') {
    return pickString(inner as Record<string, unknown>, names);
  }
  return undefined;
}

// onAppInstall
triggers.post('/on-app-install', async (c) => {
  console.log('[aurameter] onAppInstall trigger fired');
  const input = await c.req.json<OnAppInstallRequest>();
  const sub = input.subreddit?.name;
  if (!sub) {
    console.warn('[aurameter] onAppInstall fired without subreddit name');
    return c.json<TriggerResponse>({});
  }

  await registerInstall(sub);

  const existing = await loadConfig(sub);
  if (existing) {
    console.log(`[aurameter] install trigger on ${sub} but config already exists; skipping seed`);
    return c.json<TriggerResponse>({});
  }

  await seedConfig(sub);
  return c.json<TriggerResponse>({});
});

// onPostSubmit
triggers.post('/on-post-submit', async (c) => {
  const input = await c.req.json<OnPostSubmitRequest>();
  const post = input.post;
  if (!post) {
    console.log('[aurameter] onPostSubmit: no post in payload');
    return c.json<TriggerResponse>({});
  }

  const sub = input.subreddit?.name ?? context.subredditName;
  if (!sub) {
    console.log('[aurameter] onPostSubmit: could not determine subreddit');
    return c.json<TriggerResponse>({});
  }

  // Self-heal: if no config exists, seed one now. This covers apps installed
  // before onAppInstall was wired up, missed-event situations, and lets us
  // recover without requiring an uninstall+reinstall cycle.
  let config = await loadConfig(sub);
  if (!config) {
    console.warn(`[aurameter] no config for ${sub} at post-submit time — seeding lazily`);
    config = await seedConfig(sub);
  }

  // auto-flip out of observe mode after 7 days
  const observeWindowMs = 7 * 24 * 60 * 60 * 1000;
  if (config.observeOnly && Date.now() - config.installedAt > observeWindowMs) {
    config.observeOnly = false;
    await saveConfig(config);
    console.log(`[aurameter] ${sub}: auto-flipped out of observe mode after 7 days`);
  }

  if (!isT3(post.id)) {
    console.warn(`[aurameter] onPostSubmit: post.id is not a valid T3: ${post.id}`);
    return c.json<TriggerResponse>({});
  }
  const postId: T3 = post.id;

  const postInput: PostInput = {
    postId,
    subreddit: sub,
    title: post.title ?? '',
    body: (post as { selftext?: string; body?: string }).selftext ?? (post as { body?: string }).body ?? '',
  };

  if (!postInput.body || postInput.body.length < 30) {
    console.log(`[aurameter] ${sub}/${postId}: body too short (${postInput.body.length} chars), skipping`);
    return c.json<TriggerResponse>({});
  }

  // hot path: one redis read to get all four baselines
  const baselines = await loadBaselines(sub);

  // 1. score — calibration-aware, uses baselines (falls back to defaults if null)
  const rawResults = scorePost(postInput, config, baselines);
  const results = applyAggressiveness(rawResults, config);

  // snapshot the integer scores once; reused by the log writes below.
  const scoreSnapshot = {
    tea: results.tea.score,
    time: results.time.score,
    clown: results.clown.score,
    slop: results.slop.score,
  } as Record<SignalName, number>;

  // Build a one-line score summary for the playtest log so we can see scores
  // without opening the dashboard.
  const scoreSummary = (['tea', 'time', 'clown', 'slop'] as SignalName[])
    .map((s) => `${s}=${results[s].score}`)
    .join(' ');

  // 2. persist results + record samples for next nightly rollup. These feed
  //    trends/calibration and the per-post drilldown regardless of whether the
  //    post ends up queued, so they always run.
  await savePostResult(postId, sub, results);
  const priority = computePriority(results);
  await recordDailyAggregate(sub, postId, results);

  // fire-and-forget: sample recording failures don't block the response
  recordSamples(sub, postId, rawResults).catch((err) => {
    console.error('[aurameter] recordSamples failed:', err);
  });

  // Block 2 Task 3: persist the raw Slop feature components so a later mod
  // verdict on this post can rebuild the canonical training vector and harvest
  // it into the corpus. Uses PRE-aggressiveness rawResults (aggressiveness only
  // touches .score, not .rawFeatures), matching recordSamples.
  //
  // AWAITED (not fire-and-forget): this is a harvest PRECONDITION. appendVerdict
  // skips any post with no stored features, so if a mod removes a post before
  // this write lands, the verdict is silently lost. The write is one hSet — cheap
  // enough to await on the scoring path to guarantee it's durable before the post
  // can be acted on.
  try {
    await saveSlopFeatures(postId, rawResults.slop.rawFeatures);
  } catch (err) {
    console.error('[aurameter] saveSlopFeatures failed:', err);
  }

  // 3. Public flair is the ONLY thing observe-only suppresses. Everything else
  //    — scoring, rule evaluation, queue/log routing, the dashboard preview —
  //    runs identically to live mode. Observe-only governs aurameter's
  //    automatic, *community-facing* output, not whether the queue works or
  //    whether mods can act. (project-plan §6.7: "the dashboard shows what
  //    would have happened" — so the queue/log populate for real; only the
  //    public post stays untouched.)
  const mode = config.observeOnly ? 'observe-only' : 'LIVE';
  console.log(`[aurameter] ${sub}/${postId}: scored [${scoreSummary}] priority=${priority} (${mode})`);

  // 4. set flair — skipped entirely in observe-only (the one public-facing effect).
  if (!config.observeOnly) {
    const flairText = composeFlair(results, config);
    if (flairText) {
      try {
        await reddit.setPostFlair({ subredditName: sub, postId, text: flairText });
        console.log(`[aurameter] ${sub}/${postId}: set flair "${flairText}"`);
      } catch (err) {
        console.error(`[aurameter] setPostFlair failed for ${postId}:`, err);
      }
    }
  }

  // 5. evaluate automation rules. Routing is identical in both modes:
  //    at least one rule matches → queued for a human + logged rule-fired;
  //    nothing matches → a passed-through log entry, NOT queued.
  //    A post lands in exactly one place, never both (§1.2 line 31) — which is
  //    what stops the "passed-through post also sits in the queue and can then
  //    be actioned a second time" double-count, in either mode.
  const matches = evaluateRules(results, config);

  if (matches.length === 0) {
    void logOutcome(sub, {
      postId,
      outcome: 'passed-through',
      actor: 'auto',
      scores: scoreSnapshot,
    }).catch((err) => console.error('[aurameter] passed-through log failed:', err));
    return c.json<TriggerResponse>({});
  }

  // At least one rule matched → this post needs a human. Queue it once (in both
  // modes, so observe-only is a working triage preview), recording WHY it was
  // queued (Block 2 purity filter: the union of fired conditions), then handle
  // each match.
  const queueReason = buildQueueReason(matches);
  await addToQueue(sub, postId, priority, queueReason);

  for (const match of matches) {
    try {
      // In observe-only we DON'T execute the rule's automated side effect — we
      // record that it would have fired. The post is in the queue and a mod can
      // still Dismiss / Take-action manually; what's withheld is only
      // aurameter's *own* automatic action (and, for set_flair, any public
      // flair). In live mode we execute for real.
      if (config.observeOnly) {
        void logOutcome(sub, {
          postId,
          outcome: 'rule-fired',
          actor: 'auto',
          scores: scoreSnapshot,
          detail: `would fire: ${match.rule.label}`,
        }).catch((err) => console.error('[aurameter] rule-fired log failed:', err));
        continue;
      }
      await executeAction(sub, postId, match.action);
      console.log(`[aurameter] ${sub}/${postId}: fired rule "${match.rule.label}"`);
      void logOutcome(sub, {
        postId,
        outcome: 'rule-fired',
        actor: 'auto',
        scores: scoreSnapshot,
        detail: match.rule.label,
      }).catch((err) => console.error('[aurameter] rule-fired log failed:', err));
    } catch (err) {
      console.error(`[aurameter] rule "${match.rule.label}" action failed:`, err);
    }
  }

  return c.json<TriggerResponse>({});
});

async function executeAction(sub: string, postId: T3, action: RuleAction): Promise<void> {
  switch (action.type) {
    case 'send_to_modqueue': {
      const post = await reddit.getPostById(postId);
      await reddit.report(post, { reason: action.reason });
      break;
    }
    case 'set_flair':
      await reddit.setPostFlair({ subredditName: sub, postId, text: action.flairText });
      break;
    case 'ping_modmail':
      await reddit.modMail.createModInboxConversation({
        subredditId: context.subredditId,
        subject: action.subject,
        bodyMarkdown: action.body,
      });
      break;
    case 'require_manual_review': {
      const post = await reddit.getPostById(postId);
      await reddit.report(post, { reason: 'aurameter: requires manual review' });
      break;
    }
  }
}

// onPostDelete
triggers.post('/on-post-delete', async (c) => {
  const input = await c.req.json<OnPostDeleteRequest>();
  const postId = input.postId;
  if (!postId || !isT3(postId)) return c.json<TriggerResponse>({});

  // Block 2 Task 4: a removal/deletion is an ai-positive verdict for the Slop
  // corpus. Harvest BEFORE purging the post data, and dedupe against the shared
  // resolution marker so a remove isn't double-counted by both onPostDelete and
  // onModAction. claimResolved returns true only for the first caller.
  try {
    const firstClaim = await claimResolved(postId);
    // TEMP DEBUG: on-post-delete is the fallback harvest path for removals.
    console.log(`[harvest] on-post-delete: post=${postId} claimResolved(first)=${firstClaim}`);
    if (firstClaim) {
      // purity gate inside appendVerdict decides eligibility (slop-queued only).
      await appendVerdict({ postId, label: 1, source: 'passive' });
    } else {
      console.log(`[harvest]   SKIP harvest: marker already claimed (handoff or onModAction beat us)`);
    }
  } catch (err) {
    console.error('[aurameter] onPostDelete verdict harvest failed:', err);
  }

  await purgePostData(postId);
  console.log(`[aurameter] purged data for deleted post ${postId}`);
  return c.json<TriggerResponse>({});
});

// onModAction (Block 2 Task 4) — passive verdict capture.
//
// OPEN PLATFORM QUESTION (plan): whether Devvit fires this for `approvelink`
// and the exact payload shape are confirmed only in playtest. We therefore read
// the payload DEFENSIVELY: pull the action type and target post id from several
// plausible field names, classify with the pure classifyModAction, and harvest.
// If approvals turn out not to fire, removals still arrive via onPostDelete and
// spot-check supplies negatives — the loop degrades gracefully (plan fallback).
//
// Dedupe: a removal seen here AND by onPostDelete must count once. We gate the
// positive path on claimResolved (same marker onPostDelete uses). Approvals are
// NOT resolutions (the post stays up), so they don't claim the marker.
triggers.post('/on-mod-action', async (c) => {
  const input = (await c.req.json<unknown>().catch(() => null)) as Record<string, unknown> | null;
  // TEMP DEBUG: unconditional — proves whether Devvit routes mod actions here at all.
  console.log(`[harvest] on-mod-action FIRED. payload keys: ${input ? Object.keys(input).join(',') : '(none)'}`);
  if (!input) return c.json<TriggerResponse>({});

  // action type — try the common field names.
  const action =
    pickString(input, ['action', 'moderationAction', 'actionType', 'type']) ?? '';
  const verdict = classifyModAction(action);
  console.log(`[harvest]   action="${action}" -> verdict=${verdict}`);
  if (verdict === 'ignore') return c.json<TriggerResponse>({});

  // target post id — try the common field names + a nested target object.
  const postId =
    pickString(input, ['targetId', 'targetPostId', 'postId']) ??
    pickNestedString(input, 'target', ['id', 'postId']) ??
    pickNestedString(input, 'targetPost', ['id', 'postId']);
  console.log(`[harvest]   resolved postId=${postId ?? '(none)'}`);
  if (!postId || !isT3(postId)) return c.json<TriggerResponse>({});

  try {
    if (verdict === 'ai-positive') {
      // a removal/spam: dedupe against onPostDelete via the resolution marker.
      const firstClaim = await claimResolved(postId);
      if (firstClaim) {
        await appendVerdict({ postId, label: 1, source: 'passive' });
      }
    } else {
      // non-ai-negative (approve): the post stays up, so this is NOT a
      // resolution — don't claim the marker. Purity gate inside appendVerdict
      // still requires the post to have been slop-queued.
      await appendVerdict({ postId, label: 0, source: 'passive' });
    }
  } catch (err) {
    console.error('[aurameter] onModAction verdict harvest failed:', err);
  }

  return c.json<TriggerResponse>({});
});

// onCommentDelete
triggers.post('/on-comment-delete', async (c) => {
  await c.req.json<OnCommentDeleteRequest>();
  return c.json<TriggerResponse>({});
});