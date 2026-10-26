import { NextResponse } from 'next/server';
import {
  getRedis,
  isRedisUsable,
  recordRedisFailure,
  recordRedisSuccess,
} from './redis';

/**
 * Hand-rolled rate limiter (no third-party limiter library).
 *
 * Two algorithms are implemented, both backed by Redis and both mirrored by an
 * in-process fallback so the app still enforces limits when Redis is absent:
 *
 *  - `fixed`   : INCR + PEXPIRE in a single Lua script. One round trip, one
 *                counter per window. Cheapest option; a burst at a window
 *                boundary can allow up to 2x the limit.
 *  - `sliding` : sorted-set log trimmed by score. Exact "N requests per window"
 *                semantics with no boundary burst, at the cost of storing one
 *                member per request. Used for the abuse-sensitive endpoints
 *                (login, register, QR verification).
 *
 * Lua is used rather than MULTI/EXEC because the check-and-increment must be a
 * single atomic step: with MULTI we would read the counter, decide in Node, and
 * write back — a TOCTOU race that lets concurrent requests overshoot the limit.
 *
 * Failure policy is deliberately **fail-open** (allow the request, count it in
 * the in-memory limiter). Rate limiting is a protection layer, not an
 * authorization check: refusing all traffic because Redis blipped would turn a
 * cache outage into a full outage.
 */

const globalForLimiter = global;

const KEY_PREFIX = 'bus:rl';

// ---------------------------------------------------------------------------
// Policies
// ---------------------------------------------------------------------------
/**
 * Per-route policies. `windowMs` is the window length, `max` the allowed number
 * of requests inside it, `algorithm` defaults to `fixed`.
 */
export const RATE_LIMITS = {
  // Credential endpoints: strict, sliding, keyed by IP *and* email where given.
  LOGIN: { max: 10, windowMs: 60_000, algorithm: 'sliding', scope: 'login' },
  REGISTER: { max: 5, windowMs: 60_000, algorithm: 'sliding', scope: 'register' },

  // Expensive read endpoints.
  REPORTS: { max: 30, windowMs: 60_000, scope: 'reports' },
  DASHBOARD: { max: 60, windowMs: 60_000, scope: 'dashboard' },
  ACTIVITY_LOGS: { max: 60, windowMs: 60_000, scope: 'activity-logs' },

  // CRUD collections.
  COLLECTION_READ: { max: 120, windowMs: 60_000, scope: 'read' },
  COLLECTION_WRITE: { max: 40, windowMs: 60_000, scope: 'write' },

  // Write-heavy / money-ish or irreversible operations.
  BOOKING_WRITE: { max: 20, windowMs: 60_000, scope: 'booking-write' },
  BULK_WRITE: { max: 15, windowMs: 60_000, scope: 'bulk-write' },
  QR_VERIFY: { max: 60, windowMs: 60_000, algorithm: 'sliding', scope: 'qr-verify' },

  // Broadcasts fan out to every user, so they are the most tightly capped.
  BROADCAST: { max: 5, windowMs: 60_000, scope: 'broadcast' },

  // Anything not listed above.
  DEFAULT: { max: 100, windowMs: 60_000, scope: 'default' },
};

// ---------------------------------------------------------------------------
// Lua scripts
// ---------------------------------------------------------------------------
// KEYS[1] = counter key, ARGV[1] = max, ARGV[2] = windowMs
// Returns { count, ttlMs }
const FIXED_WINDOW_SCRIPT = `
local key = KEYS[1]
local max = tonumber(ARGV[1])
local window = tonumber(ARGV[2])

local count = redis.call('INCR', key)
if count == 1 then
  redis.call('PEXPIRE', key, window)
end

local ttl = redis.call('PTTL', key)
if ttl < 0 then
  -- Counter existed without a TTL (e.g. a partial previous write). Repair it so
  -- the bucket can never become permanent.
  redis.call('PEXPIRE', key, window)
  ttl = window
end

return { count, ttl }
`;

// KEYS[1] = sorted-set key
// ARGV[1] = max, ARGV[2] = windowMs, ARGV[3] = nowMs, ARGV[4] = unique member
// Returns { count, retryAfterMs }
//
// `count` is the number of requests ATTEMPTED inside the window, including the
// one being rejected. That matters: the caller decides with `count <= max`, so a
// rejected request must report `max + 1`. Returning the raw `ZCARD` here would
// make a full window report exactly `max` and therefore read as ALLOWED, which
// silently disables the limit entirely.
const SLIDING_WINDOW_SCRIPT = `
local key = KEYS[1]
local max = tonumber(ARGV[1])
local window = tonumber(ARGV[2])
local now = tonumber(ARGV[3])
local member = ARGV[4]

-- Drop everything that has fallen out of the window.
redis.call('ZREMRANGEBYSCORE', key, 0, now - window)

local count = redis.call('ZCARD', key)

if count < max then
  redis.call('ZADD', key, now, member)
  count = count + 1
  redis.call('PEXPIRE', key, window)
  return { count, 0 }
end

-- Limit hit. Report the attempted count (max + 1) so the caller rejects it, and
-- tell it when the oldest entry ages out of the window.
local oldest = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
local retryAfter = window
if oldest[2] then
  retryAfter = (tonumber(oldest[2]) + window) - now
  if retryAfter < 0 then retryAfter = 0 end
end

return { count + 1, retryAfter }
`;

