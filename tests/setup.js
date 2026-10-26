/**
 * Global test setup.
 *
 * Runs once per test file before any module under test is imported. Its job is
 * to guarantee that importing application modules cannot fail or accidentally
 * reach out to a real service:
 *
 *  - `JWT_SECRET` is set because `src/utils/jwt.js` throws in production when it
 *    is missing; without this, importing a route handler would blow up.
 *  - `NODE_ENV` is forced to 'test' so `src/lib/prisma.js` skips the `global`
 *    caching branch it uses for hot reloads.
 *  - `REDIS_URL` is cleared by default so the suite exercises the documented
 *    zero-infrastructure fallback paths unless a test opts in.
 */

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-not-used-outside-tests';
process.env.JWT_EXPIRES_IN = '1h';
process.env.DATABASE_URL =
  'postgresql://test:test@localhost:5432/test?schema=public';

// Redis is opt-in per test. Leaving it unset by default means the in-memory
// cache/limiter and the inline job execution are what run, which is the
// behaviour most deployments without a Redis add-on will actually get.
delete process.env.REDIS_URL;

// Keep the suite fast and quiet.
process.env.REDIS_DEBUG = 'false';
process.env.QUEUE_ENQUEUE_TIMEOUT_MS = '100';

import { afterEach, vi } from 'vitest';

afterEach(() => {
  // These reset hooks are registered on globalThis by the modules themselves.
  // They are called through `globalThis` rather than via an import on purpose:
  // importing `@/lib/cache` here would load `@/lib/redis` -> `ioredis` before a
  // test file's `vi.mock('ioredis')` could apply, leaving the real client wired
  // up and the fake ignored.
  globalThis.__busCacheReset?.();
  globalThis.__busRateLimitReset?.();
  // Resets the circuit breaker AND drops the cached client. Clearing the breaker
  // matters: a test that deliberately trips it would otherwise leave every later
  // test silently skipping Redis.
  globalThis.__busRedisReset?.();

  // The queue registry is lazily created and re-read from `globalThis` on each
  // call, so deleting the reference does reset it.
  delete globalThis.__busQueues;

  vi.clearAllMocks();
});
