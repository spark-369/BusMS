import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  apiRequest,
  mockUserLookups,
  primeSideEffects,
} from '../helpers/routeHarness';

vi.mock('@/lib/prisma', async () => {
  const { createPrismaMock } = await import('../helpers/prismaMock');
  return { default: createPrismaMock() };
});

// No Redis -> the limiter uses its in-memory sliding window, which makes the
// 429 assertions deterministic without a Redis server.
delete process.env.REDIS_URL;

let prisma;
let register;

beforeAll(async () => {
  prisma = (await import('@/lib/prisma')).default;
  ({ POST: register } = await import('@/app/api/auth/register/route'));
});

const post = (body, ip = '203.0.113.10') =>
  register(apiRequest('/auth/register', { method: 'POST', body, ip }));

const validPassenger = {
  email: 'new-passenger@campus.edu',
  password: 'secret123',
  name: 'New Passenger',
  role: 'PASSENGER',
  passengerId: 'P-999',
};

beforeEach(() => {
  vi.clearAllMocks();
  // No user exists yet unless a test says otherwise.
  mockUserLookups(prisma, {});
  primeSideEffects(prisma);
});

describe('POST /api/auth/register', () => {
  it('requires email, password and name', async () => {
    const response = await post({ email: 'a@campus.edu' });

    expect(response.status).toBe(400);
    expect((await response.json()).error).toMatch(/required/i);
  });

  it('rejects a malformed email address', async () => {
    const response = await post({ ...validPassenger, email: 'not-an-email' });

    expect(response.status).toBe(400);
    expect((await response.json()).error).toMatch(/valid email/i);
  });

  it('rejects a password shorter than six characters', async () => {
    const response = await post({ ...validPassenger, password: '12345' });

    expect(response.status).toBe(400);
    expect((await response.json()).error).toMatch(/at least 6/i);
  });

  it('never allows public self-registration to mint an ADMIN', async () => {
    // The privilege-escalation guard: the allow-list is server-side, so the
    // client cannot promote itself regardless of the payload.
    const response = await post({
      ...validPassenger,
      role: 'ADMIN',
      passengerId: undefined,
    });

    expect(response.status).toBe(403);
    expect((await response.json()).error).toMatch(/invalid role/i);
    expect(prisma.user.create).not.toHaveBeenCalled();
  });

  it('requires a passenger ID for passenger registration', async () => {
    const response = await post({ ...validPassenger, passengerId: undefined });

    expect(response.status).toBe(400);
    expect((await response.json()).error).toMatch(/passenger id is required/i);
  });

  it('requires a licence number for driver registration', async () => {
    const response = await post({
      email: 'new-driver@campus.edu',
      password: 'secret123',
      name: 'New Driver',
      role: 'DRIVER',
    });

    expect(response.status).toBe(400);
    expect((await response.json()).error).toMatch(/license number is required/i);
  });

  it('rejects an email that is already registered', async () => {
    mockUserLookups(prisma, {
      'new-passenger@campus.edu': { id: 'existing-1', email: 'new-passenger@campus.edu' },
    });

    const response = await post(validPassenger);

    expect(response.status).toBe(400);
    expect((await response.json()).error).toMatch(/already registered/i);
  });

  it('registers a passenger, hashes the password and returns a token', async () => {
    prisma.user.create.mockResolvedValue({
      id: 'user-9',
      email: validPassenger.email,
      name: validPassenger.name,
      role: 'PASSENGER',
      passengerId: 'P-999',
      licenseNumber: null,
      isActive: true,
      password: '$2a$12$hashed',
    });

    const response = await post(validPassenger);
    const body = await response.json();

    expect(response.status).toBe(201);
    expect(body.token).toEqual(expect.any(String));
    expect(body.user.password).toBeUndefined();
    expect(body.user.role).toBe('PASSENGER');

    // The stored hash must never equal the plaintext.
    const { data } = prisma.user.create.mock.calls[0][0];
    expect(data.password).not.toBe(validPassenger.password);
    expect(data.passengerId).toBe('P-999');
    expect(data.licenseNumber).toBeNull();
  });

  it('advertises the remaining rate-limit allowance', async () => {
    prisma.user.create.mockResolvedValue({
      id: 'user-9',
      email: validPassenger.email,
      name: validPassenger.name,
      role: 'PASSENGER',
      password: 'hashed',
    });

    const response = await post(validPassenger, '203.0.113.20');

    expect(response.headers.get('RateLimit-Limit')).toBe('5');
    expect(response.headers.get('X-RateLimit-Policy')).toBe('REGISTER');
  });

  it('returns 429 once the per-IP registration limit is exceeded', async () => {
    const ip = '203.0.113.30';

    // The REGISTER policy allows 5 requests per window. Bodies are deliberately
    // invalid so the limiter (not bcrypt) is what the test exercises.
    for (let i = 0; i < 5; i += 1) {
      const response = await post({}, ip);
      expect(response.status).toBe(400);
    }

    const blocked = await post({}, ip);

    expect(blocked.status).toBe(429);
    expect(blocked.headers.get('Retry-After')).toBeTruthy();
    expect((await blocked.json()).code).toBe('RATE_LIMITED');
  });

  it('returns 500 when the database throws', async () => {
    prisma.user.findUnique.mockRejectedValue(new Error('connection lost'));

    const response = await post(validPassenger, '203.0.113.40');

    expect(response.status).toBe(500);
  });
});
