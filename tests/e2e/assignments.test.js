import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  actAs,
  adminUser,
  apiRequest,
  busFixture,
  driverUser,
  mockUserLookups,
  primeSideEffects,
} from '../helpers/routeHarness';
import { buildAuthUser } from '../helpers/prismaMock';

vi.mock('@/lib/prisma', async () => {
  const { createPrismaMock } = await import('../helpers/prismaMock');
  return { default: createPrismaMock() };
});

delete process.env.REDIS_URL;

let prisma;
let getAssignments;
let assignDriver;
let unassignDriver;

beforeAll(async () => {
  prisma = (await import('@/lib/prisma')).default;
  ({ GET: getAssignments, POST: assignDriver, DELETE: unassignDriver } =
    await import('@/app/api/assignments/route'));
});

const admin = adminUser();
const driver = driverUser();

const get = (query = '') =>
  getAssignments(apiRequest(`/assignments${query}`, { user: admin }));
const post = (body) =>
  assignDriver(apiRequest('/assignments', { method: 'POST', user: admin, body }));
const del = (query = '') =>
  unassignDriver(apiRequest(`/assignments${query}`, { method: 'DELETE', user: admin }));

beforeEach(() => {
  vi.clearAllMocks();
  actAs(prisma, admin);
  primeSideEffects(prisma);
});

describe('GET /api/assignments', () => {
  it('requires authentication', async () => {
    const response = await getAssignments(apiRequest('/assignments'));

    expect(response.status).toBe(401);
    expect(prisma.bus.findMany).not.toHaveBeenCalled();
  });

  it('restricts the assignment board to admins', async () => {
    actAs(prisma, driver);

    expect((await getAssignments(apiRequest('/assignments', { user: driver }))).status).toBe(
      403,
    );
  });

  it('returns buses, the unassigned driver pool and derived stats', async () => {
    prisma.bus.findMany.mockResolvedValue([
      busFixture({ id: 'bus-1', driver: { id: 'driver-1', name: 'Driver One' } }),
      busFixture({ id: 'bus-2', busNumber: 'B2', driver: null }),
    ]);
    prisma.user.findMany.mockResolvedValue([{ id: 'driver-9', name: 'Free Driver' }]);

    const response = await get();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.stats).toEqual({
      totalBuses: 2,
      assignedBuses: 1,
      unassignedBuses: 1,
      availableDrivers: 1,
    });

    // The pool must exclude drivers already attached to a bus.
    expect(prisma.user.findMany.mock.calls.at(-1)[0].where).toEqual({
      role: 'DRIVER',
      isActive: true,
      bus: null,
    });
  });

  it('supports a status filter and a case-insensitive search', async () => {
    prisma.bus.findMany.mockResolvedValue([]);
    prisma.user.findMany.mockResolvedValue([]);

    await get('?status=ACTIVE&search=volvo');

    const { where } = prisma.bus.findMany.mock.calls.at(-1)[0];
    expect(where.status).toBe('ACTIVE');
    expect(where.OR).toHaveLength(3);
    expect(where.OR[0].busNumber.mode).toBe('insensitive');
  });

  it('caches repeated identical reads', async () => {
    prisma.bus.findMany.mockResolvedValue([]);
    prisma.user.findMany.mockResolvedValue([]);

    await get();
    const second = await get();

    expect(second.headers.get('X-Cache')).toBe('HIT');
    expect(prisma.bus.findMany).toHaveBeenCalledTimes(1);
  });
});

