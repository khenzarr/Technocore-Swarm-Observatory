import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Mirror the `@/*` path alias from tsconfig.json so tests import the same way app code does.
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    /*
     * Several suites build large fixtures on purpose: the 26,000-observation demo session and
     * the 1,000-sender / 50,000-observation stress fixture. Those walk the full message log
     * with a per-message assertion, which outruns vitest's 5s default on a loaded machine
     * while the files run in parallel. The bound stays low enough to catch a real hang.
     */
    testTimeout: 30_000,
  },
});
