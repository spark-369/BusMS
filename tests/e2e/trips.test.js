import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  actAs,
  adminUser,
  apiRequest,
  busFixture,
  driverUser,
  passengerUser,
  primeSideEffects,
  routeFixture,
  scheduleFixture,
  tripFixture,
} from '../helpers/routeHarness';

vi.mock('@/lib/prisma', async () => {
  const { createPrismaMock } = await import('../helpers/prismaMock');
  return { default: createPrismaMock() };
});

delete process.env.REDIS_URL;

let prisma;
let getTrips;
let createTrip;

beforeAll(async () => {
  prisma = (await import('@/lib/prisma')).default;
  ({ GET: getTrips, POST: createTrip } = await import('@/app/api/trips/route'));
});

const admin = adminUser();
const driver = driverUser();
const passenger = passengerUser();

const get = (query = '', user = admin) =>
  getTrips(apiRequest(`/trips${query}`, { user }));
const post = (body, user = admin) =>
  createTrip(apiRequest('/trips', { method: 'POST', user, body }));

beforeEach(() => {
  vi.clearAllMocks();
  actAs(prisma, admin);
  primeSideEffects(prisma);
});

describe('GET /api/trips', () => {
  it('requires authentication', async () => {
    const response = await getTrips(apiRequest('/trips'));

    expect(response.status).toBe(401);
    expect(prisma.trip.findMany).not.toHaveBeenCalled();
  });

  it('returns trips ordered by start time with their relations', async () => {
    prisma.trip.findMany.mockResolvedValue([tripFixture()]);

    const response = await get();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.trips).toHaveLength(1);

    const args = prisma.trip.findMany.mock.calls.at(-1)[0];
    expect(args.orderBy).toEqual({ startTime: 'asc' });
    expect(Object.keys(args.include)).toEqual(
      expect.arrayContaining(['route', 'bus', 'driver']),
    );
  });

  it('filters by routeId and busId', async () => {
    prisma.trip.findMany.mockResolvedValue([]);

    await get('?routeId=route-1&busId=bus-1');

    expect(prisma.trip.findMany.mock.calls.at(-1)[0].where).toEqual({
      routeId: 'route-1',
      busId: 'bus-1',
    });
  });

  it('builds a single-day window when a date is supplied', async () => {
    prisma.trip.findMany.mockResolvedValue([]);

    await get('?date=2024-03-01');

    const { startTime } = prisma.trip.findMany.mock.calls.at(-1)[0].where;
    expect(startTime.gte).toBeInstanceOf(Date);
    expect(startTime.lt).toBeInstanceOf(Date);
    // Exclusive upper bound about one day later, so no trip is double-counted.
    // (A day either side of 24h keeps this robust across DST transitions.)
    const windowMs = startTime.lt.getTime() - startTime.gte.getTime();
    expect(windowMs).toBeGreaterThanOrEqual(23 * 60 * 60 * 1000);
    expect(windowMs).toBeLessThanOrEqual(25 * 60 * 60 * 1000);
  });

  it('caches repeated identical reads', async () => {
    prisma.trip.findMany.mockResolvedValue([]);

    await get('?routeId=route-1');
    const second = await get('?routeId=route-1');

    expect(second.headers.get('X-Cache')).toBe('HIT');
    expect(prisma.trip.findMany).toHaveBeenCalledTimes(1);
  });

  it('returns 500 when the database throws', async () => {
    prisma.trip.findMany.mockRejectedValue(new Error('connection lost'));

    expect((await get('?routeId=x')).status).toBe(500);
  });
});

