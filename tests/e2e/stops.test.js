import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  actAs,
  adminUser,
  apiRequest,
  passengerUser,
  primeSideEffects,
  routeFixture,
  stopFixture,
} from '../helpers/routeHarness';

vi.mock('@/lib/prisma', async () => {
  const { createPrismaMock } = await import('../helpers/prismaMock');
  return { default: createPrismaMock() };
});

delete process.env.REDIS_URL;

let prisma;
let getStops;
let createStop;

beforeAll(async () => {
  prisma = (await import('@/lib/prisma')).default;
  ({ GET: getStops, POST: createStop } = await import('@/app/api/stops/route'));
});

const admin = adminUser();
const passenger = passengerUser();

const get = (query = '') => getStops(apiRequest(`/stops${query}`, { user: admin }));
const post = (body, user = admin) =>
  createStop(apiRequest('/stops', { method: 'POST', user, body }));

beforeEach(() => {
  vi.clearAllMocks();
  actAs(prisma, admin);
  primeSideEffects(prisma);
});

describe('GET /api/stops', () => {
  it('requires authentication', async () => {
    const response = await getStops(apiRequest('/stops'));

    expect(response.status).toBe(401);
    expect(prisma.stop.findMany).not.toHaveBeenCalled();
  });

  it('returns stops ordered by route then position', async () => {
    prisma.stop.findMany.mockResolvedValue([stopFixture()]);

    const response = await get();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.stops).toHaveLength(1);

    const args = prisma.stop.findMany.mock.calls.at(-1)[0];
    expect(args.orderBy).toEqual([{ routeId: 'asc' }, { order: 'asc' }]);
    expect(args.include.route.select).toEqual({ id: true, name: true });
  });

  it('filters by routeId when provided', async () => {
    prisma.stop.findMany.mockResolvedValue([]);

    await get('?routeId=route-1');

    expect(prisma.stop.findMany.mock.calls.at(-1)[0].where).toEqual({
      routeId: 'route-1',
    });
  });

  it('caches repeated identical reads', async () => {
    prisma.stop.findMany.mockResolvedValue([]);

    await get('?routeId=route-1');
    const second = await get('?routeId=route-1');

    expect(second.headers.get('X-Cache')).toBe('HIT');
    expect(prisma.stop.findMany).toHaveBeenCalledTimes(1);
  });

  it('returns 500 when the database throws', async () => {
    prisma.stop.findMany.mockRejectedValue(new Error('connection lost'));

    expect((await get('?routeId=x')).status).toBe(500);
  });
});

describe('POST /api/stops', () => {
  const validBody = {
    name: 'Library Gate',
    latitude: 23.81,
    longitude: 90.41,
    routeId: 'route-1',
  };

  it('restricts creation to admins', async () => {
    actAs(prisma, passenger);

    const response = await post(validBody, passenger);

    expect(response.status).toBe(403);
    expect(prisma.stop.create).not.toHaveBeenCalled();
  });

  it('requires name, coordinates and a route', async () => {
    const response = await post({ name: 'Library Gate' });

    expect(response.status).toBe(400);
    expect((await response.json()).error).toMatch(/required/i);
  });

  it('rejects non-numeric coordinates', async () => {
    const response = await post({ ...validBody, latitude: 'north' });

    expect(response.status).toBe(400);
    expect((await response.json()).error).toMatch(/valid numbers/i);
  });

  it('rejects coordinates outside their valid ranges', async () => {
    const response = await post({ ...validBody, latitude: 91, longitude: 181 });

    expect(response.status).toBe(400);
    expect((await response.json()).error).toMatch(/between -90 and 90/i);
  });

  it('returns 404 when the target route does not exist', async () => {
    prisma.route.findUnique.mockResolvedValue(null);

    const response = await post(validBody);

    expect(response.status).toBe(404);
    expect((await response.json()).error).toMatch(/route not found/i);
    expect(prisma.stop.create).not.toHaveBeenCalled();
  });

  it('appends after the current highest order when none is supplied', async () => {
    prisma.route.findUnique.mockResolvedValue(routeFixture());
    prisma.stop.findFirst.mockResolvedValue(stopFixture({ order: 4 }));
    prisma.stop.create.mockResolvedValue(stopFixture({ id: 'stop-9', order: 5 }));

    const response = await post(validBody);
    const body = await response.json();

    expect(response.status).toBe(201);
    expect(body.message).toMatch(/created successfully/i);

    const { data } = prisma.stop.create.mock.calls[0][0];
    expect(data.order).toBe(5);
    expect(data.latitude).toBe(23.81);
    expect(data.routeId).toBe('route-1');
  });

  it('starts at order 1 when the route has no stops yet', async () => {
    prisma.route.findUnique.mockResolvedValue(routeFixture());
    prisma.stop.findFirst.mockResolvedValue(null);
    prisma.stop.create.mockResolvedValue(stopFixture({ id: 'stop-9', order: 1 }));

    await post(validBody);

    expect(prisma.stop.create.mock.calls[0][0].data.order).toBe(1);
  });

  it('honours an explicit order and notifies passengers', async () => {
    prisma.route.findUnique.mockResolvedValue(routeFixture());
    prisma.stop.findFirst.mockResolvedValue(null);
    prisma.stop.create.mockResolvedValue(stopFixture({ id: 'stop-9', order: 7 }));

    await post({ ...validBody, order: '7' });

    expect(prisma.stop.create.mock.calls[0][0].data.order).toBe(7);

    const notification = prisma.notification.create.mock.calls.at(-1)[0].data;
    expect(notification.userRole).toBe('PASSENGER');
    expect(notification.type).toBe('SCHEDULE_CHANGE');
    expect(notification.message).toContain('Campus Loop');
  });

  it('invalidates the stops cache on create', async () => {
    prisma.stop.findMany.mockResolvedValue([]);
    prisma.route.findUnique.mockResolvedValue(routeFixture());
    prisma.stop.findFirst.mockResolvedValue(null);
    prisma.stop.create.mockResolvedValue(stopFixture({ id: 'stop-9' }));

    await get();
    await post(validBody);

    const after = await get();
    expect(after.headers.get('X-Cache')).toBe('MISS');
  });

  it('returns 500 when the database throws', async () => {
    prisma.route.findUnique.mockRejectedValue(new Error('connection lost'));

    expect((await post(validBody)).status).toBe(500);
  });
});
