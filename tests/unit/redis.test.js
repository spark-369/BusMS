import { beforeEach, describe, expect, it, vi } from 'vitest';

// `vi.hoisted` is required because `vi.mock` factories are hoisted above the
// file's imports — a factory closing over a plain module-scope const would throw
// "Cannot access 'redisInstances' before initialization".
const { redisInstances } = vi.hoisted(() => ({ redisInstances: [] }));

vi.mock('ioredis', async () => {
  const { FakeRedis } = await import('../helpers/fakeRedis');
  return {
    default: class extends FakeRedis {
      constructor() {
        super();
        redisInstances.push(this);
      }
    },
  };
});

// Redis IS configured for this suite, so the Redis-backed branches run.
process.env.REDIS_URL = 'redis://fake:6379';

const { FakeRedis, resetFakeRedis } = await import('../helpers/fakeRedis');
const {
  createQueueConnection,
  getRedis,
  getRedisUrl,
  isRedisConfigured,
  isRedisUsable,
  recordRedisFailure,
  recordRedisSuccess,
  redisStatus,
  resetRedisState,
} = await import('@/lib/redis');
const { CACHE_NAMESPACES, invalidateNamespace, withCache } = await import('@/lib/cache');
const { checkRateLimit } = await import('@/lib/rateLimiter');

beforeEach(() => {
  resetFakeRedis();
  vi.useRealTimers();
  // `redisInstances` is a hoisted array that lives for the whole file, and the
  // afterEach hook drops the cached client so each test constructs a fresh one.
  // Without this reset the length assertions would accumulate across tests.
  redisInstances.length = 0;
});

describe('connection management', () => {
  it('reports Redis as configured', () => {
    expect(isRedisConfigured()).toBe(true);
    expect(getRedisUrl()).toBe('redis://fake:6379');
  });

  it('reuses a single shared client across calls', () => {
    const first = getRedis();
    const second = getRedis();

    // Reusing the client is what stops a hot reload (or every request) from
    // leaking a new socket.
    expect(first).toBe(second);
    expect(redisInstances.length).toBe(1);
  });

  it('creates a separate connection for BullMQ', () => {
    getRedis();
    const queueConnection = createQueueConnection();

    // BullMQ needs maxRetriesPerRequest: null, so it must NOT share the app
    // client — this separation is load-bearing.
    expect(queueConnection).toBeInstanceOf(FakeRedis);
    expect(queueConnection).not.toBe(getRedis());
  });

  it('attaches an error listener so a failure cannot crash the process', () => {
    const client = getRedis();
    expect(client.handlers.has('error')).toBe(true);
    // Emitting must not throw.
    expect(() => client.emit('error', new Error('boom'))).not.toThrow();
  });

  it('returns null from createQueueConnection when unconfigured', () => {
    const saved = process.env.REDIS_URL;
    delete process.env.REDIS_URL;

    expect(createQueueConnection()).toBeNull();

    process.env.REDIS_URL = saved;
  });
});

describe('circuit breaker', () => {
  it('treats a ready client as usable', () => {
    getRedis();
    expect(isRedisUsable()).toBe(true);
  });

  it('opens after three consecutive failures and skips Redis', () => {
    getRedis();

    // Below the threshold nothing changes.
    recordRedisFailure(new Error('e1'));
    recordRedisFailure(new Error('e2'));
    expect(isRedisUsable()).toBe(true);

    // Third failure trips it. Without this, every request during an outage
    // would pay a connection timeout instead of falling back to memory.
    recordRedisFailure(new Error('e3'));
    expect(isRedisUsable()).toBe(false);
  });

  it('a success resets the failure counter', () => {
    getRedis();

    recordRedisFailure(new Error('e1'));
    recordRedisFailure(new Error('e2'));
    recordRedisSuccess();
    recordRedisFailure(new Error('e3'));
    recordRedisFailure(new Error('e4'));

    // Still only 2 failures since the reset, so the breaker stays closed.
    expect(isRedisUsable()).toBe(true);
  });

  it('is process-global state that must be resettable', () => {
    getRedis();
    recordRedisFailure(new Error('e1'));
    recordRedisFailure(new Error('e2'));
    recordRedisFailure(new Error('e3'));
    expect(isRedisUsable()).toBe(false);

    // Regression guard: the breaker used to be captured in a module-level
    // `const`, so deleting the `globalThis` reference did NOT reset it and a
    // single tripped breaker silently disabled Redis for the whole process
    // (including every later test). `resetRedisState` is the supported reset.
    resetRedisState();

    expect(isRedisUsable()).toBe(true);
  });

  it('exposes the reset hook on globalThis for tooling that cannot import it', () => {
    expect(typeof globalThis.__busRedisReset).toBe('function');
  });

  it('exposes the trip time in redisStatus', () => {
    getRedis();
    recordRedisFailure(new Error('e1'));
    recordRedisFailure(new Error('e2'));
    recordRedisFailure(new Error('e3'));

    const status = redisStatus();
    expect(status.circuitOpenUntil).toBeGreaterThan(Date.now());
    expect(status.usable).toBe(false);
  });

  it('closes again after the cooldown elapses', () => {
    vi.useFakeTimers();

    getRedis();
    recordRedisFailure(new Error('e1'));
    recordRedisFailure(new Error('e2'));
    recordRedisFailure(new Error('e3'));
    expect(isRedisUsable()).toBe(false);

    vi.advanceTimersByTime(30_001);
    expect(isRedisUsable()).toBe(true);
  });
});

