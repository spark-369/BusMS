import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  actAs,
  adminUser,
  apiRequest,
  busFixture,
  passengerUser,
  primeSideEffects,
  routeFixture,
  scheduleFixture,
} from '../helpers/routeHarness';

vi.mock('@/lib/prisma', async () => {
  const { createPrismaMock } = await import('../helpers/prismaMock');
  return { default: createPrismaMock() };
});

delete process.env.REDIS_URL;

let prisma;
let getSchedules;
let createSchedule;

beforeAll(async () => {
  prisma = (await import('@/lib/prisma')).default;
  ({ GET: getSchedules, POST: createSchedule } = await import(
    '@/app/api/schedules/route'
  ));
});

const admin = adminUser();
const passenger = passengerUser();

const get = (query = '') =>
  getSchedules(apiRequest(`/schedules${query}`, { user: admin }));
const post = (body, user = admin) =>
  createSchedule(apiRequest('/schedules', { method: 'POST', user, body }));

beforeEach(() => {
  vi.clearAllMocks();
  actAs(prisma, admin);
  primeSideEffects(prisma);
});

describe('GET /api/schedules', () => {
  it('requires authentication', async () => {
    const response = await getSchedules(apiRequest('/schedules'));

    expect(response.status).toBe(401);
    expect(prisma.schedule.findMany).not.toHaveBeenCalled();
  });

  it('returns schedules ordered by departure time with route and bus', async () => {
    prisma.schedule.findMany.mockResolvedValue([scheduleFixture()]);

    const response = await get();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.schedules).toHaveLength(1);

    const args = prisma.schedule.findMany.mock.calls.at(-1)[0];
    expect(args.orderBy).toEqual({ departureTime: 'asc' });
    expect(args.include.route.select).toEqual({ id: true, name: true });
    expect(args.include.bus.select).toEqual({
      id: true,
      busNumber: true,
      plateNumber: true,
    });
  });

  it('maps every supported query filter onto the where clause', async () => {
    prisma.schedule.findMany.mockResolvedValue([]);

    await get(
      '?routeId=route-1&busId=bus-1&scheduleType=MORNING&isActive=true&isSpecial=false',
    );

    expect(prisma.schedule.findMany.mock.calls.at(-1)[0].where).toEqual({
      routeId: 'route-1',
      busId: 'bus-1',
      scheduleType: 'MORNING',
      isActive: true,
      isSpecial: false,
    });
  });

  it('does not filter on flags that were not supplied', async () => {
    prisma.schedule.findMany.mockResolvedValue([]);

    await get();

    expect(prisma.schedule.findMany.mock.calls.at(-1)[0].where).toEqual({});
  });

  it('caches repeated identical reads', async () => {
    prisma.schedule.findMany.mockResolvedValue([]);

    await get('?routeId=route-1');
    const second = await get('?routeId=route-1');

    expect(second.headers.get('X-Cache')).toBe('HIT');
    expect(prisma.schedule.findMany).toHaveBeenCalledTimes(1);
  });

  it('returns 500 when the database throws', async () => {
    prisma.schedule.findMany.mockRejectedValue(new Error('connection lost'));

    expect((await get('?routeId=x')).status).toBe(500);
  });
});

describe('POST /api/schedules', () => {
  const validBody = {
    routeId: 'route-1',
    busId: 'bus-1',
    scheduleType: 'MORNING',
    departureTime: '07:00',
    arrivalTime: '08:00',
    daysOfWeek: ['MON'],
  };

  it('restricts creation to admins', async () => {
    actAs(prisma, passenger);

    const response = await post(validBody, passenger);

    expect(response.status).toBe(403);
    expect(prisma.schedule.create).not.toHaveBeenCalled();
  });

  it('requires the route, bus, type, times and days', async () => {
    const response = await post({ routeId: 'route-1' });

    expect(response.status).toBe(400);
    expect((await response.json()).error).toMatch(/required/i);
  });

  it('returns 404 when the route does not exist', async () => {
    prisma.route.findUnique.mockResolvedValue(null);
    prisma.bus.findUnique.mockResolvedValue(busFixture());

    const response = await post(validBody);

    expect(response.status).toBe(404);
    expect((await response.json()).error).toMatch(/route not found/i);
  });

  it('returns 404 when the bus does not exist', async () => {
    prisma.route.findUnique.mockResolvedValue(routeFixture());
    prisma.bus.findUnique.mockResolvedValue(null);

    const response = await post(validBody);

    expect(response.status).toBe(404);
    expect((await response.json()).error).toMatch(/bus not found/i);
    expect(prisma.schedule.create).not.toHaveBeenCalled();
  });

  it('combines a time-only departure with today to build a real Date', async () => {
    prisma.route.findUnique.mockResolvedValue(routeFixture());
    prisma.bus.findUnique.mockResolvedValue(busFixture());
    prisma.schedule.create.mockResolvedValue(scheduleFixture());

    const response = await post(validBody);
    const body = await response.json();

    expect(response.status).toBe(201);
    expect(body.message).toMatch(/created successfully/i);

    const { data } = prisma.schedule.create.mock.calls[0][0];
    expect(data.departureTime).toBeInstanceOf(Date);
    expect(data.arrivalTime).toBeInstanceOf(Date);
    expect(data.departureTime.getHours()).toBe(7);
    expect(data.arrivalTime.getHours()).toBe(8);
    expect(data.daysOfWeek).toEqual(['MON']);
  });

  it('defaults an unrecognised schedule type to MORNING', async () => {
    prisma.route.findUnique.mockResolvedValue(routeFixture());
    prisma.bus.findUnique.mockResolvedValue(busFixture());
    prisma.schedule.create.mockResolvedValue(scheduleFixture());

    // The UI once sent "REGULAR", which is not a Prisma enum value.
    await post({ ...validBody, scheduleType: 'REGULAR' });

    expect(prisma.schedule.create.mock.calls[0][0].data.scheduleType).toBe(
      'MORNING',
    );
  });

  it('notifies passengers, audits and flushes the schedules cache', async () => {
    prisma.schedule.findMany.mockResolvedValue([]);
    prisma.route.findUnique.mockResolvedValue(routeFixture());
    prisma.bus.findUnique.mockResolvedValue(busFixture());
    prisma.schedule.create.mockResolvedValue(scheduleFixture());

    await get();
    await post(validBody);

    const notification = prisma.notification.create.mock.calls.at(-1)[0].data;
    expect(notification.userRole).toBe('PASSENGER');
    expect(notification.type).toBe('SCHEDULE_CHANGE');

    const log = prisma.activityLog.create.mock.calls.at(-1)[0].data;
    expect(log.action).toBe('CREATE_SCHEDULE');

    const after = await get();
    expect(after.headers.get('X-Cache')).toBe('MISS');
  });

  it('returns 500 when the database throws', async () => {
    prisma.route.findUnique.mockRejectedValue(new Error('connection lost'));

    expect((await post(validBody)).status).toBe(500);
  });
});
