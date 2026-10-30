import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  actAs,
  adminUser,
  apiRequest,
  busFixture,
  driverUser,
  passengerUser,
  primeSideEffects,
} from '../helpers/routeHarness';

vi.mock('@/lib/prisma', async () => {
  const { createPrismaMock } = await import('../helpers/prismaMock');
  return { default: createPrismaMock() };
});

// No Redis -> in-memory cache/limiter and inline job execution, so cache hits
// and side effects are observable inside a single process.
delete process.env.REDIS_URL;

let prisma;
let getBuses;
let createBus;

beforeAll(async () => {
  prisma = (await import('@/lib/prisma')).default;
  ({ GET: getBuses, POST: createBus } = await import('@/app/api/buses/route'));
});

const admin = adminUser();
const driver = driverUser();
const passenger = passengerUser();

const get = (query = '', user = admin) =>
  getBuses(apiRequest(`/buses${query}`, { user }));

const post = (body, user = admin) =>
  createBus(apiRequest('/buses', { method: 'POST', user, body }));

beforeEach(() => {
  vi.clearAllMocks();
  actAs(prisma, admin);
  primeSideEffects(prisma);
});

describe('GET /api/buses', () => {
  it('requires a bearer token', async () => {
    const response = await getBuses(apiRequest('/buses'));

    expect(response.status).toBe(401);
    expect(prisma.bus.findMany).not.toHaveBeenCalled();
  });

  it('rejects an invalid token with 401', async () => {
    const response = await getBuses(
      apiRequest('/buses', { headers: { authorization: 'Bearer nope' } }),
    );

    expect(response.status).toBe(401);
  });

  it('returns the bus list to every role', async () => {
    actAs(prisma, passenger);
    prisma.bus.findMany.mockResolvedValue([busFixture()]);

    const response = await get('', passenger);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.buses).toHaveLength(1);
    expect(body.buses[0].busNumber).toBe('B1');
  });

  it('serves the second identical request from cache', async () => {
    prisma.bus.findMany.mockResolvedValue([busFixture()]);

    const first = await get();
    expect(first.headers.get('X-Cache')).toBe('MISS');

    const second = await get();
    expect(second.headers.get('X-Cache')).toBe('HIT');

    // The measurable win: one database round trip for two requests.
    expect(prisma.bus.findMany).toHaveBeenCalledTimes(1);
  });

  it('filters by status and keys the cache by query string', async () => {
    prisma.bus.findMany.mockResolvedValue([]);

    await get('?status=ACTIVE');
    expect(prisma.bus.findMany.mock.calls.at(-1)[0].where).toEqual({
      status: 'ACTIVE',
    });

    // A different query string must be a different cache entry.
    const other = await get('?status=INACTIVE');
    expect(other.headers.get('X-Cache')).toBe('MISS');
    expect(prisma.bus.findMany).toHaveBeenCalledTimes(2);
  });

  it('orders the list by bus number', async () => {
    prisma.bus.findMany.mockResolvedValue([]);

    await get();

    expect(prisma.bus.findMany.mock.calls.at(-1)[0].orderBy).toEqual({
      busNumber: 'asc',
    });
  });

  it('returns 500 when the database throws', async () => {
    prisma.bus.findMany.mockRejectedValue(new Error('connection lost'));

    expect((await get('?status=BROKEN')).status).toBe(500);
  });
});

describe('POST /api/buses', () => {
  const validBody = {
    busNumber: 'B9',
    plateNumber: 'PL-9',
    capacity: 45,
  };

  it('restricts creation to admins', async () => {
    actAs(prisma, passenger);

    const response = await post(validBody, passenger);

    expect(response.status).toBe(403);
    expect(prisma.bus.create).not.toHaveBeenCalled();
  });

  it('also rejects a driver', async () => {
    actAs(prisma, driver);

    const response = await post(validBody, driver);

    expect(response.status).toBe(403);
  });

  it('requires bus number, plate number and capacity', async () => {
    const response = await post({ busNumber: 'B9' });

    expect(response.status).toBe(400);
    expect((await response.json()).error).toMatch(/required/i);
  });

  it('rejects a non-positive capacity', async () => {
    // NOTE: a literal `0` would trip the "required" guard first, because the
    // route checks `!capacity` before parsing. A negative *string* is truthy, so
    // it reaches the numeric validation this test is actually pinning.
    const response = await post({ ...validBody, capacity: '-5' });

    expect(response.status).toBe(400);
    expect((await response.json()).error).toMatch(/positive number/i);
  });

  it('rejects a duplicate bus number or plate number', async () => {
    prisma.bus.findFirst.mockResolvedValue(busFixture());

    const response = await post(validBody);

    expect(response.status).toBe(400);
    expect((await response.json()).error).toMatch(/already exists/i);
    expect(prisma.bus.create).not.toHaveBeenCalled();
  });

  it('creates the bus, coerces types, audits and flushes the cache', async () => {
    prisma.bus.findFirst.mockResolvedValue(null);
    prisma.bus.create.mockResolvedValue(
      busFixture({ id: 'bus-9', busNumber: 'B9' }),
    );

    const response = await post({
      ...validBody,
      capacity: '45',
      year: '2022',
      mileage: '150',
    });
    const body = await response.json();

    expect(response.status).toBe(201);
    expect(body.message).toMatch(/created successfully/i);
    expect(body.bus.busNumber).toBe('B9');

    const { data } = prisma.bus.create.mock.calls[0][0];
    // Values arrive as strings from an HTML form and must be numbers in the DB.
    expect(data.capacity).toBe(45);
    expect(data.year).toBe(2022);
    expect(data.mileage).toBe(150);
    expect(data.fuelType).toBe('DIESEL');

    // Audit trail goes through the queue facade and runs inline without Redis.
    const log = prisma.activityLog.create.mock.calls.at(-1)[0].data;
    expect(log.action).toBe('CREATE_BUS');
    expect(log.userId).toBe(admin.id);
  });

  it('invalidates the bus list cache on create', async () => {
    prisma.bus.findMany.mockResolvedValue([]);
    prisma.bus.findFirst.mockResolvedValue(null);
    prisma.bus.create.mockResolvedValue(busFixture({ id: 'bus-9' }));

    await get();
    expect(prisma.bus.findMany).toHaveBeenCalledTimes(1);

    await post(validBody);

    // A fresh read after the write must not be served the stale entry.
    const after = await get();
    expect(after.headers.get('X-Cache')).toBe('MISS');
    expect(prisma.bus.findMany).toHaveBeenCalledTimes(2);
  });

  it('returns 500 when the database throws', async () => {
    prisma.bus.findFirst.mockRejectedValue(new Error('connection lost'));

    const response = await post(validBody);

    expect(response.status).toBe(500);
  });
});
