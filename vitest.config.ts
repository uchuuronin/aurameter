/**
 * Vitest config — deliberately separate from vite.config.ts.
 *
 * vite.config.ts loads the @devvit/start plugin, which throws outside a
 * `vite build` (it only supports the server build). Vitest spins up Vite in
 * a non-build mode, so inheriting that config kills the test runner at startup.
 *
 * Vitest resolves vitest.config.* ahead of vite.config.*, so this file takes
 * over for `vitest run` without touching either Vite build config. The core
 * suites are pure Node (no redis, no Devvit, no DOM), hence environment: 'node'.
 */

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
    environment: 'node',
  },
});