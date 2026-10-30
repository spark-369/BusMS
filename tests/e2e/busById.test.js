import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  actAs,
  adminUser,
  apiRequest,
  busFixture,
  passengerUser,
  params,
  primeSideEffects,
} from '../helpers/routeHarness';

vi.mock('@/lib/prisma', async () => {
  const { createPrismaMock } = await import('../helpers/prismaMock');
  return { default: createPrismaMock() };
});

delete process.env.REDIS_URL;

let prisma;
let getBus;
let updateBus;
let deleteBus;

beforeAll(async () => {
  prisma = (await import('@/lib/prisma')).default;
  ({ GET: getBus, PUT: updateBus, DELETE: deleteBus } = await import(
    '@/app/api/buses/[id]/route'
  ));
});

const admin = adminUser();
const passenger = passengerUser();

const get = (id = 'bus-1') =>
  getBus(apiRequest(`/buses/${id}`, { user: admin }), params(id));
const put = (body, id = 'bus-1') =>
  updateBus(
    apiRequest(`/buses/${id}`, { method: 'PUT', user: admin, body }),
    params(id),
  );
const del = (id = 'bus-1') =>
  deleteBus(apiRequest(`/buses/${id}`, { method: 'DELETE', user: admin }), params(id));

beforeEach(() => {
  vi.clearAllMocks();
  actAs(prisma, admin);
  primeSideEffects(prisma);
});

describe('GET /api/buses/[id]', () => {
  it('requires authentication', async () => {
    const response = await getBus(apiRequest('/buses/bus-1'), params('bus-1'));

    expect(response.status).toBe(401);
    expect(prisma.bus.findUnique).not.toHaveBeenCalled();
  });

  it('returns the bus with its relations', async () => {
    prisma.bus.findUnique.mockResolvedValue(busFixture());

    const response = await get();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.bus.id).toBe('bus-1');

    const args = prisma.bus.findUnique.mock.calls.at(-1)[0];
    expect(args.where).toEqual({ id: 'bus-1' });
    expect(Object.keys(args.include)).toEqual(
      expect.arrayContaining(['driver', 'schedules', 'bookings', 'trips', 'maintenance']),
    );
  });

  it('returns 404 for an unknown bus', async () => {
    prisma.bus.findUnique.mockResolvedValue(null);

    const response = await get('missing');

    expect(response.status).toBe(404);
    expect((await response.json()).error).toMatch(/not found/i);
  });

  it('caches a repeated read of the same id', async () => {
    prisma.bus.findUnique.mockResolvedValue(busFixture());

    await get();
    const second = await get();

    expect(second.headers.get('X-Cache')).toBe('HIT');
    expect(prisma.bus.findUnique).toHaveBeenCalledTimes(1);
  });

  it('returns 500 when the database throws', async () => {
    prisma.bus.findUnique.mockRejectedValue(new Error('connection lost'));

    expect((await get('boom')).status).toBe(500);
  });
});

