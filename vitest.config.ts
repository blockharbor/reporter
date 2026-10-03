import { defineConfig } from 'vitest/config';

// Root test runner. Discovers *.test.ts / *.test.tsx across packages and apps.
// Vite's resolver maps `.js` import specifiers to their `.ts` sources, so the
// same extensionful imports work at build time (tsc) and test time (vitest).
//
// No `environment` is set: the suite runs in node. The handful of component
// tests that need a DOM opt in per-file with a `// @vitest-environment jsdom`
// docblock, which keeps jsdom's startup cost off every other test file.
export default defineConfig({
  test: {
    include: ['{packages,apps}/*/src/**/*.test.{ts,tsx}'],
    exclude: ['**/node_modules/**', '**/dist/**'],
  },
});
