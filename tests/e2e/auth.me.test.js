import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { apiRequest, adminUser, passengerUser } from '../helpers/routeHarness';

vi.mock('@/lib/prisma', async () => {
  const { createPrismaMock } = await import('../helpers/prismaMock');
  return { default: createPrismaMock() };
});

let prisma;
let getMe;

beforeAll(async () => {
  prisma = (await import('@/lib/prisma')).default;
  ({ GET: getMe } = await import('@/app/api/auth/me/route'));
});

const admin = adminUser();

beforeEach(() => {
  vi.clearAllMocks();
});

describe('GET /api/auth/me', () => {
  it('requires a bearer token', async () => {
    const response = await getMe(apiRequest('/auth/me'));

    expect(response.status).toBe(401);
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
  });

  it('rejects a malformed token with 401', async () => {
    const response = await getMe(
      apiRequest('/auth/me', { headers: { authorization: 'Bearer nope' } }),
    );

    expect(response.status).toBe(401);
  });

  it('rejects a token whose user no longer exists', async () => {
    prisma.user.findUnique.mockResolvedValue(null);

    const response = await getMe(apiRequest('/auth/me', { user: admin }));

    expect(response.status).toBe(401);
    expect((await response.json()).error).toMatch(/user not found/i);
  });

  it('rejects a deactivated account with 403', async () => {
    prisma.user.findUnique.mockResolvedValue({
      id: admin.id,
      email: admin.email,
      name: admin.name,
      role: admin.role,
      isActive: false,
    });

    const response = await getMe(apiRequest('/auth/me', { user: admin }));

    expect(response.status).toBe(403);
    expect((await response.json()).error).toMatch(/deactivated/i);
  });

  it('returns the session user for every role', async () => {
    const passenger = passengerUser();
    prisma.user.findUnique.mockResolvedValue({
      id: passenger.id,
      email: passenger.email,
      name: passenger.name,
      role: passenger.role,
      isActive: true,
    });

    const response = await getMe(apiRequest('/auth/me', { user: passenger }));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.user).toEqual({
      id: 'passenger-1',
      email: 'passenger@campus.edu',
      name: passenger.name,
      role: 'PASSENGER',
      isActive: true,
    });
    // The route is a session probe; it must not leak the password hash.
    expect(body.user.password).toBeUndefined();
  });
});
