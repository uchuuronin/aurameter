/**
 * Form handlers. Mounted at /internal/form in src/index.ts.
 *
 * Currently empty: aurameter has no forms in the foundational scaffold.
 * Reserved for the Day 6 dashboard rule builder, which will use forms for:
 *   - "Add custom rule" with signal/comparator/threshold/action fields
 *   - "Edit signal config" with visibility, emoji, maxScore fields
 *   - "Reset to preset" confirmation
 *
 * Kept as a non-empty router rather than deleted so the import chain in
 * src/index.ts remains stable; adding new forms means appending to this file,
 * not editing devvit.json and index.ts at the same time.
 */

import { Hono } from 'hono';

export const forms = new Hono();