// ---------------------------------------------------------------------------
// In-memory fallback
// ---------------------------------------------------------------------------
const memoryBuckets = (globalForLimiter.__busRateBuckets =
  globalForLimiter.__busRateBuckets || new Map());

const memoryFixedWindow = (key, max, windowMs) => {
  const now = Date.now();
  const bucket = memoryBuckets.get(key);

  if (!bucket || bucket.expiresAt <= now) {
    memoryBuckets.set(key, { count: 1, expiresAt: now + windowMs });
    return { count: 1, retryAfterMs: 0 };
  }

  bucket.count += 1;
  if (bucket.count <= max) return { count: bucket.count, retryAfterMs: 0 };
  return { count: bucket.count, retryAfterMs: bucket.expiresAt - now };
};

/**
 * In-memory sliding-window limiter.
 *
 * `count` is the number of requests ATTEMPTED in the window, including a
 * rejected one — hence `hits.length + 1` on the blocked path. The caller decides
 * with `count <= max`, so returning the raw hit count (`max`) would read as
 * ALLOWED and silently disable the limit. This mirrors the Lua script exactly.
 */
const memorySlidingWindow = (key, max, windowMs, now) => {
  const cutoff = now - windowMs;
  const hits = (memoryBuckets.get(key)?.hits || []).filter((t) => t > cutoff);

  if (hits.length < max) {
    hits.push(now);
    memoryBuckets.set(key, { hits, expiresAt: now + windowMs });
    return { count: hits.length, retryAfterMs: 0 };
  }

  memoryBuckets.set(key, { hits, expiresAt: now + windowMs });
  return {
    count: hits.length + 1,
    retryAfterMs: Math.max(hits[0] + windowMs - now, 0),
  };
};

// Opportunistic cleanup so the fallback map cannot grow forever.
const sweepMemory = () => {
  const now = Date.now();
  for (const [key, bucket] of memoryBuckets) {
    const expired = bucket.hits
      ? bucket.hits.every((t) => t <= now - 5 * 60_000)
      : bucket.expiresAt <= now;
    if (expired) memoryBuckets.delete(key);
  }
};

if (!globalForLimiter.__busRateSweep) {
  globalForLimiter.__busRateSweep = setInterval(sweepMemory, 60_000);
  // Do not hold the process open (matters for the standalone worker/CLI usage).
  globalForLimiter.__busRateSweep.unref?.();
}

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------
/**
 * Best-effort client IP. On Vercel `x-forwarded-for` is authoritative and holds
 * `<client>, <proxy…>`; we take the left-most hop. Falls back to `x-real-ip`
 * and finally to a constant so a request with no forwarding headers is still
 * bucketed (shared) rather than unlimited.
 */
export const getClientIp = (req) => {
  const forwarded = req?.headers?.get?.('x-forwarded-for');
  if (forwarded) {
    const first = forwarded.split(',')[0]?.trim();
    if (first) return first;
  }

  return (
    req?.headers?.get?.('x-real-ip') ||
    req?.headers?.get?.('cf-connecting-ip') ||
    'unknown'
  );
};

/**
 * The bucket identity for a request.
 *
 * Authenticated callers are keyed by user id so one noisy user cannot exhaust
 * the allowance of everyone behind the same campus NAT. Anonymous callers are
 * keyed by IP.
 *
 * @param {Request} req
 * @param {{ user?: { id?: string } | null, extra?: string | null }} [ctx]
 */
export const getRateLimitIdentity = (req, ctx = {}) => {
  const userId = ctx.user?.id;
  const base = userId ? `user:${userId}` : `ip:${getClientIp(req)}`;
  return ctx.extra ? `${base}:${String(ctx.extra).toLowerCase()}` : base;
};

// ---------------------------------------------------------------------------
// Core check
// ---------------------------------------------------------------------------
/**
 * Consume one token from `policy` for `identity`.
 *
 * Never throws: on any Redis problem it degrades to the in-process limiter and
 * finally fails open.
 *
 * @returns {Promise<{ allowed: boolean, limit: number, remaining: number,
 *   count: number, retryAfterMs: number, resetAt: number, source: string,
 *   policy: string }>}
 */
