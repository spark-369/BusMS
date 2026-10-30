import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  actAs,
  adminUser,
  apiRequest,
  bookingFixture,
  passengerUser,
  params,
  primeSideEffects,
  stopFixture,
} from '../helpers/routeHarness';

vi.mock('@/lib/prisma', async () => {
  const { createPrismaMock } = await import('../helpers/prismaMock');
  return { default: createPrismaMock() };
});

delete process.env.REDIS_URL;

let prisma;
let getStop;
let updateStop;
let deleteStop;

beforeAll(async () => {
  prisma = (await import('@/lib/prisma')).default;
  ({ GET: getStop, PUT: updateStop, DELETE: deleteStop } = await import(
    '@/app/api/stops/[id]/route'
  ));
});

const admin = adminUser();
const passenger = passengerUser();

const get = (id = 'stop-1') =>
  getStop(apiRequest(`/stops/${id}`, { user: admin }), params(id));
const put = (body, id = 'stop-1') =>
  updateStop(
    apiRequest(`/stops/${id}`, { method: 'PUT', user: admin, body }),
    params(id),
  );
const del = (id = 'stop-1') =>
  deleteStop(
    apiRequest(`/stops/${id}`, { method: 'DELETE', user: admin }),
    params(id),
  );

beforeEach(() => {
  vi.clearAllMocks();
  actAs(prisma, admin);
  primeSideEffects(prisma);
});

describe('GET /api/stops/[id]', () => {
  it('requires authentication', async () => {
    const response = await getStop(apiRequest('/stops/stop-1'), params('stop-1'));

    expect(response.status).toBe(401);
  });

  it('returns the stop with its route summary', async () => {
    prisma.stop.findUnique.mockResolvedValue(stopFixture());

    const response = await get();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.stop.id).toBe('stop-1');

    const args = prisma.stop.findUnique.mock.calls.at(-1)[0];
    expect(args.where).toEqual({ id: 'stop-1' });
    expect(args.include.route.select).toEqual({ id: true, name: true });
  });

  it('returns 404 for an unknown stop', async () => {
    prisma.stop.findUnique.mockResolvedValue(null);

    expect((await get('missing')).status).toBe(404);
  });

  it('caches a repeated read of the same id', async () => {
    prisma.stop.findUnique.mockResolvedValue(stopFixture());

    await get();
    const second = await get();

    expect(second.headers.get('X-Cache')).toBe('HIT');
    expect(prisma.stop.findUnique).toHaveBeenCalledTimes(1);
  });
});

describe('PUT /api/stops/[id]', () => {
  it('restricts updates to admins', async () => {
    actAs(prisma, passenger);

    const response = await updateStop(
      apiRequest('/stops/stop-1', { method: 'PUT', user: passenger, body: {} }),
      params('stop-1'),
    );

    expect(response.status).toBe(403);
    expect(prisma.stop.update).not.toHaveBeenCalled();
  });

  it('returns 404 for an unknown stop', async () => {
    prisma.stop.findUnique.mockResolvedValue(null);

    expect((await put({ name: 'X' }, 'missing')).status).toBe(404);
  });

  it('updates only supplied fields and coerces coordinates', async () => {
    prisma.stop.findUnique.mockResolvedValue(stopFixture());
    prisma.stop.update.mockResolvedValue(stopFixture({ name: 'Renamed' }));

    const response = await put({
      name: 'Renamed',
      latitude: '23.99',
      order: '3',
      isActive: false,
    });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.message).toMatch(/updated successfully/i);

    const { data } = prisma.stop.update.mock.calls[0][0];
    expect(data.name).toBe('Renamed');
    expect(data.latitude).toBe(23.99);
    expect(data.order).toBe(3);
    expect(data.isActive).toBe(false);
    // Untouched fields are not written.
    expect(data).not.toHaveProperty('longitude');
    expect(data).not.toHaveProperty('address');
  });

  it('flushes the stops and routes caches after an update', async () => {
    // Regression guard: `PUT /api/stops/[id]` used to skip `invalidate(...)`
    // entirely (every sibling `[id]` PUT handler flushes its namespaces), so the
    // 60s STOPS entry survived the write and the stops list served pre-edit data
    // for up to a minute. A stop edit also changes the route detail, which embeds
    // its stops, so BOTH namespaces must be bumped.
    prisma.stop.findUnique.mockResolvedValue(stopFixture());
    prisma.stop.update.mockResolvedValue(stopFixture());

    const first = await get();
    expect(first.headers.get('X-Cache')).toBe('MISS');

    await put({ name: 'Renamed' });
    expect(prisma.stop.update).toHaveBeenCalledTimes(1);

    const after = await get();
    expect(after.headers.get('X-Cache')).toBe('MISS');
  });

  it('returns 500 when the database throws', async () => {
    prisma.stop.findUnique.mockRejectedValue(new Error('connection lost'));

    expect((await put({ name: 'x' })).status).toBe(500);
  });
});

describe('DELETE /api/stops/[id]', () => {
  it('restricts deletion to admins', async () => {
    actAs(prisma, passenger);

    const response = await deleteStop(
      apiRequest('/stops/stop-1', { method: 'DELETE', user: passenger }),
      params('stop-1'),
    );

    expect(response.status).toBe(403);
  });

  it('hard-deletes a stop that no booking references', async () => {
    prisma.stop.findUnique.mockResolvedValue(stopFixture());
    prisma.booking.findMany.mockResolvedValue([]);
    prisma.stop.delete.mockResolvedValue(stopFixture());

    const response = await del();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.message).toMatch(/deleted successfully/i);
    expect(prisma.stop.delete).toHaveBeenCalledWith({ where: { id: 'stop-1' } });
    expect(prisma.stop.update).not.toHaveBeenCalled();
  });

  it('falls back to deactivation when bookings reference the stop', async () => {
    prisma.stop.findUnique.mockResolvedValue(stopFixture());
    prisma.booking.findMany.mockResolvedValue([bookingFixture()]);
    prisma.stop.update.mockResolvedValue(stopFixture({ isActive: false }));

    const response = await del();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.message).toMatch(/marked as inactive/i);

    // Referenced stops must never be hard-deleted, or history would break.
    expect(prisma.stop.delete).not.toHaveBeenCalled();
    expect(prisma.stop.update).toHaveBeenCalledWith({
      where: { id: 'stop-1' },
      data: { isActive: false },
    });
  });

  it('returns 404 for an unknown stop', async () => {
    prisma.stop.findUnique.mockResolvedValue(null);

    expect((await del('missing')).status).toBe(404);
  });
});
