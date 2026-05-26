/**
 * menu handlers. mounted at /internal/menu.
 *
 *   open-dashboard: creates (or navigates to) the mod dashboard custom post.
 *     The post is mod-distinguished but NOT pinned — mods reach the dashboard
 *     through the subreddit ••• mod menu ("Open aurameter"), not from a pinned
 *     post at the top of the sub. If a dashboard post already exists for this
 *     sub (stored in redis as am:dashboard-post:<sub>), we navigate to it
 *     instead of creating a duplicate.
 *
 *     Note: the dashboard IS a custom post (that's the only surface a Devvit
 *     web-view app can render in), so a post always exists — "not pinned" means
 *     it isn't stickied to the top, not that there's no post. Opening it
 *     navigates the current view to that post's web view; whether that can be a
 *     new browser tab rather than same-view is platform-dependent (§9 #4) and
 *     only confirmable in a real playtest. To keep the dashboard open beside
 *     the subreddit, a mod can middle/cmd/ctrl-click the post or bookmark its
 *     URL — both are user-initiated and open a real tab.
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

/** Canonical permalink for a dashboard post id in a given sub. */
function dashboardUrl(sub: string, postId: string): string {
  const shortId = postId.replace('t3_', '');
  return `https://www.reddit.com/r/${sub}/comments/${shortId}/`;
}

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
    return c.json<UiResponse>({
      showToast: 'opening dashboard…',
      navigateTo: dashboardUrl(sub, existingPostId),
    });
  }

  try {
    // submitCustomPost expects an `entry` matching a post.entrypoints key in devvit.json
    const post = await reddit.submitCustomPost({
      subredditName: sub,
      title: 'aurameter mod dashboard',
      entry: 'default',
    });

    // distinguish (mod-only visual) but DO NOT sticky/pin: the dashboard is
    // reached via the subreddit ••• mod menu ("Open aurameter"), not from a
    // pinned post at the top of the sub. The post still exists (it's the only
    // surface the web-view app can render in) — it's just not pinned.
    await post.distinguish();

    await redis.set(dashboardPostKey(sub), post.id);

    return c.json<UiResponse>({
      showToast: 'opening dashboard…',
      navigateTo: dashboardUrl(sub, post.id),
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

  if (!targetId || !isT3(targetId)) {
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
