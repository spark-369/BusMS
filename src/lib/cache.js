import {
  getRedis,
  isRedisUsable,
  recordRedisFailure,
  recordRedisSuccess,
} from './redis';

/**
 * Redis-backed response cache with an in-process fallback.
 *
 * Invalidation uses a per-namespace *version counter* instead of scanning for
 * keys. Every entry is stored as
 *
 *     bus:cache:<namespace>:<version>:<suffix>
 *
 * and "flushing" a namespace is a single atomic `INCR` on
 * `bus:cachever:<namespace>`. Stale entries become unreachable immediately and
 * expire on their own TTL, so there is never a `KEYS`/`SCAN` sweep (which would
 * block Redis) and never an O(n) delete.
 *
 * When Redis is unavailable the exact same semantics run against a bounded
 * in-process Map, so the application behaves identically (minus cross-instance
 * sharing) with zero configuration.
 */

const globalForCache = global;

export const CACHE_NAMESPACES = {
  ROUTES: 'routes',
  STOPS: 'stops',
  BUSES: 'buses',
  SCHEDULES: 'schedules',
  TRIPS: 'trips',
  DASHBOARD: 'dashboard',
  REPORTS: 'reports',
  NOTIFICATIONS: 'notifications',
  MAINTENANCE: 'maintenance',
  ASSIGNMENTS: 'assignments',
};

// Read-heavy, low-churn data gets a longer TTL; anything a driver sees live
// (trips, notifications) is kept short so polling stays fresh.
const TTL_SECONDS = {
  routes: 60,
  stops: 60,
  buses: 30,
  schedules: 30,
  trips: 15,
  dashboard: 30,
  reports: 60,
  notifications: 10,
  maintenance: 60,
  assignments: 30,
};

const DEFAULT_TTL_SECONDS =
  Number.parseInt(process.env.CACHE_TTL_SECONDS || '', 10) || 60;

// Resolved lazily so the value is read from the live environment rather than
// being frozen at import time.
const getMemoryMaxEntries = () =>
  Number.parseInt(process.env.CACHE_MEMORY_MAX_ENTRIES || '', 10) || 500;

const KEY_PREFIX = 'bus:cache';
const VERSION_PREFIX = 'bus:cachever';

const memory = (globalForCache.__busMemoryCache =
  globalForCache.__busMemoryCache || new Map());

const memoryVersions = (globalForCache.__busCacheVersions =
  globalForCache.__busCacheVersions || new Map());

// ---------------------------------------------------------------------------
// Namespace versions (used for invalidation)
// ---------------------------------------------------------------------------
export const getNamespaceVersion = async (namespace) => {
  const redis = getRedis();

  if (redis && isRedisUsable()) {
    try {
      const versionKey = `${VERSION_PREFIX}:${namespace}`;
      const raw = await redis.get(versionKey);
      recordRedisSuccess();

      if (raw !== null && raw !== undefined) return String(raw);

      // First use — establish version 0 so the very first INCR yields 1.
      await redis.set(versionKey, '0', 'NX');
      return '0';
    } catch (error) {
      recordRedisFailure(error);
    }
  }

  return String(memoryVersions.get(namespace) || 0);
};

export const invalidateNamespace = async (namespace) => {
  if (!namespace) return;

  const redis = getRedis();

  if (redis && isRedisUsable()) {
    try {
      await redis.incr(`${VERSION_PREFIX}:${namespace}`);
      recordRedisSuccess();
    } catch (error) {
      recordRedisFailure(error);
    }
  }

  // The in-process mirror must move too, otherwise a long-lived server would
  // keep serving its own stale entries after a write.
  memoryVersions.set(namespace, (memoryVersions.get(namespace) || 0) + 1);

  const prefix = `${KEY_PREFIX}:${namespace}:`;
  for (const key of memory.keys()) {
    if (key.startsWith(prefix)) memory.delete(key);
  }
};

/**
 * Invalidate one or more namespaces. Safe to call with `undefined` values so
 * routes can pass a conditional list.
 */
export const invalidate = async (...namespaces) => {
  await Promise.all(
    [...new Set(namespaces.filter(Boolean))].map((ns) => invalidateNamespace(ns)),
  );
};

