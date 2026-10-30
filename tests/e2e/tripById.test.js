import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  actAs,
  adminUser,
  apiRequest,
  driverUser,
  params,
  passengerUser,
  primeSideEffects,
  tripFixture,
} from '../helpers/routeHarness';

vi.mock('@/lib/prisma', async () => {
  const { createPrismaMock } = await import('../helpers/prismaMock');
  return { default: createPrismaMock() };
});

delete process.env.REDIS_URL;

let prisma;
let getTrip;
let updateTrip;
let deleteTrip;

beforeAll(async () => {
  prisma = (await import('@/lib/prisma')).default;
  ({ GET: getTrip, PUT: updateTrip, DELETE: deleteTrip } = await import(
    '@/app/api/trips/[id]/route'
  ));
});

const admin = adminUser();
const driver = driverUser();
const passenger = passengerUser();

const get = (id = 'trip-1') =>
  getTrip(apiRequest(`/trips/${id}`, { user: admin }), params(id));
const put = (body, { id = 'trip-1', user = admin } = {}) =>
  updateTrip(
    apiRequest(`/trips/${id}`, { method: 'PUT', user, body }),
    params(id),
  );
const del = (id = 'trip-1') =>
  deleteTrip(apiRequest(`/trips/${id}`, { method: 'DELETE', user: admin }), params(id));

beforeEach(() => {
  vi.clearAllMocks();
  actAs(prisma, admin);
  primeSideEffects(prisma);
});

describe('GET /api/trips/[id]', () => {
  it('requires authentication', async () => {
    const response = await getTrip(apiRequest('/trips/trip-1'), params('trip-1'));

    expect(response.status).toBe(401);
  });

  it('returns the trip with its schedule, route, bus and driver', async () => {
    prisma.trip.findUnique.mockResolvedValue(tripFixture());

    const response = await get();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.trip.id).toBe('trip-1');

    const args = prisma.trip.findUnique.mock.calls.at(-1)[0];
    expect(Object.keys(args.include)).toEqual(
      expect.arrayContaining(['route', 'bus', 'driver', 'schedule']),
    );
  });

  it('returns 404 for an unknown trip', async () => {
    prisma.trip.findUnique.mockResolvedValue(null);

    expect((await get('missing')).status).toBe(404);
  });

  it('caches a repeated read of the same id', async () => {
    prisma.trip.findUnique.mockResolvedValue(tripFixture());

    await get();
    const second = await get();

    expect(second.headers.get('X-Cache')).toBe('HIT');
    expect(prisma.trip.findUnique).toHaveBeenCalledTimes(1);
  });
});

describe('PUT /api/trips/[id]', () => {
  it('restricts updates to admins and drivers', async () => {
    actAs(prisma, passenger);

    const response = await put(
      { status: 'IN_PROGRESS' },
      { user: passenger },
    );

    expect(response.status).toBe(403);
    expect(prisma.trip.update).not.toHaveBeenCalled();
  });

  it('returns 404 for an unknown trip', async () => {
    prisma.trip.findUnique.mockResolvedValue(null);

    expect((await put({ status: 'COMPLETED' }, { id: 'missing' })).status).toBe(
      404,
    );
  });

  it('stops a driver from touching a trip they are not assigned to', async () => {
    actAs(prisma, driver);
    prisma.trip.findUnique.mockResolvedValue(tripFixture({ driverId: 'other-driver' }));

    const response = await put({ status: 'IN_PROGRESS' }, { user: driver });

    expect(response.status).toBe(403);
    expect((await response.json()).error).toMatch(/not assigned/i);
    expect(prisma.trip.update).not.toHaveBeenCalled();
  });

  it('lets the assigned driver update their own trip', async () => {
    actAs(prisma, driver);
    prisma.trip.findUnique.mockResolvedValue(tripFixture({ driverId: driver.id }));
    prisma.trip.update.mockResolvedValue(tripFixture({ status: 'IN_PROGRESS' }));

    const response = await put({ status: 'IN_PROGRESS' }, { user: driver });

    expect(response.status).toBe(200);
    // The actual start is stamped the first time a trip goes in progress.
    expect(prisma.trip.update.mock.calls[0][0].data.actualStartTime).toBeInstanceOf(
      Date,
    );
  });

  it('rejects an unknown status value', async () => {
    prisma.trip.findUnique.mockResolvedValue(tripFixture());

    const response = await put({ status: 'FLYING' });

    expect(response.status).toBe(400);
    expect((await response.json()).error).toMatch(/invalid trip status/i);
  });

  it('treats completed and cancelled trips as terminal', async () => {
    prisma.trip.findUnique.mockResolvedValue(tripFixture({ status: 'COMPLETED' }));

    const response = await put({ status: 'IN_PROGRESS' });

    expect(response.status).toBe(400);
    expect((await response.json()).error).toMatch(/already completed/i);
    expect(prisma.trip.update).not.toHaveBeenCalled();
  });

  it('stamps the end time when a trip is completed', async () => {
    prisma.trip.findUnique.mockResolvedValue(tripFixture({ status: 'IN_PROGRESS' }));
    prisma.trip.update.mockResolvedValue(tripFixture({ status: 'COMPLETED' }));

    const response = await put({ status: 'COMPLETED' });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.message).toMatch(/completed successfully/i);

    const { data } = prisma.trip.update.mock.calls[0][0];
    expect(data.endTime).toBeInstanceOf(Date);
    expect(data.actualEndTime).toBeInstanceOf(Date);

    const log = prisma.activityLog.create.mock.calls.at(-1)[0].data;
    expect(log.action).toBe('UPDATE_TRIP');
  });

  it('flushes the trips cache after a status change', async () => {
    prisma.trip.findUnique.mockResolvedValue(tripFixture());
    prisma.trip.update.mockResolvedValue(tripFixture({ status: 'IN_PROGRESS' }));

    await get();
    await put({ status: 'IN_PROGRESS' });

    const after = await get();
    expect(after.headers.get('X-Cache')).toBe('MISS');
  });
});

describe('DELETE /api/trips/[id]', () => {
  it('restricts deletion to admins', async () => {
    actAs(prisma, driver);

    const response = await deleteTrip(
      apiRequest('/trips/trip-1', { method: 'DELETE', user: driver }),
      params('trip-1'),
    );

    expect(response.status).toBe(403);
  });

  it('returns 404 for an unknown trip', async () => {
    prisma.trip.findUnique.mockResolvedValue(null);

    expect((await del('missing')).status).toBe(404);
  });

  it('refuses to delete a trip that is in progress', async () => {
    prisma.trip.findUnique.mockResolvedValue(tripFixture({ status: 'IN_PROGRESS' }));

    const response = await del();

    expect(response.status).toBe(400);
    expect((await response.json()).error).toMatch(/in-progress/i);
    expect(prisma.trip.delete).not.toHaveBeenCalled();
  });

  it('deletes the trip and audits it', async () => {
    prisma.trip.findUnique.mockResolvedValue(tripFixture());
    prisma.trip.delete.mockResolvedValue(tripFixture());

    const response = await del();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.message).toMatch(/deleted successfully/i);
    expect(prisma.trip.delete).toHaveBeenCalledWith({ where: { id: 'trip-1' } });

    const log = prisma.activityLog.create.mock.calls.at(-1)[0].data;
    expect(log.action).toBe('DELETE_TRIP');
  });
});
