/**
 * menu handlers. mounted at /internal/menu.
 *
 *   open-dashboard: creates (or navigates to) the mod dashboard custom post.
 *     the post is pinned, mod-distinguished. if a dashboard post already
 *     exists for this sub (stored in redis as am:dashboard-post:<sub>),
 *     we navigate to it instead of creating a duplicate.
 *
 *   check-vibe: scores a post on demand and shows the result as a toast.
 *     this is the safe fallback if autonomous flair is disallowed.
 *
 * api notes (verified against @devvit/web 0.12.23):
 *   - menu handlers return UiResponse with { showToast, navigateTo } fields
 *   - custom posts are created via reddit.submitCustomPost({ entry: 'default' })
 *     where 'default' matches a key in devvit.json's post.entrypoints
 *   - distinguish/sticky are methods on the returned Post object, not on the
 *     top-level reddit client
 */

import { Hono } from 'hono';
import { reddit, context, redis } from '@devvit/web/server';
import type { MenuItemRequest, UiResponse } from '@devvit/web/shared';
import { isT3 } from '@devvit/shared-types/tid.js';

import { scorePost, applyAggressiveness } from '../core/engine/score.js';
import { composeModSummary } from '../core/engine/flair.js';
import { loadConfig, loadBaselines } from '../core/engine/storage.js';
import type { PostInput } from '../core/signals/types.js';

export const menu = new Hono();

const dashboardPostKey = (sub: string) => `am:dashboard-post:${sub}`;

// ── open aurameter dashboard ──────────────────────────────────────────────────

menu.post('/open-dashboard', async (c) => {
  await c.req.json<MenuItemRequest>();
  const sub = context.subredditName;

  if (!sub) {
    return c.json<UiResponse>({ showToast: 'could not determine subreddit' });
  }

  // reuse existing dashboard post if we already created one
  const existingPostId = await redis.get(dashboardPostKey(sub));
  if (existingPostId) {
    const shortId = existingPostId.replace('t3_', '');
    return c.json<UiResponse>({
      showToast: 'opening dashboard…',
      navigateTo: `https://www.reddit.com/r/${sub}/comments/${shortId}/`,
    });
  }

  try {
    // submitCustomPost expects an `entry` matching a post.entrypoints key in devvit.json
    const post = await reddit.submitCustomPost({
      subredditName: sub,
      title: 'aurameter mod dashboard',
      entry: 'default',
    });

    // distinguish + sticky are methods on the Post object, not on the reddit client
    await Promise.all([
      post.distinguish(),
      post.sticky(1),
    ]);

    await redis.set(dashboardPostKey(sub), post.id);

    const shortId = post.id.replace('t3_', '');
    return c.json<UiResponse>({
      showToast: 'dashboard created — opening…',
      navigateTo: `https://www.reddit.com/r/${sub}/comments/${shortId}/`,
    });
  } catch (err) {
    console.error('[aurameter] failed to create dashboard post:', err);
    return c.json<UiResponse>({
      showToast: 'could not create dashboard post — check mod permissions',
    });
  }
});

// ── check vibe ────────────────────────────────────────────────────────────────

menu.post('/check-vibe', async (c) => {
  const request = await c.req.json<MenuItemRequest>();
  const targetId = request.targetId;

  if (!isT3(targetId)) {
    return c.json<UiResponse>({ showToast: 'check vibe can only be run on a post.' });
  }

  const post = await reddit.getPostById(targetId);
  const sub = post.subredditName ?? context.subredditName;
  if (!sub) {
    return c.json<UiResponse>({ showToast: 'could not determine subreddit.' });
  }

  const config = await loadConfig(sub);
  if (!config) {
    return c.json<UiResponse>({ showToast: 'aurameter is not configured for this subreddit.' });
  }

  const body =
    (post as { selftext?: string; body?: string }).selftext ??
    (post as { body?: string }).body ??
    '';

  if (!body || body.length < 30) {
    return c.json<UiResponse>({
      showToast: 'post too short for scoring (link posts and short texts skipped).',
    });
  }

  const postInput: PostInput = {
    postId: post.id,
    subreddit: sub,
    title: post.title ?? '',
    body,
  };

  const baselines = await loadBaselines(sub);
  const raw = scorePost(postInput, config, baselines);
  const scored = applyAggressiveness(raw, config);
  const summary = composeModSummary(scored, config);

  return c.json<UiResponse>({ showToast: `aurameter: ${summary}` });
});