// ---------------------------------------------------------------------------
// Read / write primitives
// ---------------------------------------------------------------------------
const buildKey = (namespace, version, suffix) =>
  `${KEY_PREFIX}:${namespace}:${version}:${suffix || 'default'}`;

const readEntry = async (key) => {
  const redis = getRedis();

  if (redis && isRedisUsable()) {
    try {
      const raw = await redis.get(key);
      recordRedisSuccess();

      if (raw !== null && raw !== undefined) {
        try {
          return { hit: true, value: JSON.parse(raw), source: 'redis' };
        } catch {
          // Corrupt/legacy payload — treat as a miss.
          return { hit: false };
        }
      }
    } catch (error) {
      recordRedisFailure(error);
    }
  }

  const entry = memory.get(key);
  if (entry) {
    if (entry.expiresAt > Date.now()) {
      return { hit: true, value: entry.value, source: 'memory' };
    }
    memory.delete(key);
  }

  return { hit: false };
};

const writeEntry = async (key, value, ttlSeconds) => {
  // Bound the fallback store so a long-running server cannot grow unbounded.
  const maxEntries = getMemoryMaxEntries();
  if (memory.size >= maxEntries) {
    const oldest = memory.keys().next().value;
    if (oldest !== undefined) memory.delete(oldest);
  }
  memory.set(key, { value, expiresAt: Date.now() + ttlSeconds * 1000 });

  const redis = getRedis();
  if (redis && isRedisUsable()) {
    try {
      await redis.set(key, JSON.stringify(value), 'EX', ttlSeconds);
      recordRedisSuccess();
    } catch (error) {
      recordRedisFailure(error);
    }
  }
};

/**
 * Cache-aside helper.
 *
 * @param {string} namespace   one of CACHE_NAMESPACES
 * @param {string} suffix      cache-busting discriminator (id, query string, role…)
 * @param {() => Promise<any>} producer  runs only on a miss
 * @param {{ ttl?: number }} [options]
 * @returns {Promise<{ data: any, cache: 'HIT'|'MISS', source: string|null, key: string }>}
 */
export const withCache = async (namespace, suffix, producer, options = {}) => {
  const ttlSeconds =
    options.ttl ?? TTL_SECONDS[namespace] ?? DEFAULT_TTL_SECONDS;

  const version = await getNamespaceVersion(namespace);
  const key = buildKey(namespace, version, suffix);

  const cached = await readEntry(key);
  if (cached.hit) {
    return { data: cached.value, cache: 'HIT', source: cached.source, key };
  }

  const data = await producer();

  if (data !== undefined) {
    await writeEntry(key, data, ttlSeconds);
  }

  return { data, cache: 'MISS', source: null, key };
};

/** Response headers describing a `withCache` result. */
export const cacheHeaders = (result) => ({
  'X-Cache': result?.cache || 'MISS',
  ...(result?.source ? { 'X-Cache-Source': result.source } : {}),
});

/**
 * Stable cache suffix from a request's query string. Keys are sorted so
 * `?a=1&b=2` and `?b=2&a=1` share an entry.
 */
export const searchParamsKey = (req) => {
  const { searchParams } = new URL(req.url);
  const entries = [...searchParams.entries()].sort(([a], [b]) =>
    a.localeCompare(b),
  );

  if (entries.length === 0) return 'default';
  return entries.map(([key, value]) => `${key}=${value}`).join('&');
};

/** Diagnostics used by the `/api/health` route. */
export const cacheStatus = () => ({
  entries: memory.size,
  versions: Object.fromEntries(memoryVersions),
  defaultTtlSeconds: DEFAULT_TTL_SECONDS,
});

/**
 * Drops every cached entry and resets all namespace versions.
 *
 * Note this only clears the *in-process* store; Redis entries are left to expire
 * on their own TTL (bump a namespace with `invalidate` to bypass them
 * immediately). Exposed mainly so tests can isolate state, since the module-level
 * Maps are captured at import time and therefore cannot be reset by reassigning
 * `globalThis`.
 */
export const clearCache = () => {
  memory.clear();
  memoryVersions.clear();
};

// Expose the reset hook on globalThis so tooling (notably the test setup) can
// clear this module's state WITHOUT importing it. Importing here would pull in
// `@/lib/redis` and therefore `ioredis` before a test file's `vi.mock` can take
// effect, which would leave the real client in place.
globalForCache.__busCacheReset = clearCache;

export default withCache;
