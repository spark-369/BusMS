import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  actAs,
  adminUser,
  apiRequest,
  busFixture,
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
let getRoutes;
let createRoute;

beforeAll(async () => {
  prisma = (await import('@/lib/prisma')).default;
  ({ GET: getRoutes, POST: createRoute } = await import(
    '@/app/api/routes/route'
  ));
});

const admin = adminUser();
const passenger = passengerUser();

const get = (query = '') =>
  getRoutes(apiRequest(`/routes${query}`, { user: admin }));
const post = (body, user = admin) =>
  createRoute(apiRequest('/routes', { method: 'POST', user, body }));

beforeEach(() => {
  vi.clearAllMocks();
  actAs(prisma, admin);
  primeSideEffects(prisma);
});

describe('GET /api/routes', () => {
  it('requires authentication', async () => {
    const response = await getRoutes(apiRequest('/routes'));

    expect(response.status).toBe(401);
    expect(prisma.route.findMany).not.toHaveBeenCalled();
  });

  it('returns the route list with stop and count relations', async () => {
    prisma.route.findMany.mockResolvedValue([routeFixture()]);

    const response = await get();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.routes).toHaveLength(1);

    const args = prisma.route.findMany.mock.calls.at(-1)[0];
    expect(args.include.stops).toBeDefined();
    expect(args.include._count.select).toEqual({ schedules: true, trips: true });
    expect(args.orderBy).toEqual({ name: 'asc' });
  });

  it('translates the isActive query flag into a boolean filter', async () => {
    prisma.route.findMany.mockResolvedValue([]);

    await get('?isActive=false');
    expect(prisma.route.findMany.mock.calls.at(-1)[0].where).toEqual({
      isActive: false,
    });
  });

  it('does not filter by isActive when the flag is absent', async () => {
    prisma.route.findMany.mockResolvedValue([]);

    await get();

    // An empty `where` is how the route expresses "no filter".
    expect(prisma.route.findMany.mock.calls.at(-1)[0].where).toEqual({});
  });

  it('caches repeated identical reads', async () => {
    prisma.route.findMany.mockResolvedValue([]);

    await get('?isActive=true');
    const second = await get('?isActive=true');

    expect(second.headers.get('X-Cache')).toBe('HIT');
    expect(prisma.route.findMany).toHaveBeenCalledTimes(1);
  });

  it('returns 500 when the database throws', async () => {
    prisma.route.findMany.mockRejectedValue(new Error('connection lost'));

    expect((await get('?isActive=maybe')).status).toBe(500);
  });
});

describe('POST /api/routes', () => {
  const validBody = {
    name: 'North Route',
    estimatedDuration: 25,
    distance: 8.4,
  };

  it('restricts creation to admins', async () => {
    actAs(prisma, passenger);

    const response = await post(validBody, passenger);

    expect(response.status).toBe(403);
    expect(prisma.route.create).not.toHaveBeenCalled();
  });

  it('requires name, estimated duration and distance', async () => {
    const response = await post({ name: 'North Route' });

    expect(response.status).toBe(400);
    expect((await response.json()).error).toMatch(/required/i);
  });

  it('rejects non-numeric duration or distance', async () => {
    const response = await post({
      name: 'North Route',
      estimatedDuration: 'soon',
      distance: 'far',
    });

    expect(response.status).toBe(400);
    expect((await response.json()).error).toMatch(/valid numbers/i);
  });

  it('creates the route, nesting its stops and notifying passengers', async () => {
    prisma.route.create.mockResolvedValue(
      routeFixture({ id: 'route-9', name: 'North Route' }),
    );

    const response = await post({
      ...validBody,
      stops: [
        { name: 'Gate 1', latitude: '23.81', longitude: '90.41' },
        { name: 'Gate 2', latitude: '23.82', longitude: '90.42', order: 5 },
      ],
    });
    const body = await response.json();

    expect(response.status).toBe(201);
    expect(body.message).toMatch(/created successfully/i);

    const { data } = prisma.route.create.mock.calls[0][0];
    expect(data.estimatedDuration).toBe(25);
    expect(data.distance).toBe(8.4);
    expect(data.stops.create).toHaveLength(2);
    // An explicit order is preserved; otherwise the index (1-based) is used.
    expect(data.stops.create[0].order).toBe(1);
    expect(data.stops.create[1].order).toBe(5);
    expect(data.stops.create[0].latitude).toBe(23.81);

    // Inline notification fan-out to passengers.
    const notification = prisma.notification.create.mock.calls.at(-1)[0].data;
    expect(notification.userRole).toBe('PASSENGER');
    expect(notification.type).toBe('ROUTE_CREATED');
  });

  it('omits the nested stops write when no stops are supplied', async () => {
    prisma.route.create.mockResolvedValue(routeFixture());

    await post(validBody);

    const { data } = prisma.route.create.mock.calls[0][0];
    expect(data.stops).toBeUndefined();
  });

  it('audits the creation and invalidates the routes cache', async () => {
    prisma.route.findMany.mockResolvedValue([]);
    prisma.route.create.mockResolvedValue(routeFixture());

    // Prime the routes cache, then confirm the write flushes it.
    await get();
    await post(validBody);

    const log = prisma.activityLog.create.mock.calls.at(-1)[0].data;
    expect(log.action).toBe('CREATE_ROUTE');
    expect(log.userId).toBe(admin.id);

    const after = await get();
    expect(after.headers.get('X-Cache')).toBe('MISS');
  });

  it('returns 500 when the database throws', async () => {
    prisma.route.create.mockRejectedValue(new Error('connection lost'));

    expect((await post(validBody)).status).toBe(500);
  });
});

describe('shared fixtures', () => {
  it('exposes bus and stop shapes used when a route embeds related rows', () => {
    // Guards the shared harness: these are what the sibling e2e suites rely on.
    expect(busFixture().id).toBe('bus-1');
    expect(stopFixture().routeId).toBe('route-1');
  });
});