export const checkRateLimit = async (policyName, identity, overrides = {}) => {
  const policy = { ...(RATE_LIMITS[policyName] || RATE_LIMITS.DEFAULT), ...overrides };
  const { max, windowMs, algorithm = 'fixed', scope = policyName } = policy;

  const key = `${KEY_PREFIX}:${scope}:${algorithm === 'sliding' ? 'z' : 'c'}:${identity}`;
  const now = Date.now();

  let count = 1;
  let retryAfterMs = 0;
  let source = 'memory';

  const redis = getRedis();

  if (redis && isRedisUsable()) {
    try {
      if (algorithm === 'sliding') {
        const member = `${now}-${Math.random().toString(36).slice(2, 10)}`;
        const [seen, retry] = await redis.eval(
          SLIDING_WINDOW_SCRIPT,
          1,
          key,
          max,
          windowMs,
          now,
          member,
        );
        count = Number(seen);
        retryAfterMs = Number(retry);
      } else {
        const [seen, ttl] = await redis.eval(
          FIXED_WINDOW_SCRIPT,
          1,
          key,
          max,
          windowMs,
        );
        count = Number(seen);
        retryAfterMs = count > max ? Number(ttl) : 0;
      }

      recordRedisSuccess();
      source = 'redis';
    } catch (error) {
      recordRedisFailure(error);
    }
  }

  if (source === 'memory') {
    const fallback =
      algorithm === 'sliding'
        ? memorySlidingWindow(key, max, windowMs, now)
        : memoryFixedWindow(key, max, windowMs);
    count = fallback.count;
    retryAfterMs = fallback.retryAfterMs;
  }

  const allowed = count <= max;

  return {
    allowed,
    limit: max,
    count,
    remaining: Math.max(max - count, 0),
    retryAfterMs: allowed ? 0 : Math.max(Math.ceil(retryAfterMs), 1_000),
    resetAt: now + (allowed ? windowMs : Math.max(retryAfterMs, 0)),
    source,
    policy: policyName,
  };
};

/**
 * Rate-limit headers, including the draft `RateLimit-*` fields so browsers and
 * the frontend can read the remaining allowance without a body round trip.
 */
export const rateLimitHeaders = (result) => ({
  'RateLimit-Limit': String(result.limit),
  'RateLimit-Remaining': String(result.remaining),
  'RateLimit-Reset': String(Math.max(Math.ceil((result.resetAt - Date.now()) / 1000), 0)),
  'X-RateLimit-Limit': String(result.limit),
  'X-RateLimit-Remaining': String(result.remaining),
  'X-RateLimit-Policy': result.policy,
  ...(result.allowed
    ? {}
    : { 'Retry-After': String(Math.ceil(result.retryAfterMs / 1000)) }),
});

/** The 429 body returned when a limit is exceeded. */
export const rateLimitResponse = (result) =>
  NextResponse.json(
    {
      error: 'Too many requests. Please slow down and try again shortly.',
      code: 'RATE_LIMITED',
      retryAfter: Math.ceil(result.retryAfterMs / 1000),
      limit: result.limit,
    },
    { status: 429, headers: rateLimitHeaders(result) },
  );

/**
 * Guard for route handlers. Returns `null` when the request may proceed, or a
 * ready-to-return 429 `NextResponse` when it must be rejected.
 *
 * Usage:
 *   const limited = await enforceRateLimit(req, 'COLLECTION_READ', { user });
 *   if (limited) return limited;
 */
export const enforceRateLimit = async (req, policyName, ctx = {}) => {
  const result = await checkRateLimit(
    policyName,
    getRateLimitIdentity(req, ctx),
    ctx.overrides,
  );

  return result.allowed ? null : rateLimitResponse(result);
};

/** Diagnostics used by the `/api/health` route. */
export const rateLimiterStatus = () => ({
  policies: Object.keys(RATE_LIMITS),
  buckets: memoryBuckets.size,
  redisBacked: Boolean(getRedis()),
});

/**
 * Clears every in-process counter bucket.
 *
 * Exposed mainly so tests can isolate state: the module-level Map is captured at
 * import time, so reassigning `globalThis` cannot reset it. Redis counters are
 * untouched and still expire on their own window.
 */
export const clearRateLimitBuckets = () => {
  memoryBuckets.clear();
};

// Expose the reset hook on globalThis so tooling (notably the test setup) can
// clear this module's state WITHOUT importing it. Importing here would pull in
// `@/lib/redis` and therefore `ioredis` before a test file's `vi.mock` can take
// effect, which would leave the real client in place.
globalForLimiter.__busRateLimitReset = clearRateLimitBuckets;
