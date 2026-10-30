import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  actAs,
  adminUser,
  apiRequest,
  passengerUser,
  params,
  primeSideEffects,
  routeFixture,
} from '../helpers/routeHarness';

vi.mock('@/lib/prisma', async () => {
  const { createPrismaMock } = await import('../helpers/prismaMock');
  return { default: createPrismaMock() };
});

delete process.env.REDIS_URL;

let prisma;
let getRoute;
let updateRoute;
let deleteRoute;

beforeAll(async () => {
  prisma = (await import('@/lib/prisma')).default;
  ({ GET: getRoute, PUT: updateRoute, DELETE: deleteRoute } = await import(
    '@/app/api/routes/[id]/route'
  ));
});

const admin = adminUser();
const passenger = passengerUser();

const get = (id = 'route-1') =>
  getRoute(apiRequest(`/routes/${id}`, { user: admin }), params(id));
const put = (body, id = 'route-1') =>
  updateRoute(
    apiRequest(`/routes/${id}`, { method: 'PUT', user: admin, body }),
    params(id),
  );
const del = (id = 'route-1') =>
  deleteRoute(
    apiRequest(`/routes/${id}`, { method: 'DELETE', user: admin }),
    params(id),
  );

beforeEach(() => {
  vi.clearAllMocks();
  actAs(prisma, admin);
  primeSideEffects(prisma);
  // The interactive transaction runs against the same double.
  prisma.$transaction.mockImplementation(async (arg) =>
    typeof arg === 'function' ? arg(prisma) : Promise.all(arg),
  );
});

describe('GET /api/routes/[id]', () => {
  it('requires authentication', async () => {
    const response = await getRoute(
      apiRequest('/routes/route-1'),
      params('route-1'),
    );

    expect(response.status).toBe(401);
  });

  it('returns the route with stops, schedules and trips', async () => {
    prisma.route.findUnique.mockResolvedValue(routeFixture());

    const response = await get();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.route.id).toBe('route-1');

    const args = prisma.route.findUnique.mock.calls.at(-1)[0];
    expect(Object.keys(args.include)).toEqual(
      expect.arrayContaining(['stops', 'schedules', 'trips']),
    );
  });

  it('returns 404 for an unknown route', async () => {
    prisma.route.findUnique.mockResolvedValue(null);

    expect((await get('missing')).status).toBe(404);
  });

  it('caches a repeated read of the same id', async () => {
    prisma.route.findUnique.mockResolvedValue(routeFixture());

    await get();
    const second = await get();

    expect(second.headers.get('X-Cache')).toBe('HIT');
    expect(prisma.route.findUnique).toHaveBeenCalledTimes(1);
  });
});

describe('PUT /api/routes/[id]', () => {
  it('restricts updates to admins', async () => {
    actAs(prisma, passenger);

    const response = await updateRoute(
      apiRequest('/routes/route-1', { method: 'PUT', user: passenger, body: {} }),
      params('route-1'),
    );

    expect(response.status).toBe(403);
  });

  it('returns 404 for an unknown route', async () => {
    prisma.route.findUnique.mockResolvedValue(null);

    expect((await put({ name: 'X' }, 'missing')).status).toBe(404);
  });

  it('updates scalar fields without touching stops when none are supplied', async () => {
    prisma.route.update.mockResolvedValue(routeFixture({ name: 'Renamed' }));
    prisma.route.findUnique
      .mockResolvedValueOnce(routeFixture())
      .mockResolvedValueOnce(routeFixture({ name: 'Renamed' }));

    const response = await put({ name: 'Renamed', distance: '20.5' });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.message).toMatch(/updated successfully/i);

    const { data } = prisma.route.update.mock.calls[0][0];
    expect(data.name).toBe('Renamed');
    expect(data.distance).toBe(20.5);
    // No stop replacement happened, so the destructive path was skipped.
    expect(prisma.stop.deleteMany).not.toHaveBeenCalled();
  });

  it('replaces stops inside a transaction when none are in use', async () => {
    prisma.route.update.mockResolvedValue(routeFixture());
    prisma.route.findUnique
      .mockResolvedValueOnce(routeFixture())
      .mockResolvedValueOnce(routeFixture({ stops: [{ id: 'stop-9' }] }));
    prisma.stop.findMany.mockResolvedValue([{ id: 'stop-1' }]);
    prisma.booking.count.mockResolvedValue(0);
    prisma.stop.deleteMany.mockResolvedValue({ count: 1 });
    prisma.stop.createMany.mockResolvedValue({ count: 2 });

    const response = await put({
      stops: [
        { name: 'A', latitude: '1', longitude: '2' },
        { name: 'B', latitude: '3', longitude: '4' },
      ],
    });

    expect(response.status).toBe(200);
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(prisma.stop.deleteMany).toHaveBeenCalledWith({
      where: { routeId: 'route-1' },
    });
    expect(prisma.stop.createMany.mock.calls[0][0].data).toHaveLength(2);
  });

  it('refuses to replace stops that existing bookings reference', async () => {
    prisma.route.findUnique.mockResolvedValue(routeFixture());
    prisma.route.update.mockResolvedValue(routeFixture());
    prisma.stop.findMany.mockResolvedValue([{ id: 'stop-1' }]);
    prisma.booking.count.mockResolvedValue(3);

    const response = await put({
      stops: [{ name: 'A', latitude: '1', longitude: '2' }],
    });

    expect(response.status).toBe(409);
    expect((await response.json()).error).toMatch(/existing bookings/i);
    expect(prisma.stop.deleteMany).not.toHaveBeenCalled();
  });

  it('audits the update and flushes the cache', async () => {
    prisma.route.findUnique.mockResolvedValue(routeFixture());
    prisma.route.update.mockResolvedValue(routeFixture());

    await get();
    await put({ description: 'Updated' });

    const log = prisma.activityLog.create.mock.calls.at(-1)[0].data;
    expect(log.action).toBe('UPDATE_ROUTE');

    const after = await get();
    expect(after.headers.get('X-Cache')).toBe('MISS');
  });
});

describe('DELETE /api/routes/[id]', () => {
  it('restricts deletion to admins', async () => {
    actAs(prisma, passenger);

    const response = await deleteRoute(
      apiRequest('/routes/route-1', { method: 'DELETE', user: passenger }),
      params('route-1'),
    );

    expect(response.status).toBe(403);
  });

  it('soft-deletes by deactivating the route', async () => {
    prisma.route.findUnique.mockResolvedValue(routeFixture());
    prisma.route.update.mockResolvedValue(routeFixture({ isActive: false }));

    const response = await del();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.message).toMatch(/deactivated successfully/i);

    // A soft delete: the row is updated, never removed.
    expect(prisma.route.update).toHaveBeenCalledWith({
      where: { id: 'route-1' },
      data: { isActive: false },
    });
    expect(prisma.route.delete).not.toHaveBeenCalled();

    const log = prisma.activityLog.create.mock.calls.at(-1)[0].data;
    expect(log.action).toBe('DEACTIVATE_ROUTE');
  });

  it('returns 404 for an unknown route', async () => {
    prisma.route.findUnique.mockResolvedValue(null);

    expect((await del('missing')).status).toBe(404);
  });
});
