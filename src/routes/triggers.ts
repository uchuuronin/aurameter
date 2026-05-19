/**
 * trigger handlers. mounted at /internal/triggers in src/index.ts.
 *
 *   onAppInstall      : seed a default subconfig for the new subreddit
 *   onPostSubmit      : score the post, set flair, evaluate rules
 *   onPostDelete      : purge cached features (deletion compliance)
 *   onCommentDelete   : no-op (reserved for comment-heat lens)
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
} from '../core/engine/storage.js';
import { PRESETS, suggestPreset } from '../core/config/presets.js';
import type { PostInput } from '../core/signals/types.js';
import type { RuleAction } from '../core/config/types.js';

export const triggers = new Hono();

// onAppInstall
triggers.post('/on-app-install', async (c) => {
  const input = await c.req.json<OnAppInstallRequest>();
  const sub = input.subreddit?.name;
  if (!sub) {
    console.warn('[aurameter] onAppInstall fired without subreddit name');
    return c.json<TriggerResponse>({ status: 'success' }, 200);
  }

  const existing = await loadConfig(sub);
  if (existing) {
    console.log(`[aurameter] install trigger on ${sub} but config already exists; skipping seed`);
    return c.json<TriggerResponse>({ status: 'success' }, 200);
  }

  const presetName = suggestPreset(sub);
  const preset = PRESETS[presetName];
  const config = preset.config(sub);
  await saveConfig(config);
  console.log(`[aurameter] seeded ${sub} with preset "${presetName}", observe-only mode`);

  return c.json<TriggerResponse>({ status: 'success' }, 200);
});

// onPostSubmit
triggers.post('/on-post-submit', async (c) => {
  const input = await c.req.json<OnPostSubmitRequest>();
  const post = input.post;
  if (!post) return c.json<TriggerResponse>({ status: 'success' }, 200);

  const sub = input.subreddit?.name ?? context.subredditName;
  if (!sub) return c.json<TriggerResponse>({ status: 'success' }, 200);

  const config = await loadConfig(sub);
  if (!config) {
    console.warn(`[aurameter] no config for ${sub}; onAppInstall trigger may have failed`);
    return c.json<TriggerResponse>({ status: 'success' }, 200);
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
    return c.json<TriggerResponse>({ status: 'success' }, 200);
  }
  const postId: T3 = post.id;

  const postInput: PostInput = {
    postId,
    subreddit: sub,
    title: post.title ?? '',
    body: (post as { selftext?: string; body?: string }).selftext ?? (post as { body?: string }).body ?? '',
  };

  if (!postInput.body || postInput.body.length < 30) {
    return c.json<TriggerResponse>({ status: 'success' }, 200);
  }

  // hot path: one redis read to get all four baselines
  const baselines = await loadBaselines(sub);

  // 1. score — calibration-aware, uses baselines (falls back to defaults if null)
  const rawResults = scorePost(postInput, config, baselines);
  const results = applyAggressiveness(rawResults, config);

  // 2. persist results + record samples for next nightly rollup (fire-and-forget)
  await savePostResult(postId, sub, results);
  const priority = computePriority(results);
  await addToQueue(sub, postId, priority);
  await recordDailyAggregate(sub, postId, results);

  // fire-and-forget: sample recording failures don't block the response
  recordSamples(sub, rawResults).catch((err) => {
    console.error('[aurameter] recordSamples failed:', err);
  });

  // 3. observe-only: stop here
  if (config.observeOnly) {
    console.log(`[aurameter] ${sub}/${postId}: observe-only, priority ${priority}`);
    return c.json<TriggerResponse>({ status: 'success' }, 200);
  }

  // 4. set flair
  const flairText = composeFlair(results, config);
  if (flairText) {
    try {
      await reddit.setPostFlair({ subredditName: sub, postId, text: flairText });
    } catch (err) {
      console.error(`[aurameter] setPostFlair failed for ${postId}:`, err);
    }
  }

  // 5. evaluate automation rules
  const matches = evaluateRules(results, config);
  for (const match of matches) {
    try {
      await executeAction(sub, postId, match.action);
    } catch (err) {
      console.error(`[aurameter] rule "${match.rule.label}" action failed:`, err);
    }
  }

  return c.json<TriggerResponse>({ status: 'success' }, 200);
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
  if (!postId || !isT3(postId)) return c.json<TriggerResponse>({ status: 'success' }, 200);
  await purgePostData(postId);
  console.log(`[aurameter] purged data for deleted post ${postId}`);
  return c.json<TriggerResponse>({ status: 'success' }, 200);
});

// onCommentDelete
triggers.post('/on-comment-delete', async (c) => {
  await c.req.json<OnCommentDeleteRequest>();
  return c.json<TriggerResponse>({ status: 'success' }, 200);
});