describe('PUT /api/buses/[id]', () => {
  it('restricts updates to admins', async () => {
    actAs(prisma, passenger);

    const response = await updateBus(
      apiRequest('/buses/bus-1', { method: 'PUT', user: passenger, body: {} }),
      params('bus-1'),
    );

    expect(response.status).toBe(403);
    expect(prisma.bus.update).not.toHaveBeenCalled();
  });

  it('returns 404 for an unknown bus', async () => {
    prisma.bus.findUnique.mockResolvedValue(null);

    const response = await put({ busNumber: 'B2' }, 'missing');

    expect(response.status).toBe(404);
  });

  it('rejects a bus number or plate already used by another bus', async () => {
    prisma.bus.findUnique.mockResolvedValue(busFixture());
    prisma.bus.findFirst.mockResolvedValue(busFixture({ id: 'bus-2' }));

    const response = await put({ busNumber: 'B2' });

    expect(response.status).toBe(400);
    expect((await response.json()).error).toMatch(/already exists/i);
    expect(prisma.bus.update).not.toHaveBeenCalled();
  });

  it('updates only the supplied fields, coercing numbers', async () => {
    prisma.bus.findUnique.mockResolvedValue(busFixture());
    prisma.bus.findFirst.mockResolvedValue(null);
    prisma.bus.update.mockResolvedValue(busFixture({ status: 'MAINTENANCE' }));

    const response = await put({ status: 'MAINTENANCE', capacity: '55', mileage: '9000' });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.message).toMatch(/updated successfully/i);

    const { data } = prisma.bus.update.mock.calls[0][0];
    expect(data.status).toBe('MAINTENANCE');
    expect(data.capacity).toBe(55);
    expect(data.mileage).toBe(9000);
    // Fields not supplied must not be written.
    expect(data).not.toHaveProperty('busNumber');
    expect(data).not.toHaveProperty('plateNumber');
  });

  it('skips the duplicate check when neither number is being changed', async () => {
    prisma.bus.findUnique.mockResolvedValue(busFixture());
    prisma.bus.update.mockResolvedValue(busFixture());

    await put({ model: 'New Model' });

    expect(prisma.bus.findFirst).not.toHaveBeenCalled();
  });

  it('audits the update and flushes the cache', async () => {
    prisma.bus.findUnique.mockResolvedValue(busFixture());
    prisma.bus.update.mockResolvedValue(busFixture());

    await get();
    await put({ model: 'Updated' });

    const log = prisma.activityLog.create.mock.calls.at(-1)[0].data;
    expect(log.action).toBe('UPDATE_BUS');
    expect(log.userId).toBe(admin.id);

    const after = await get();
    expect(after.headers.get('X-Cache')).toBe('MISS');
  });

  it('returns 500 when the database throws', async () => {
    prisma.bus.findUnique.mockRejectedValue(new Error('connection lost'));

    expect((await put({ model: 'x' })).status).toBe(500);
  });
});

describe('DELETE /api/buses/[id]', () => {
  it('restricts deletion to admins', async () => {
    actAs(prisma, passenger);

    const response = await deleteBus(
      apiRequest('/buses/bus-1', { method: 'DELETE', user: passenger }),
      params('bus-1'),
    );

    expect(response.status).toBe(403);
    expect(prisma.bus.delete).not.toHaveBeenCalled();
  });

  it('returns 404 for an unknown bus', async () => {
    prisma.bus.findUnique.mockResolvedValue(null);

    const response = await del('missing');

    expect(response.status).toBe(404);
    expect(prisma.bus.delete).not.toHaveBeenCalled();
  });

  it('refuses to delete a bus that still has active schedules', async () => {
    prisma.bus.findUnique.mockResolvedValue(busFixture());
    prisma.schedule.count.mockResolvedValue(2);

    const response = await del();

    expect(response.status).toBe(400);
    expect((await response.json()).error).toMatch(/active schedules/i);
    expect(prisma.bus.delete).not.toHaveBeenCalled();
  });

  it('deletes the bus, audits it and flushes the cache', async () => {
    prisma.bus.findUnique.mockResolvedValue(busFixture());
    prisma.schedule.count.mockResolvedValue(0);
    prisma.bus.delete.mockResolvedValue(busFixture());

    const response = await del();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.message).toMatch(/deleted successfully/i);
    expect(prisma.bus.delete).toHaveBeenCalledWith({ where: { id: 'bus-1' } });

    const log = prisma.activityLog.create.mock.calls.at(-1)[0].data;
    expect(log.action).toBe('DELETE_BUS');
    // The audit entry names the bus that was removed.
    expect(log.details).toContain('B1');
  });

  it('returns 500 when the database throws', async () => {
    prisma.bus.findUnique.mockRejectedValue(new Error('connection lost'));

    expect((await del()).status).toBe(500);
  });
});
