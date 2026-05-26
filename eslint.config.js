import { defineConfig } from 'eslint/config';
import globals from 'globals';
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
export default defineConfig([
  tseslint.configs.recommended,
  {
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    files: ['src/**/*.{ts,tsx,mjs,cjs,js}'],
    languageOptions: {
      ecmaVersion: 2023,
      globals: globals.node,
      parserOptions: {
        // projectService auto-discovers the correct tsconfig per file using
        // TypeScript's own project resolution. This handles the project-
        // references split (tsconfig.client.json / tsconfig.server.json) without
        // naming each one — the old `project: ['./tsconfig.json']` pointed at the
        // root config, which now has `files: []` and contains no files, so every
        // file reported "not found in the project".
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    // client SPA runs in the browser â€” layer browser globals (window, document,
    // etc.) over node so client files don't trip no-undef. Server/core files
    // keep node-only globals from the block above.
    files: ['src/client/**/*.{ts,tsx}'],
    languageOptions: {
      globals: { ...globals.node, ...globals.browser },
    },
  },
  {
    files: ['**/*.{js,mjs,cjs,ts,tsx}'],
    rules: {
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-unused-vars': ['off'],
      'no-unused-vars': ['off'],
    },
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/build/**',
      'eslint.config.js',
      '**/vite.config.ts',
      'devvit.config.ts',
    ],
    languageOptions: {
      parserOptions: {
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: { js },
    extends: ['js/recommended'],
  },
]);