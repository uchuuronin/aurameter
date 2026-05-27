/**
 * Vitest config — deliberately separate from vite.config.ts.
 *
 * vite.config.ts loads the @devvit/start plugin, which throws outside a
 * `vite build` (it only supports the server build). Vitest spins up Vite in
 * a non-build mode, so inheriting that config kills the test runner at startup.
 *
 * Vitest resolves vitest.config.* ahead of vite.config.*, so this file takes
 * over for `vitest run` without touching either Vite build config.
 *
 * `test.alias` redirects `@devvit/web/server` to an in-memory Redis fake
 * (test/devvit-server-mock.ts) so redis-touching modules (storage.ts,
 * corpus.ts, spotcheck.ts) can be unit-tested without a Devvit runtime. The
 * alias is scoped to the test runner only; the real build is untouched. Pure
 * suites (calibration, rule-validate) don't import that module and are
 * unaffected.
 */

import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  test: {
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
    environment: 'node',
    alias: {
      '@devvit/web/server': fileURLToPath(
        new URL('./test/devvit-server-mock.ts', import.meta.url),
      ),
    },
  },
});
