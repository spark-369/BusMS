import Redis from 'ioredis';

/**
 * Shared Redis layer.
 *
 * Two connection shapes are used deliberately:
 *
 *  - `getRedis()`      -> the app client. Fails fast (`maxRetriesPerRequest: 1`
 *                         + `commandTimeout`) so a Redis outage can never hang
 *                         an API request. Callers must handle a `null`/thrown
 *                         result and fall back to the in-process implementation.
 *  - `createQueueConnection()` -> BullMQ requires `maxRetriesPerRequest: null`
 *                         so blocking commands are not aborted mid-wait.
 *
 * A small circuit breaker skips Redis entirely for a cooldown window once it
 * has failed repeatedly. Without it, every cache/limit call during an outage
 * would pay a connection timeout, which is far worse than serving from memory.
 *
 * When `REDIS_URL` is not configured the whole layer becomes inert: every
 * helper returns `null`/`false` and the app degrades to the in-memory
 * implementations (cache, rate limiter) and inline job execution. That keeps
 * the Vercel Hobby deployment working with no Redis add-on.
 *
 * Importing this module does NOT open a connection — clients are constructed
 * lazily inside `getRedis()`/`createQueueConnection()`, so a process with no
 * `REDIS_URL` never touches the network.
 */

const globalForRedis = global;

// Resolved at call time rather than module load so that environment changes
// (tests, runtime config injection, container env) are picked up without
// needing a module reload.
export const getRedisUrl = () => process.env.REDIS_URL || '';

export const isRedisConfigured = () => Boolean(getRedisUrl());

// ---------------------------------------------------------------------------
// Circuit breaker
// ---------------------------------------------------------------------------
const BREAKER_THRESHOLD = 3;
const BREAKER_COOLDOWN_MS = 30_000;

const createBreaker = () => ({ failures: 0, trippedUntil: 0 });

/**
 * Read through `globalForRedis` on every access rather than capturing the object
 * in a module-level `const`.
 *
 * The object is stored on `globalThis` so it survives Next.js hot reloads, but
 * that alone is not enough: a module-level `const` would keep pointing at the
 * ORIGINAL object after the property is reassigned or deleted, so the breaker
 * could never be reset. Reading the property each time makes the stored object
 * authoritative.
 */
const getBreaker = () => {
  if (!globalForRedis.__busRedisBreaker) {
    globalForRedis.__busRedisBreaker = createBreaker();
  }
  return globalForRedis.__busRedisBreaker;
};

/**
 * Resets the breaker (and, when `includeClient` is set, drops the cached client).
 *
 * Exposed because a tripped breaker is process-global state: a test that
 * deliberately trips it would otherwise leave every later test skipping Redis.
 */
export const resetRedisState = ({ includeClient = true } = {}) => {
  globalForRedis.__busRedisBreaker = createBreaker();
  if (includeClient) delete globalForRedis.__busRedis;
};

// Registered on globalThis so tooling can reset this module without importing it
// (importing would pull in `ioredis` before a test's `vi.mock` could apply).
globalForRedis.__busRedisReset = resetRedisState;

const debugEnabled = process.env.REDIS_DEBUG === 'true';

const logRedis = (message, error) => {
  if (debugEnabled) {
    console.error(`[redis] ${message}`, error?.message || error || '');
  }
};

// ---------------------------------------------------------------------------
// Clients
// ---------------------------------------------------------------------------
const attachListeners = (client, label) => {
  client.on('error', (error) => {
    logRedis(`${label} connection error`, error);
  });
  return client;
};

/**
 * Builds the ioredis options for a given connection role.
 */
const buildOptions = ({ failFast }) => ({
  // BullMQ aborts jobs if a command is retried and rejected, so it mandates
  // `null` here. The app client wants the opposite: reject quickly and let the
  // caller fall back.
  maxRetriesPerRequest: failFast ? 1 : null,
  enableReadyCheck: true,
  connectTimeout: 5_000,
  ...(failFast ? { commandTimeout: 2_000 } : {}),
  retryStrategy: (times) => Math.min(times * 250, 5_000),
  lazyConnect: false,
});

/**
 * Shared application Redis client (cache + rate limiting).
 * @returns {import('ioredis').Redis | null}
 */
export const getRedis = () => {
  if (!isRedisConfigured()) return null;

  if (!globalForRedis.__busRedis) {
    globalForRedis.__busRedis = attachListeners(
      new Redis(getRedisUrl(), buildOptions({ failFast: true })),
      'app',
    );
  }

  return globalForRedis.__busRedis;
};

/**
 * Dedicated connection for BullMQ producers/workers.
 * Never reuse the app client here — BullMQ's blocking commands need
 * `maxRetriesPerRequest: null`.
 * @returns {import('ioredis').Redis | null}
 */
export const createQueueConnection = () => {
  if (!isRedisConfigured()) return null;
  return attachListeners(
    new Redis(getRedisUrl(), buildOptions({ failFast: false })),
    'queue',
  );
};

/**
 * True when it is worth attempting a Redis command right now.
 * `connecting`/`connect` are treated as usable so the very first request after
 * a cold start does not needlessly fall back to memory.
 */
export const isRedisUsable = () => {
  const client = getRedis();
  if (!client) return false;
  if (Date.now() < getBreaker().trippedUntil) return false;

  return (
    client.status === 'ready' ||
    client.status === 'connecting' ||
    client.status === 'connect'
  );
};

export const recordRedisSuccess = () => {
  getBreaker().failures = 0;
};

export const recordRedisFailure = (error) => {
  logRedis('command failed', error);

  const breaker = getBreaker();
  breaker.failures += 1;

  if (breaker.failures >= BREAKER_THRESHOLD) {
    breaker.trippedUntil = Date.now() + BREAKER_COOLDOWN_MS;
    breaker.failures = 0;
    logRedis(`circuit opened for ${BREAKER_COOLDOWN_MS}ms`);
  }
};

/** Diagnostics used by the `/api/health` route. */
export const redisStatus = () => {
  const client = getRedis();
  const { trippedUntil } = getBreaker();

  return {
    configured: isRedisConfigured(),
    status: client ? client.status : 'disabled',
    usable: isRedisUsable(),
    circuitOpenUntil: trippedUntil > Date.now() ? trippedUntil : null,
  };
};

export default getRedis;
