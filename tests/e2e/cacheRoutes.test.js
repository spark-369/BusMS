import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildAuthUser, buildUser } from '../helpers/prismaMock';

vi.mock('@/lib/prisma', async () => {
  const { createPrismaMock } = await import('../helpers/prismaMock');
  return { default: createPrismaMock() };
});

delete process.env.REDIS_URL;

let prisma;
let generateToken;
let getBuses;
let createBus;
let getNotifications;

beforeAll(async () => {
  prisma = (await import('@/lib/prisma')).default;
  ({ generateToken } = await import('@/utils/jwt'));
  ({ GET: getBuses, POST: createBus } = await import('@/app/api/buses/route'));
  ({ GET: getNotifications } = await import('@/app/api/notifications/route'));
});

const authedRequest = (url, { method = 'GET', user, body } = {}) => {
  const token = generateToken({
    userId: user.id,
    email: user.email,
    role: user.role,
  });

  return new Request(url, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      'x-forwarded-for': '203.0.113.60',
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
};

/** The auth middleware re-loads the user from the DB on every request. */
const actingAs = (user) => {
  prisma.user.findUnique.mockResolvedValue(buildAuthUser(user));
};

const admin = buildUser({ id: 'admin-1', role: 'ADMIN' });
const passenger = buildUser({
  id: 'passenger-1',
  role: 'PASSENGER',
  email: 'passenger@campus.edu',
});

beforeEach(() => {
  vi.clearAllMocks();
  prisma.activityLog.create.mockResolvedValue({ id: 'log-1' });
  prisma.notification.create.mockImplementation(async ({ data }) => ({
    id: 'n1',
    ...data,
  }));
});

describe('GET /api/buses — caching', () => {
  it('serves the second identical request from cache', async () => {
    actingAs(admin);
    prisma.bus.findMany.mockResolvedValue([{ id: 'bus-1', busNumber: 'B1' }]);

    const first = await getBuses(authedRequest('http://localhost/api/buses', { user: admin }));
    expect(first.status).toBe(200);
    expect(first.headers.get('X-Cache')).toBe('MISS');

    const second = await getBuses(authedRequest('http://localhost/api/buses', { user: admin }));
    expect(second.headers.get('X-Cache')).toBe('HIT');

    // The database must be hit once, not twice — that is the measurable win.
    expect(prisma.bus.findMany).toHaveBeenCalledTimes(1);
    expect((await second.json()).buses).toHaveLength(1);
  });

  it('treats different query strings as different cache entries', async () => {
    actingAs(admin);
    prisma.bus.findMany.mockResolvedValue([]);

    await getBuses(
      authedRequest('http://localhost/api/buses?status=ACTIVE', { user: admin }),
    );
    const other = await getBuses(
      authedRequest('http://localhost/api/buses?status=INACTIVE', { user: admin }),
    );

    expect(other.headers.get('X-Cache')).toBe('MISS');
    expect(prisma.bus.findMany).toHaveBeenCalledTimes(2);
  });

  it('invalidates the cache when a bus is created', async () => {
    actingAs(admin);
    prisma.bus.findMany.mockResolvedValue([]);
    prisma.bus.findFirst.mockResolvedValue(null);
    prisma.bus.create.mockResolvedValue({
      id: 'bus-2',
      busNumber: 'B2',
      plateNumber: 'P2',
    });

    await getBuses(authedRequest('http://localhost/api/buses', { user: admin }));
    expect(prisma.bus.findMany).toHaveBeenCalledTimes(1);

    // A mutation must flush the namespace so the list is not stale.
    const created = await createBus(
      authedRequest('http://localhost/api/buses', {
        method: 'POST',
        user: admin,
        body: { busNumber: 'B2', plateNumber: 'P2', capacity: 40 },
      }),
    );
    expect(created.status).toBe(201);

    const afterCreate = await getBuses(
      authedRequest('http://localhost/api/buses', { user: admin }),
    );
    expect(afterCreate.headers.get('X-Cache')).toBe('MISS');
    expect(prisma.bus.findMany).toHaveBeenCalledTimes(2);
  });

  it('rejects an unauthenticated request with 401 and caches nothing', async () => {
    const response = await getBuses(new Request('http://localhost/api/buses'));

    expect(response.status).toBe(401);
    expect(prisma.bus.findMany).not.toHaveBeenCalled();
  });

  it('rejects an invalid token with 401', async () => {
    const response = await getBuses(
      new Request('http://localhost/api/buses', {
        headers: { authorization: 'Bearer not-a-real-token' },
      }),
    );

    expect(response.status).toBe(401);
  });

  it('enforces role restrictions', async () => {
    actingAs(passenger);

    const response = await createBus(
      authedRequest('http://localhost/api/buses', {
        method: 'POST',
        user: passenger,
        body: { busNumber: 'B9', plateNumber: 'P9', capacity: 40 },
      }),
    );

    // Only admins may create buses.
    expect(response.status).toBe(403);
    expect(prisma.bus.create).not.toHaveBeenCalled();
  });
});

describe('GET /api/notifications — role-scoped cache isolation', () => {
  it('does not leak one role cached feed to another role', async () => {
    // This is the security-critical property: the cache key must include the
    // role, otherwise a passenger could be served an admin's notifications.
    prisma.notification.findMany.mockResolvedValue([
      { id: 'n-admin', userRole: 'ADMIN', title: 'Admin only' },
    ]);
    prisma.notification.count.mockResolvedValue(1);

    actingAs(admin);
    const adminResponse = await getNotifications(
      authedRequest('http://localhost/api/notifications', { user: admin }),
    );
    expect(adminResponse.headers.get('X-Cache')).toBe('MISS');

    // A passenger request must be a cache MISS (different key) and must query
    // with the passenger role filter.
    prisma.notification.findMany.mockResolvedValue([
      { id: 'n-pass', userRole: 'PASSENGER', title: 'Passenger only' },
    ]);

    actingAs(passenger);
    const passengerResponse = await getNotifications(
      authedRequest('http://localhost/api/notifications', { user: passenger }),
    );

    expect(passengerResponse.headers.get('X-Cache')).toBe('MISS');
    expect((await passengerResponse.json()).notifications[0].id).toBe('n-pass');

    // The passenger's query must have been filtered by role.
    const passengerWhere = prisma.notification.findMany.mock.calls.at(-1)[0].where;
    expect(passengerWhere).toEqual({ userRole: 'PASSENGER' });
  });

  it('lets an admin see notifications across all roles', async () => {
    actingAs(admin);
    prisma.notification.findMany.mockResolvedValue([]);
    prisma.notification.count.mockResolvedValue(0);

    await getNotifications(
      authedRequest('http://localhost/api/notifications', { user: admin }),
    );

    // An empty `where` is how the route expresses "admin sees all".
    expect(prisma.notification.findMany.mock.calls.at(-1)[0].where).toEqual({});
  });

  it('caches a repeated request for the same role', async () => {
    actingAs(passenger);
    prisma.notification.findMany.mockResolvedValue([]);
    prisma.notification.count.mockResolvedValue(0);

    await getNotifications(
      authedRequest('http://localhost/api/notifications', { user: passenger }),
    );
    const second = await getNotifications(
      authedRequest('http://localhost/api/notifications', { user: passenger }),
    );

    expect(second.headers.get('X-Cache')).toBe('HIT');
    expect(prisma.notification.findMany).toHaveBeenCalledTimes(1);
  });
});
