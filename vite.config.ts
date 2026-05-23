/**
 * Server-side vite config.
 * The devvit plugin owns this build — it produces dist/server/index.cjs
 * from src/index.ts. Project root is the repo root so the plugin finds devvit.json.
 *
 * For the client (the dashboard webview), see vite.client.config.ts.
 */

import { defineConfig } from 'vite';
import { devvit } from '@devvit/start/vite';

export default defineConfig({
  plugins: [devvit()],
});