describe('POST /api/trips', () => {
  it('restricts creation to admins and drivers', async () => {
    actAs(prisma, passenger);

    const response = await post({ scheduleId: 'schedule-1' }, passenger);

    expect(response.status).toBe(403);
    expect(prisma.trip.create).not.toHaveBeenCalled();
  });

  it('requires a schedule ID', async () => {
    const response = await post({});

    expect(response.status).toBe(400);
    expect((await response.json()).error).toMatch(/schedule id is required/i);
  });

  it('returns 404 when the schedule does not exist', async () => {
    prisma.schedule.findUnique.mockResolvedValue(null);

    const response = await post({ scheduleId: 'missing' });

    expect(response.status).toBe(404);
    expect((await response.json()).error).toMatch(/schedule not found/i);
    expect(prisma.trip.create).not.toHaveBeenCalled();
  });

  it('derives route, bus and driver from the schedule', async () => {
    prisma.schedule.findUnique.mockResolvedValue(
      scheduleFixture({ route: routeFixture(), bus: busFixture() }),
    );
    // The acting user is an admin, so no DRIVER row matches.
    prisma.user.findFirst.mockResolvedValue(null);
    prisma.trip.create.mockResolvedValue(tripFixture({ id: 'trip-9' }));

    const response = await post({ scheduleId: 'schedule-1' });
    const body = await response.json();

    expect(response.status).toBe(201);
    expect(body.message).toMatch(/created successfully/i);
    expect(body.trip.route.name).toBe('Campus Loop');
    expect(body.trip.bus.busNumber).toBe('B1');
    expect(body.trip.driver).toBeNull();

    const { data } = prisma.trip.create.mock.calls[0][0];
    expect(data.scheduleId).toBe('schedule-1');
    expect(data.routeId).toBe('route-1');
    expect(data.busId).toBe('bus-1');
    expect(data.driverId).toBeNull();
    expect(data.status).toBe('SCHEDULED');

    // The scheduled duration is preserved when shifting the window to "now".
    //
    // Asserted with a tolerance rather than exactly: the handler takes `now`
    // twice (once for `departureTime`, again for `arrivalTime`) and both go
    // through `toISOString()`, which truncates to millisecond precision. The
    // two calls are therefore free to land either side of a millisecond
    // boundary, so the derived span can legitimately come out 1ms long (or
    // short). Pinning it to exactly 3_600_000 made this test flaky.
    const SCHEDULED_MS = 60 * 60 * 1000; // 07:00 -> 08:00 in scheduleFixture
    const duration = data.endTime.getTime() - data.startTime.getTime();

    expect(duration).toBeGreaterThanOrEqual(SCHEDULED_MS);
    expect(duration).toBeLessThan(SCHEDULED_MS + 5_000);
  });

  it('records the driver when the caller is a driver', async () => {
    actAs(prisma, driver);
    prisma.schedule.findUnique.mockResolvedValue(
      scheduleFixture({ route: routeFixture(), bus: busFixture() }),
    );
    prisma.user.findFirst.mockResolvedValue({ id: driver.id, name: driver.name });
    prisma.trip.create.mockResolvedValue(tripFixture({ id: 'trip-9' }));

    const response = await post({ scheduleId: 'schedule-1' }, driver);
    const body = await response.json();

    expect(response.status).toBe(201);
    expect(body.trip.driver).toEqual({ id: driver.id, name: driver.name });
    expect(prisma.trip.create.mock.calls[0][0].data.driverId).toBe(driver.id);
  });

  it('notifies passengers and flushes the trips cache', async () => {
    prisma.trip.findMany.mockResolvedValue([]);
    prisma.schedule.findUnique.mockResolvedValue(
      scheduleFixture({ route: routeFixture(), bus: busFixture() }),
    );
    prisma.user.findFirst.mockResolvedValue(null);
    prisma.trip.create.mockResolvedValue(tripFixture({ id: 'trip-9' }));

    await get();
    await post({ scheduleId: 'schedule-1' });

    const notification = prisma.notification.create.mock.calls.at(-1)[0].data;
    expect(notification.userRole).toBe('PASSENGER');
    expect(notification.type).toBe('TRIP_SCHEDULED');

    const after = await get();
    expect(after.headers.get('X-Cache')).toBe('MISS');
  });

  it('returns 500 when the database throws', async () => {
    prisma.schedule.findUnique.mockRejectedValue(new Error('connection lost'));

    expect((await post({ scheduleId: 'schedule-1' })).status).toBe(500);
  });
});
