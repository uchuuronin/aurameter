import { defineConfig } from 'vite';
import { devvit } from '@devvit/start/vite';
import preact from '@preact/preset-vite';

export default defineConfig({
  plugins: [
    devvit(),
    preact(),
  ],
  build: {
    rollupOptions: {
      input: {
        // server entry (cjs, handled by devvit plugin)
        server: 'src/index.ts',
        // client dashboard (esm, served as static asset)
        dashboard: 'src/client/dashboard/main.tsx',
      },
      output: {
        // server bundle → dist/server/index.cjs (devvit plugin handles this)
        // client bundle → dist/client/dashboard/[name].js
        entryFileNames: (chunk) => {
          if (chunk.name === 'dashboard') return 'client/dashboard/[name].[hash].js';
          return '[name].js';
        },
      },
    },
  },
  resolve: {
    alias: {
      // preact compat — use preact instead of react for smaller bundle
      'react': 'preact/compat',
      'react-dom': 'preact/compat',
    },
  },
  // serve the dashboard html during dev
  root: 'src/client/dashboard',
});
