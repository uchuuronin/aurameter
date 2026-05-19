/**
 * Menu handlers. Mounted at /internal/menu in src/index.ts.
 *
 * Two menu items registered in devvit.json:
 *   open-dashboard   : subreddit-level, opens the dashboard custom post
 *   check-vibe       : post-level, scores the post on demand and shows a toast
 */

import { Hono } from 'hono';
import { reddit, context } from '@devvit/web/server';
import type { MenuItemRequest, UiResponse } from '@devvit/web/shared';
import { isT3 } from '@devvit/shared-types/tid.js';

import { scorePost, applyAggressiveness } from '../core/engine/score.js';
import { composeModSummary } from '../core/engine/flair.js';
import { loadConfig } from '../core/engine/storage.js';
import type { PostInput } from '../core/signals/types.js';

export const menu = new Hono();

// "Open aurameter" : subreddit-level menu item for moderators
menu.post('/open-dashboard', async (c) => {
  // Real implementation creates a sticky mod-only custom post and navigates the
  // mod to it. Stub for scaffolding : toast for now, dashboard post type lands Day 5.
  await c.req.json<MenuItemRequest>();
  return c.json<UiResponse>(
    {
      showToast: 'aurameter dashboard: coming on Day 5 of the build sprint.',
    },
    200
  );
});

// "Check vibe" : post-level menu item for moderators
menu.post('/check-vibe', async (c) => {
  const request = await c.req.json<MenuItemRequest>();
  const targetId = request.targetId;

  if (!isT3(targetId)) {
    return c.json<UiResponse>(
      {
        showToast: 'Check vibe can only be run on a post.',
      },
      200
    );
  }

  // Fetch the post.
  const post = await reddit.getPostById(targetId);
  const sub = post.subredditName ?? context.subredditName;
  if (!sub) {
    return c.json<UiResponse>(
      {
        showToast: 'Could not determine subreddit for scoring.',
      },
      200
    );
  }

  const config = await loadConfig(sub);
  if (!config) {
    return c.json<UiResponse>(
      {
        showToast: 'aurameter is not configured for this subreddit yet.',
      },
      200
    );
  }

  const body = (post as { selftext?: string; body?: string }).selftext ?? (post as { body?: string }).body ?? '';
  if (!body || body.length < 30) {
    return c.json<UiResponse>(
      {
        showToast: 'Post too short for scoring (link posts and short texts skipped).',
      },
      200
    );
  }

  const postInput: PostInput = {
    postId: post.id,
    subreddit: sub,
    title: post.title ?? '',
    body,
  };

  const raw = scorePost(postInput, config);
  const scored = applyAggressiveness(raw, config);
  const summary = composeModSummary(scored, config);

  return c.json<UiResponse>(
    {
      showToast: `aurameter score: ${summary}`,
    },
    200
  );
});
