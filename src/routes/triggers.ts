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
  loadBaselines,
  purgePostData,
  registerInstall,
} from '../core/engine/storage.js';
import { PRESETS, suggestPreset } from '../core/config/presets.js';
import type { PostInput, SignalName } from '../core/signals/types.js';
import type { RuleAction, SubConfig } from '../core/config/types.js';

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

  // Build a one-line score summary for the playtest log so we can see scores
  // without opening the dashboard.
  const scoreSummary = (['tea', 'time', 'clown', 'slop'] as SignalName[])
    .map((s) => `${s}=${results[s].score}`)
    .join(' ');

  // 2. persist results + record samples for next nightly rollup
  await savePostResult(postId, sub, results);
  const priority = computePriority(results);
  await addToQueue(sub, postId, priority);
  await recordDailyAggregate(sub, postId, results);

  // fire-and-forget: sample recording failures don't block the response
  recordSamples(sub, postId, rawResults).catch((err) => {
    console.error('[aurameter] recordSamples failed:', err);
  });

  // 3. observe-only: stop here
  if (config.observeOnly) {
    console.log(`[aurameter] ${sub}/${postId}: scored [${scoreSummary}] priority=${priority} (observe-only)`);
    return c.json<TriggerResponse>({});
  }

  console.log(`[aurameter] ${sub}/${postId}: scored [${scoreSummary}] priority=${priority} (LIVE)`);

  // 4. set flair
  const flairText = composeFlair(results, config);
  if (flairText) {
    try {
      await reddit.setPostFlair({ subredditName: sub, postId, text: flairText });
      console.log(`[aurameter] ${sub}/${postId}: set flair "${flairText}"`);
    } catch (err) {
      console.error(`[aurameter] setPostFlair failed for ${postId}:`, err);
    }
  }

  // 5. evaluate automation rules
  const matches = evaluateRules(results, config);
  for (const match of matches) {
    try {
      await executeAction(sub, postId, match.action);
      console.log(`[aurameter] ${sub}/${postId}: fired rule "${match.rule.label}"`);
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
  await purgePostData(postId);
  console.log(`[aurameter] purged data for deleted post ${postId}`);
  return c.json<TriggerResponse>({});
});

// onCommentDelete
triggers.post('/on-comment-delete', async (c) => {
  await c.req.json<OnCommentDeleteRequest>();
  return c.json<TriggerResponse>({});
});
