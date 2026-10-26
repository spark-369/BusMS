import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import bcrypt from 'bcryptjs';

import { buildUser } from '../helpers/prismaMock';

// The async factory is required: `vi.mock` is hoisted above the imports, so it
// cannot reference a module-scope variable. See tests/helpers/prismaMock.js.
vi.mock('@/lib/prisma', async () => {
  const { createPrismaMock } = await import('../helpers/prismaMock');
  return { default: createPrismaMock() };
});

// No Redis -> the limiter uses its in-memory fallback, which makes the 429
// assertions deterministic without a Redis server.
delete process.env.REDIS_URL;

let prisma;
let login;

beforeAll(async () => {
  prisma = (await import('@/lib/prisma')).default;
  ({ POST: login } = await import('@/app/api/auth/login/route'));
});

/** A real password hash so `bcrypt.compare` behaves as it does in production. */
const PASSWORD = 'correct-horse-battery-staple';
let passwordHash;

const loginRequest = (body, ip = '203.0.113.10') =>
  new Request('http://localhost/api/auth/login', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-forwarded-for': ip,
    },
    body: JSON.stringify(body),
  });

beforeEach(async () => {
  vi.clearAllMocks();
  // Hashing is deliberately slow, so it is computed once and reused.
  passwordHash ??= await bcrypt.hash(PASSWORD, 4);
  prisma.user.findUnique.mockResolvedValue(buildUser({ password: passwordHash }));
  prisma.activityLog.create.mockResolvedValue({ id: 'log-1' });
});

describe('POST /api/auth/login', () => {
  it('returns a token and the user on valid credentials', async () => {
    const response = await login(
      loginRequest({ email: 'admin@campus.edu', password: PASSWORD }),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.token).toEqual(expect.any(String));
    expect(body.user.email).toBe('admin@campus.edu');
    // The password hash must never leave the server.
    expect(body.user.password).toBeUndefined();
  });

  it('advertises the remaining rate-limit allowance in the headers', async () => {
    const response = await login(
      loginRequest({ email: 'admin@campus.edu', password: PASSWORD }, '203.0.113.11'),
    );

    expect(response.headers.get('RateLimit-Limit')).toBe('10');
    expect(Number(response.headers.get('RateLimit-Remaining'))).toBeLessThan(10);
    expect(response.headers.get('X-RateLimit-Policy')).toBe('LOGIN');
  });

  it('rejects a missing body with 400', async () => {
    const response = await login(loginRequest({}));

    expect(response.status).toBe(400);
    expect((await response.json()).error).toMatch(/required/i);
  });

  it('rejects an unknown email with 401', async () => {
    prisma.user.findUnique.mockResolvedValue(null);

    const response = await login(
      loginRequest({ email: 'nobody@campus.edu', password: 'x' }),
    );
    expect(response.status).toBe(401);
    expect((await response.json()).error).toBe('Invalid credentials');
  });

  it('rejects a wrong password with 401', async () => {
    const response = await login(
      loginRequest({ email: 'admin@campus.edu', password: 'wrong-password' }),
    );

    expect(response.status).toBe(401);
    expect((await response.json()).error).toBe('Invalid credentials');
  });

  it('rejects a deactivated account with 403', async () => {
    prisma.user.findUnique.mockResolvedValue(
      buildUser({ password: passwordHash, isActive: false }),
    );

    const response = await login(
      loginRequest({ email: 'admin@campus.edu', password: PASSWORD }),
    );
    expect(response.status).toBe(403);
    expect((await response.json()).error).toMatch(/deactivated/i);
  });

  it('returns 429 with Retry-After once the per-IP limit is exceeded', async () => {
    const ip = '203.0.113.99';

    // The LOGIN policy allows 10 requests per window.
    for (let i = 0; i < 10; i += 1) {
      const response = await login(
        loginRequest({ email: 'admin@campus.edu', password: PASSWORD }, ip),
      );
      expect(response.status).toBe(200);
    }

    const blocked = await login(
      loginRequest({ email: 'admin@campus.edu', password: PASSWORD }, ip),
    );
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get('Retry-After')).toBeTruthy();

    const body = await blocked.json();
    expect(body.code).toBe('RATE_LIMITED');
    expect(body.retryAfter).toBeGreaterThan(0);
  });

  it('limits per email too, so a distributed attack on one account is stopped', async () => {
    const email = 'target@campus.edu';

    // A different IP on every attempt: the per-IP bucket never fills, but the
    // per-email bucket must.
    for (let i = 0; i < 10; i += 1) {
      const response = await login(
        loginRequest({ email, password: PASSWORD }, `198.51.100.${i}`),
      );
      expect(response.status).toBe(200);
    }

    const blocked = await login(
      loginRequest({ email, password: PASSWORD }, '198.51.100.250'),
    );
    expect(blocked.status).toBe(429);
    expect((await blocked.json()).code).toBe('RATE_LIMITED');
  });

  it('blocks before touching the database once limited', async () => {
    const ip = '203.0.113.123';
    for (let i = 0; i < 10; i += 1) {
      await login(loginRequest({ email: 'admin@campus.edu', password: PASSWORD }, ip));
    }

    prisma.user.findUnique.mockClear();
    const blocked = await login(
      loginRequest({ email: 'admin@campus.edu', password: PASSWORD }, ip),
    );

    expect(blocked.status).toBe(429);
    // The limiter must short-circuit ahead of the (expensive) lookup + bcrypt.
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
  });

  it('writes the audit entry (inline, since Redis is unset)', async () => {
    await login(
      loginRequest({ email: 'admin@campus.edu', password: PASSWORD }, '203.0.113.77'),
    );

    expect(prisma.activityLog.create).toHaveBeenCalledTimes(1);
    const { data } = prisma.activityLog.create.mock.calls[0][0];
    expect(data.action).toBe('LOGIN');
    expect(data.ipAddress).toBe('203.0.113.77');
  });

  it('returns 500 when the database throws', async () => {
    prisma.user.findUnique.mockRejectedValue(new Error('connection lost'));

    const response = await login(
      loginRequest({ email: 'admin@campus.edu', password: PASSWORD }, '203.0.113.200'),
    );

    expect(response.status).toBe(500);
  });
});
