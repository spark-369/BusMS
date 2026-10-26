import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildAuthUser, buildUser } from '../helpers/prismaMock';

vi.mock('@/lib/prisma', async () => {
  const { createPrismaMock } = await import('../helpers/prismaMock');
  return { default: createPrismaMock() };
});

// Redis deliberately unset: this asserts the documented degraded mode that a
// deployment without a Redis add-on will report.
delete process.env.REDIS_URL;

let prisma;
let generateToken;
let getHealth;

beforeAll(async () => {
  prisma = (await import('@/lib/prisma')).default;
  ({ generateToken } = await import('@/utils/jwt'));
  ({ GET: getHealth } = await import('@/app/api/health/route'));
});

const authedRequest = (user) =>
  new Request('http://localhost/api/health', {
    headers: {
      authorization: `Bearer ${generateToken({
        userId: user.id,
        email: user.email,
        role: user.role,
      })}`,
      'x-forwarded-for': '203.0.113.80',
    },
  });

const admin = buildUser({ id: 'admin-1', role: 'ADMIN' });

beforeEach(() => {
  vi.clearAllMocks();
  prisma.user.findUnique.mockResolvedValue(buildAuthUser(admin));
});

describe('GET /api/health', () => {
  it('requires authentication', async () => {
    const response = await getHealth(new Request('http://localhost/api/health'));
    expect(response.status).toBe(401);
  });

  it('restricts the endpoint to admins', async () => {
    const passenger = buildUser({ id: 'p1', role: 'PASSENGER' });
    prisma.user.findUnique.mockResolvedValue(buildAuthUser(passenger));

    const response = await getHealth(authedRequest(passenger));
    expect(response.status).toBe(403);
  });

  it('reports the degraded (no-Redis) delivery mode', async () => {
    const response = await getHealth(authedRequest(admin));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.status).toBe('ok');

    // Redis absent -> in-memory cache/limiter and inline job execution.
    expect(body.redis.configured).toBe(false);
    expect(body.queue.deliveryMode).toBe('inline');
    expect(body.queue.workerRequired).toBe(false);
    expect(body.audit.mode).toBe('inline');
    expect(body.rateLimiter.redisBacked).toBe(false);
  });

  it('exposes cache diagnostics', async () => {
    const body = await (await getHealth(authedRequest(admin))).json();

    expect(body.cache).toHaveProperty('entries');
    expect(body.cache).toHaveProperty('versions');
    expect(body.cache.defaultTtlSeconds).toBeGreaterThan(0);
  });

  it('lists the active rate-limit policies', async () => {
    const body = await (await getHealth(authedRequest(admin))).json();

    expect(body.rateLimiter.policies).toContain('LOGIN');
    expect(body.rateLimiter.policies).toContain('BROADCAST');
  });

  it('includes an ISO timestamp', async () => {
    const body = await (await getHealth(authedRequest(admin))).json();
    expect(new Date(body.timestamp).toISOString()).toBe(body.timestamp);
  });
});
