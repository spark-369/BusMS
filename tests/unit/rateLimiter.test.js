import { beforeEach, describe, expect, it, vi } from 'vitest';

// No Redis -> exercises the in-memory fallback.
import {
  checkRateLimit,
  enforceRateLimit,
  getClientIp,
  getRateLimitIdentity,
  RATE_LIMITS,
  rateLimitHeaders,
  rateLimiterStatus,
  rateLimitResponse,
} from '@/lib/rateLimiter';

beforeEach(() => {
  vi.useRealTimers();
});

describe('getClientIp', () => {
  const reqWith = (headers) => new Request('http://localhost/api/x', { headers });

  it('takes the left-most x-forwarded-for hop (the real client)', () => {
    // Vercel appends proxies to the right; the client is the first entry.
    expect(
      getClientIp(reqWith({ 'x-forwarded-for': '203.0.113.7, 70.41.3.18' })),
    ).toBe('203.0.113.7');
  });

  it('trims whitespace around the hop', () => {
    expect(getClientIp(reqWith({ 'x-forwarded-for': '  198.51.100.2  ' }))).toBe(
      '198.51.100.2',
    );
  });

  it('falls back to x-real-ip', () => {
    expect(getClientIp(reqWith({ 'x-real-ip': '198.51.100.9' }))).toBe('198.51.100.9');
  });

  it('falls back to cf-connecting-ip', () => {
    expect(getClientIp(reqWith({ 'cf-connecting-ip': '198.51.100.4' }))).toBe(
      '198.51.100.4',
    );
  });

  it('returns "unknown" when no forwarding header exists', () => {
    // Still bucketed (shared) rather than treated as unlimited.
    expect(getClientIp(reqWith({}))).toBe('unknown');
  });

  it('tolerates a missing request', () => {
    expect(getClientIp(undefined)).toBe('unknown');
  });
});

describe('getRateLimitIdentity', () => {
  const req = () =>
    new Request('http://localhost/api/x', {
      headers: { 'x-forwarded-for': '203.0.113.7' },
    });

  it('keys authenticated callers by user id', () => {
    // Prevents one noisy user from exhausting the allowance of everyone
    // sharing a campus NAT.
    expect(getRateLimitIdentity(req(), { user: { id: 'u1' } })).toBe('user:u1');
  });

  it('keys anonymous callers by IP', () => {
    expect(getRateLimitIdentity(req(), {})).toBe('ip:203.0.113.7');
    expect(getRateLimitIdentity(req())).toBe('ip:203.0.113.7');
  });

  it('appends a lowercased extra discriminator', () => {
    expect(getRateLimitIdentity(req(), { extra: 'USER@Example.COM' })).toBe(
      'ip:203.0.113.7:user@example.com',
    );
  });

  it('prefers the user id over the IP when both are present', () => {
    expect(getRateLimitIdentity(req(), { user: { id: 'u9' }, extra: 'e' })).toBe(
      'user:u9:e',
    );
  });
});

describe('checkRateLimit (fixed window, memory fallback)', () => {
  it('allows requests up to the limit then blocks', async () => {
    const policy = { max: 3, windowMs: 60_000 };
    const identity = 'ip:fixed-test';

    for (let i = 1; i <= 3; i += 1) {
      const result = await checkRateLimit('DEFAULT', identity, policy);
      expect(result.allowed).toBe(true);
      expect(result.count).toBe(i);
      expect(result.remaining).toBe(3 - i);
    }

    const blocked = await checkRateLimit('DEFAULT', identity, policy);
    expect(blocked.allowed).toBe(false);
    expect(blocked.count).toBe(4);
    expect(blocked.remaining).toBe(0);
    expect(blocked.retryAfterMs).toBeGreaterThan(0);
  });

  it('keeps separate buckets per identity', async () => {
    const policy = { max: 1, windowMs: 60_000 };

    const first = await checkRateLimit('DEFAULT', 'ip:a', policy);
    const other = await checkRateLimit('DEFAULT', 'ip:b', policy);

    expect(first.allowed).toBe(true);
    expect(other.allowed).toBe(true);
    expect(other.count).toBe(1);
  });

  it('resets once the window elapses', async () => {
    vi.useFakeTimers();

    const policy = { max: 1, windowMs: 1_000 };
    const identity = 'ip:window-reset';

    expect((await checkRateLimit('DEFAULT', identity, policy)).allowed).toBe(true);
    expect((await checkRateLimit('DEFAULT', identity, policy)).allowed).toBe(false);

    vi.advanceTimersByTime(1_001);

    const afterWindow = await checkRateLimit('DEFAULT', identity, policy);
    expect(afterWindow.allowed).toBe(true);
    expect(afterWindow.count).toBe(1);
  });

  it('never reports a retryAfter below one second when blocked', async () => {
    const policy = { max: 1, windowMs: 60_000 };
    const identity = 'ip:min-retry';

    await checkRateLimit('DEFAULT', identity, policy);
    const blocked = await checkRateLimit('DEFAULT', identity, policy);

    expect(blocked.retryAfterMs).toBeGreaterThanOrEqual(1_000);
  });

  it('reports the source as memory when Redis is absent', async () => {
    const result = await checkRateLimit('DEFAULT', 'ip:source');
    expect(result.source).toBe('memory');
  });
});

