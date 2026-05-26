/**
 * nav — client-side navigation for the dashboard web view.
 *
 * Shared by QueuePanel (take-action handoff) and LogPanel (open-post link-out).
 *
 * The dashboard runs inside Reddit's web-view iframe. DOM navigation from
 * inside that iframe — <a href>, window.open, window.top.location — is blocked
 * by the sandbox (confirmed in playtest: "open post" did nothing). The correct
 * mechanism is the Devvit host effect navigateTo(), which ASKS Reddit to
 * navigate rather than trying to drive the browser directly. This is the same
 * family of effect the server-side menu handlers use (UiResponse.navigateTo).
 *
 * Verified against the installed package (@devvit/web 0.12.23):
 *   @devvit/web/client re-exports @devvit/client, which declares:
 *     export declare function navigateTo(
 *       thingOrUrl: string | { readonly url: string }
 *     ): void;
 *
 * navigateTo is synchronous and fire-and-forget. It navigates the current view
 * to the target (it does not open a separate browser tab — that's not something
 * the host effect exposes). Reaching the post reliably is the win here; the
 * dashboard is a pinned/menu-reachable post the mod can return to.
 */

import { navigateTo } from '@devvit/web/client';

/**
 * Navigate to an absolute URL via the Devvit host effect.
 */
export function openExternal(url: string): void {
  if (!url) return;
  navigateTo(url);
}

/**
 * Build the canonical post URL from a postId. The log stores only postId (no
 * permalink — privacy line §1.2), so this is where a postId→URL mapping is
 * acceptable: a historical log entry has no live read backing it.
 */
export function postUrlFromId(postId: string): string {
  const shortId = postId.replace('t3_', '');
  return `https://www.reddit.com/comments/${shortId}/`;
}

/**
 * Open a post given a server-provided canonical permalink.
 */
export function openPost(permalink: string): void {
  openExternal(permalink);
}

/**
 * Open a post when only its id is known. Builds the canonical URL then navigates.
 */
export function openPostById(postId: string): void {
  openExternal(postUrlFromId(postId));
}
