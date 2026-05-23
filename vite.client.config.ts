/**
 * Client-side vite config — builds the dashboard webview.
 *
 * Separate from the server build because:
 *   - The @devvit/start plugin owns the server output and would fight us over it
 *   - The client is a plain SPA that builds from an HTML entrypoint
 *
 * Run with: `vite build --config vite.client.config.ts`
 * (the `build` npm script chains both vite invocations together)
 *
 * Output: dist/client/dashboard/index.html + dist/client/dashboard/assets/*
 */

import { defineConfig } from 'vite';
import preact from '@preact/preset-vite';

export default defineConfig({
  plugins: [preact()],
  root: 'src/client/dashboard',
  // Use relative paths in the built HTML so asset URLs resolve relative to
  // the HTML's location (./assets/foo.js), not relative to the webview root
  // (/assets/foo.js). The devvit webview serves dist/client/ as the root and
  // the HTML lives at dist/client/dashboard/index.html — absolute /assets/...
  // would 404 because the assets dir is at dist/client/dashboard/assets/.
  base: './',
  build: {
    outDir: '../../../dist/client/dashboard',
    emptyOutDir: true,
    rollupOptions: {
      input: 'src/client/dashboard/index.html',
    },
  },
  resolve: {
    alias: {
      react: 'preact/compat',
      'react-dom': 'preact/compat',
    },
  },
});
