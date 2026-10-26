import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

/**
 * Vitest configuration.
 *
 * Chosen over Jest because the queue layer and the BullMQ worker are native ESM
 * (`.mjs`) with top-level `await`-free but ESM-only imports; Vitest runs ESM
 * natively, so `src/lib/jobs/*.jobs.mjs` and `worker/index.mjs` can be imported
 * by tests without any transform shims.
 *
 * `environment: 'node'` is the default because almost everything under test is
 * server-side. The one browser-dependent suite (`clientRateLimit` /
 * `useRateLimit`) opts into jsdom via a per-file docblock:
 *
 *     // @vitest-environment jsdom
 */
export default defineConfig({
  resolve: {
    // Mirrors the `@/*` -> `./src/*` alias from jsconfig.json so tests import
    // application modules exactly the way production code does.
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    globals: true,
    include: ['tests/**/*.test.{js,mjs}'],
    setupFiles: ['./tests/setup.js'],
    // Each test file gets a fresh module registry and process-global sandbox, so
    // the `globalThis` singletons used by redis/cache/rate-limiter (which exist
    // to survive hot reloads) cannot leak state between suites.
    isolate: true,
    // NOTE: `restoreMocks` is deliberately NOT enabled. It resets mocks to their
    // original implementation, which would wipe the default `async () => null`
    // behaviour of the Prisma doubles. Isolation is handled explicitly by
    // `clearCache()` / `clearRateLimitBuckets()` in tests/setup.js.
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      reportsDirectory: './coverage',
      include: ['src/lib/**', 'src/utils/**', 'src/hooks/**', 'worker/**'],
      exclude: ['src/lib/jobs/**/*.mjs'],
    },
  },
});