describe('cache over Redis', () => {
  it('writes to Redis and serves hits from it', async () => {
    const producer = vi.fn().mockResolvedValue({ buses: ['a'] });

    const first = await withCache(CACHE_NAMESPACES.BUSES, 'default', producer);
    expect(first.cache).toBe('MISS');

    const second = await withCache(CACHE_NAMESPACES.BUSES, 'default', producer);
    expect(second.cache).toBe('HIT');
    expect(second.source).toBe('redis');
    expect(producer).toHaveBeenCalledTimes(1);
  });

  it('stores the namespace version in Redis so it is shared across instances', async () => {
    const client = getRedis();
    await withCache(CACHE_NAMESPACES.BUSES, 'default', async () => ({ buses: [] }));

    await invalidateNamespace(CACHE_NAMESPACES.BUSES);

    // A single INCR — not a KEYS/SCAN sweep — is what invalidates the namespace.
    expect(await client.get('bus:cachever:buses')).toBe('1');
  });

  it('falls back to memory when a Redis command fails', async () => {
    getRedis();
    const producer = vi.fn().mockResolvedValue({ buses: ['fallback'] });

    // First call populates both Redis and the memory mirror.
    const first = await withCache(CACHE_NAMESPACES.BUSES, 'default', producer);
    expect(first.cache).toBe('MISS');

    // Now break Redis: the read must still succeed from memory.
    getRedis().failWith = new Error('connection lost');

    const second = await withCache(CACHE_NAMESPACES.BUSES, 'default', producer);
    expect(second.cache).toBe('HIT');
    expect(second.source).toBe('memory');
    expect(producer).toHaveBeenCalledTimes(1);
  });

  it('fails open (still serves data) when Redis is down on a cold cache', async () => {
    getRedis().failWith = new Error('connection refused');

    const result = await withCache(CACHE_NAMESPACES.BUSES, 'default', async () => ({
      buses: ['from-db'],
    }));

    expect(result.data).toEqual({ buses: ['from-db'] });
    expect(result.cache).toBe('MISS');
  });
});

describe('rate limiting over Redis', () => {
  it('uses the Lua fixed-window script and reports redis as the source', async () => {
    const policy = { max: 2, windowMs: 60_000 };
    const identity = 'ip:lua-fixed';

    const first = await checkRateLimit('DEFAULT', identity, policy);
    expect(first.source).toBe('redis');
    expect(first.allowed).toBe(true);

    expect((await checkRateLimit('DEFAULT', identity, policy)).allowed).toBe(true);

    const blocked = await checkRateLimit('DEFAULT', identity, policy);
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterMs).toBeGreaterThan(0);
  });

  it('uses the Lua sliding-window script', async () => {
    const policy = { max: 2, windowMs: 60_000, algorithm: 'sliding' };
    const identity = 'ip:lua-sliding';

    expect((await checkRateLimit('LOGIN', identity, policy)).allowed).toBe(true);
    expect((await checkRateLimit('LOGIN', identity, policy)).allowed).toBe(true);

    const blocked = await checkRateLimit('LOGIN', identity, policy);
    expect(blocked.allowed).toBe(false);
    // The Lua script must report the attempted count (max + 1); returning the
    // raw ZCARD made a full window read as ALLOWED and disabled the limit.
    expect(blocked.count).toBe(policy.max + 1);
  });

  it('enforces the ceiling through the Lua script', async () => {
    const policy = { max: 3, windowMs: 60_000, algorithm: 'sliding' };
    const identity = 'ip:lua-cap';

    const outcomes = [];
    for (let i = 0; i < 8; i += 1) {
      const result = await checkRateLimit('LOGIN', identity, policy);
      outcomes.push(result.allowed);
    }

    expect(outcomes.filter(Boolean)).toHaveLength(policy.max);
  });

  it('shares the counter across independent checks (distributed limiting)', async () => {
    const policy = { max: 3, windowMs: 60_000 };
    const identity = 'ip:shared';

    // Concurrent checks share one Redis counter, so the allowance is global
    // rather than per-process. The Lua script is what makes this race-free.
    const results = await Promise.all([
      checkRateLimit('DEFAULT', identity, policy),
      checkRateLimit('DEFAULT', identity, policy),
      checkRateLimit('DEFAULT', identity, policy),
      checkRateLimit('DEFAULT', identity, policy),
    ]);

    const allowed = results.filter((r) => r.allowed).length;
    expect(allowed).toBe(3);
    expect(results.filter((r) => !r.allowed).length).toBe(1);
  });

  it('degrades to the memory limiter when a command fails', async () => {
    const policy = { max: 1, windowMs: 60_000 };
    const identity = 'ip:degrade';

    await checkRateLimit('DEFAULT', identity, policy);

    getRedis().failWith = new Error('redis down');

    // Fail-open: the request is allowed and counted in memory, rather than the
    // whole API returning 500 because the limiter broke.
    const afterFailure = await checkRateLimit('DEFAULT', identity, policy);
    expect(afterFailure.source).toBe('memory');
    expect(afterFailure.allowed).toBe(true);
  });

  it('skips Redis entirely while the circuit breaker is open', async () => {
    getRedis();
    recordRedisFailure(new Error('e1'));
    recordRedisFailure(new Error('e2'));
    recordRedisFailure(new Error('e3'));

    const result = await checkRateLimit('DEFAULT', 'ip:breaker', {
      max: 5,
      windowMs: 60_000,
    });

    expect(result.source).toBe('memory');
    expect(result.allowed).toBe(true);
  });
});