describe('POST /api/assignments — assign a driver', () => {
  const validBody = { busId: 'bus-1', driverId: 'driver-1' };

  /**
   * Both the auth middleware and this handler call `user.findUnique` (the
   * middleware by actor id, the handler by the target driver id), so the double
   * must discriminate or the admin row would be handed back as the "driver".
   */
  const actingAsAdminWithDriver = (driverRow) =>
    mockUserLookups(prisma, {
      [admin.id]: buildAuthUser(admin),
      ...(driverRow ? { 'driver-1': driverRow } : {}),
    });

  it('restricts assignment to admins', async () => {
    actAs(prisma, driver);

    const response = await assignDriver(
      apiRequest('/assignments', { method: 'POST', user: driver, body: validBody }),
    );

    expect(response.status).toBe(403);
    expect(prisma.bus.update).not.toHaveBeenCalled();
  });

  it('requires both a bus and a driver', async () => {
    const response = await post({ busId: 'bus-1' });

    expect(response.status).toBe(400);
    expect((await response.json()).error).toMatch(/required/i);
  });

  it('returns 404 when the bus does not exist', async () => {
    prisma.bus.findUnique.mockResolvedValue(null);

    const response = await post(validBody);

    expect(response.status).toBe(404);
    expect((await response.json()).error).toMatch(/bus not found/i);
  });

  it('refuses a bus that already has a driver', async () => {
    prisma.bus.findUnique.mockResolvedValue(
      busFixture({ driver: { id: 'driver-2', name: 'Other' } }),
    );

    const response = await post(validBody);

    expect(response.status).toBe(400);
    expect((await response.json()).error).toMatch(/already assigned/i);
    expect(prisma.bus.update).not.toHaveBeenCalled();
  });

  it('returns 404 when the driver does not exist', async () => {
    prisma.bus.findUnique.mockResolvedValue(busFixture({ driver: null }));
    actingAsAdminWithDriver(null);

    const response = await post(validBody);

    expect(response.status).toBe(404);
    expect((await response.json()).error).toMatch(/driver not found/i);
  });

  it('refuses a user who is not a driver', async () => {
    prisma.bus.findUnique.mockResolvedValue(busFixture({ driver: null }));
    actingAsAdminWithDriver({
      id: 'driver-1',
      role: 'PASSENGER',
      isActive: true,
      bus: null,
    });

    const response = await post(validBody);

    expect(response.status).toBe(400);
    expect((await response.json()).error).toMatch(/not a driver/i);
  });

  it('refuses a deactivated driver', async () => {
    prisma.bus.findUnique.mockResolvedValue(busFixture({ driver: null }));
    actingAsAdminWithDriver({
      id: 'driver-1',
      role: 'DRIVER',
      isActive: false,
      bus: null,
    });

    const response = await post(validBody);

    expect(response.status).toBe(400);
    expect((await response.json()).error).toMatch(/deactivated/i);
  });

  it('refuses a driver who is already assigned to another bus', async () => {
    prisma.bus.findUnique.mockResolvedValue(busFixture({ driver: null }));
    actingAsAdminWithDriver({
      id: 'driver-1',
      role: 'DRIVER',
      isActive: true,
      bus: { id: 'bus-2', busNumber: 'B2' },
    });

    const response = await post(validBody);

    expect(response.status).toBe(400);
    expect((await response.json()).error).toMatch(/already assigned to bus B2/i);
  });

  it('assigns the driver, notifies them and writes an audit entry', async () => {
    prisma.bus.findUnique.mockResolvedValue(busFixture({ driver: null }));
    actingAsAdminWithDriver({
      id: 'driver-1',
      name: 'Driver One',
      role: 'DRIVER',
      isActive: true,
      bus: null,
    });
    prisma.bus.update.mockResolvedValue(
      busFixture({ driver: { id: 'driver-1', name: 'Driver One' } }),
    );

    const response = await post(validBody);
    const body = await response.json();

    expect(response.status).toBe(201);
    expect(body.message).toMatch(/assigned successfully/i);

    const updateArgs = prisma.bus.update.mock.calls.at(-1)[0];
    expect(updateArgs.where).toEqual({ id: 'bus-1' });
    expect(updateArgs.data).toEqual({ driverId: 'driver-1' });

    const notification = prisma.notification.create.mock.calls.at(-1)[0].data;
    expect(notification.userRole).toBe('DRIVER');
    expect(notification.message).toContain('B1');

    // This route writes its audit row directly rather than via logActivity.
    const log = prisma.activityLog.create.mock.calls.at(-1)[0].data;
    expect(log.action).toBe('ASSIGN_DRIVER');
  });
});

describe('DELETE /api/assignments — unassign a driver', () => {
  it('restricts unassignment to admins', async () => {
    actAs(prisma, driver);

    const response = await unassignDriver(
      apiRequest('/assignments?busId=bus-1', { method: 'DELETE', user: driver }),
    );

    expect(response.status).toBe(403);
  });

  it('requires a bus id', async () => {
    const response = await del();

    expect(response.status).toBe(400);
    expect((await response.json()).error).toMatch(/bus id is required/i);
  });

  it('returns 404 when the bus does not exist', async () => {
    prisma.bus.findUnique.mockResolvedValue(null);

    expect((await del('?busId=missing')).status).toBe(404);
  });

  it('refuses a bus with no assigned driver', async () => {
    prisma.bus.findUnique.mockResolvedValue(busFixture({ driver: null }));

    const response = await del('?busId=bus-1');

    expect(response.status).toBe(400);
    expect((await response.json()).error).toMatch(/no assigned driver/i);
  });

  it('clears the driver, audits it and flushes the cache', async () => {
    prisma.bus.findUnique.mockResolvedValue(
      busFixture({ driver: { id: 'driver-1', name: 'Driver One' } }),
    );
    prisma.bus.update.mockResolvedValue(busFixture({ driverId: null }));

    const response = await del('?busId=bus-1');
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.message).toMatch(/unassigned successfully/i);
    expect(prisma.bus.update).toHaveBeenCalledWith({
      where: { id: 'bus-1' },
      data: { driverId: null },
    });

    const log = prisma.activityLog.create.mock.calls.at(-1)[0].data;
    expect(log.action).toBe('UNASSIGN_DRIVER');
  });

  it('returns 500 when the database throws', async () => {
    prisma.bus.findUnique.mockRejectedValue(new Error('connection lost'));

    expect((await del('?busId=bus-1')).status).toBe(500);
  });
});