describe('checkRateLimit (sliding window, memory fallback)', () => {
  it('blocks exactly at the limit without a boundary burst', async () => {
    const policy = { max: 2, windowMs: 60_000, algorithm: 'sliding' };
    const identity = 'ip:sliding';

    expect((await checkRateLimit('LOGIN', identity, policy)).allowed).toBe(true);
    expect((await checkRateLimit('LOGIN', identity, policy)).allowed).toBe(true);

    const blocked = await checkRateLimit('LOGIN', identity, policy);
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterMs).toBeGreaterThan(0);

    // Regression guard for a silent security bug: the blocked path must report
    // `max + 1`, because the decision is `count <= max`. Returning the raw hit
    // count (== max) made a full window read as ALLOWED, so the limiter never
    // blocked and LOGIN/REGISTER/QR_VERIFY had no brute-force protection.
    expect(blocked.count).toBe(policy.max + 1);
  });

  it('never allows more than `max` requests through a sliding window', async () => {
    const policy = { max: 3, windowMs: 60_000, algorithm: 'sliding' };
    const identity = 'ip:sliding-cap';

    const outcomes = [];
    for (let i = 0; i < 10; i += 1) {
      const result = await checkRateLimit('LOGIN', identity, policy);
      outcomes.push(result.allowed);
    }

    // This is the property the bug violated: the ceiling must actually hold.
    expect(outcomes.filter(Boolean)).toHaveLength(policy.max);
  });

  it('releases capacity as individual hits age out', async () => {
    vi.useFakeTimers();

    const policy = { max: 2, windowMs: 1_000, algorithm: 'sliding' };
    const identity = 'ip:sliding-age';

    await checkRateLimit('LOGIN', identity, policy);
    vi.advanceTimersByTime(400);
    await checkRateLimit('LOGIN', identity, policy);

    // Window full at t=400ms.
    expect((await checkRateLimit('LOGIN', identity, policy)).allowed).toBe(false);

    // At t=1001ms the first hit (t=0) has aged out, freeing one slot, while the
    // second (t=400) is still inside the window.
    vi.advanceTimersByTime(601);
    expect((await checkRateLimit('LOGIN', identity, policy)).allowed).toBe(true);
  });
});

describe('rateLimitHeaders', () => {
  it('emits standard and X- prefixed headers', () => {
    const headers = rateLimitHeaders({
      limit: 10,
      remaining: 7,
      resetAt: Date.now() + 30_000,
      policy: 'LOGIN',
      allowed: true,
    });

    expect(headers['RateLimit-Limit']).toBe('10');
    expect(headers['RateLimit-Remaining']).toBe('7');
    expect(headers['X-RateLimit-Limit']).toBe('10');
    expect(headers['X-RateLimit-Policy']).toBe('LOGIN');
    expect(headers['Retry-After']).toBeUndefined();
  });

  it('adds Retry-After when blocked', () => {
    const headers = rateLimitHeaders({
      limit: 10,
      remaining: 0,
      resetAt: Date.now() + 5_000,
      retryAfterMs: 5_000,
      policy: 'LOGIN',
      allowed: false,
    });

    expect(headers['Retry-After']).toBe('5');
  });
});

describe('rateLimitResponse', () => {
  it('returns a 429 with the documented body shape', async () => {
    const response = rateLimitResponse({
      limit: 10,
      remaining: 0,
      retryAfterMs: 30_000,
      resetAt: Date.now() + 30_000,
      policy: 'LOGIN',
      allowed: false,
    });

    expect(response.status).toBe(429);

    const body = await response.json();
    expect(body.code).toBe('RATE_LIMITED');
    expect(body.retryAfter).toBe(30);
    expect(body.limit).toBe(10);
    expect(body.error).toMatch(/too many requests/i);
    expect(response.headers.get('Retry-After')).toBe('30');
  });
});

describe('enforceRateLimit', () => {
  const req = () =>
    new Request('http://localhost/api/buses', {
      headers: { 'x-forwarded-for': '203.0.113.50' },
    });

  it('returns null while the request is allowed', async () => {
    const limited = await enforceRateLimit(req(), 'COLLECTION_READ', {
      user: { id: 'u-allow' },
    });
    expect(limited).toBeNull();
  });

  it('returns a 429 NextResponse once exhausted', async () => {
    const ctx = {
      user: { id: 'u-block' },
      overrides: { max: 1, windowMs: 60_000 },
    };

    expect(await enforceRateLimit(req(), 'COLLECTION_READ', ctx)).toBeNull();

    const limited = await enforceRateLimit(req(), 'COLLECTION_READ', ctx);
    expect(limited).not.toBeNull();
    expect(limited.status).toBe(429);

    const body = await limited.json();
    expect(body.code).toBe('RATE_LIMITED');
  });
});

describe('policy definitions', () => {
  it('applies sliding windows to the abuse-sensitive endpoints', () => {
    // Sliding is chosen where a boundary burst would matter (credential
    // stuffing, QR boarding).
    expect(RATE_LIMITS.LOGIN.algorithm).toBe('sliding');
    expect(RATE_LIMITS.REGISTER.algorithm).toBe('sliding');
    expect(RATE_LIMITS.QR_VERIFY.algorithm).toBe('sliding');
  });

  it('caps broadcasts more tightly than ordinary writes', () => {
    expect(RATE_LIMITS.BROADCAST.max).toBeLessThan(RATE_LIMITS.COLLECTION_WRITE.max);
  });

  it('gives every policy a positive max, window and scope', () => {
    for (const [name, policy] of Object.entries(RATE_LIMITS)) {
      expect(policy.max, `${name}.max`).toBeGreaterThan(0);
      expect(policy.windowMs, `${name}.windowMs`).toBeGreaterThan(0);
      expect(policy.scope, `${name}.scope`).toBeTruthy();
    }
  });
});

describe('rateLimiterStatus', () => {
  it('reports the policy list and that Redis is not backing it', () => {
    const status = rateLimiterStatus();
    expect(status.policies).toContain('LOGIN');
    expect(status.redisBacked).toBe(false);
  });
});
