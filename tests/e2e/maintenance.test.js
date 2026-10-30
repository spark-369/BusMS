import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  actAs,
  adminUser,
  apiRequest,
  busFixture,
  driverUser,
  maintenanceFixture,
  passengerUser,
  primeSideEffects,
} from '../helpers/routeHarness';

vi.mock('@/lib/prisma', async () => {
  const { createPrismaMock } = await import('../helpers/prismaMock');
  return { default: createPrismaMock() };
});

delete process.env.REDIS_URL;

let prisma;
let getMaintenance;
let createMaintenance;
let updateMaintenance;
let deleteMaintenance;

beforeAll(async () => {
  prisma = (await import('@/lib/prisma')).default;
  ({
    GET: getMaintenance,
    POST: createMaintenance,
    PUT: updateMaintenance,
    DELETE: deleteMaintenance,
  } = await import('@/app/api/maintenance/route'));
});

const admin = adminUser();
const passenger = passengerUser();
const driver = driverUser();

const get = (query = '') =>
  getMaintenance(apiRequest(`/maintenance${query}`, { user: admin }));
const post = (body, user = admin) =>
  createMaintenance(apiRequest('/maintenance', { method: 'POST', user, body }));
const put = (body, user = admin) =>
  updateMaintenance(apiRequest('/maintenance', { method: 'PUT', user, body }));
const del = (query = '', user = admin) =>
  deleteMaintenance(apiRequest(`/maintenance${query}`, { method: 'DELETE', user }));

beforeEach(() => {
  vi.clearAllMocks();
  actAs(prisma, admin);
  primeSideEffects(prisma);
});

describe('GET /api/maintenance', () => {
  it('requires authentication', async () => {
    const response = await getMaintenance(apiRequest('/maintenance'));

    expect(response.status).toBe(401);
    expect(prisma.maintenance.findMany).not.toHaveBeenCalled();
  });

  it('restricts the maintenance register to admins', async () => {
    actAs(prisma, driver);

    expect((await get('', driver)).status).toBe(403);
    actAs(prisma, passenger);
    expect((await get('', passenger)).status).toBe(403);
  });

  it('maps the bus, status and type filters', async () => {
    prisma.maintenance.findMany.mockResolvedValue([]);

    await get('?busId=bus-1&status=SCHEDULED&type=ROUTINE');

    expect(prisma.maintenance.findMany.mock.calls.at(-1)[0].where).toEqual({
      busId: 'bus-1',
      status: 'SCHEDULED',
      type: 'ROUTINE',
    });
  });

  it('returns records newest-first with the bus relation', async () => {
    prisma.maintenance.findMany.mockResolvedValue([maintenanceFixture()]);

    const response = await get();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.maintenance).toHaveLength(1);

    const args = prisma.maintenance.findMany.mock.calls.at(-1)[0];
    expect(args.orderBy).toEqual({ scheduledDate: 'desc' });
    expect(args.include.bus.select).toEqual({
      id: true,
      busNumber: true,
      plateNumber: true,
    });
  });

  it('caches repeated identical reads', async () => {
    prisma.maintenance.findMany.mockResolvedValue([]);

    await get('?status=SCHEDULED');
    const second = await get('?status=SCHEDULED');

    expect(second.headers.get('X-Cache')).toBe('HIT');
    expect(prisma.maintenance.findMany).toHaveBeenCalledTimes(1);
  });

  it('returns 500 when the database throws', async () => {
    prisma.maintenance.findMany.mockRejectedValue(new Error('connection lost'));

    expect((await get('?status=X')).status).toBe(500);
  });
});

describe('POST /api/maintenance', () => {
  const validBody = {
    busId: 'bus-1',
    type: 'ROUTINE',
    description: 'Oil change',
    scheduledDate: '2024-02-01',
  };

  it('restricts creation to admins', async () => {
    actAs(prisma, driver);

    const response = await post(validBody, driver);

    expect(response.status).toBe(403);
    expect(prisma.maintenance.create).not.toHaveBeenCalled();
  });

  it('requires the bus, type, description and date', async () => {
    const response = await post({ busId: 'bus-1' });

    expect(response.status).toBe(400);
    expect((await response.json()).error).toMatch(/required/i);
  });

  it('rejects an unknown maintenance type', async () => {
    const response = await post({ ...validBody, type: 'WASH' });

    expect(response.status).toBe(400);
    expect((await response.json()).error).toMatch(/invalid maintenance type/i);
  });

  it('rejects an unparseable scheduled date', async () => {
    const response = await post({ ...validBody, scheduledDate: 'soon' });

    expect(response.status).toBe(400);
    expect((await response.json()).error).toMatch(/invalid scheduled date/i);
  });

  it('returns 404 when the bus does not exist', async () => {
    prisma.bus.findUnique.mockResolvedValue(null);

    const response = await post(validBody);

    expect(response.status).toBe(404);
    expect((await response.json()).error).toMatch(/bus not found/i);
  });

  it('creates a SCHEDULED record without touching the bus status', async () => {
    prisma.bus.findUnique.mockResolvedValue(busFixture());
    prisma.maintenance.create.mockResolvedValue(maintenanceFixture());

    const response = await post({ ...validBody, cost: '120.5' });
    const body = await response.json();

    expect(response.status).toBe(201);
    expect(body.message).toMatch(/created successfully/i);

    const { data } = prisma.maintenance.create.mock.calls[0][0];
    expect(data.status).toBe('SCHEDULED');
    expect(data.scheduledDate).toBeInstanceOf(Date);
    // A string cost from a form must be coerced to a number.
    expect(data.cost).toBe(120.5);

    // A routine service must not park the bus.
    expect(prisma.bus.update).not.toHaveBeenCalled();
  });

  it('flags the bus as MAINTENANCE for a repair or breakdown', async () => {
    prisma.bus.findUnique.mockResolvedValue(busFixture());
    prisma.maintenance.create.mockResolvedValue(
      maintenanceFixture({ type: 'REPAIR' }),
    );
    prisma.bus.update.mockResolvedValue(busFixture({ status: 'MAINTENANCE' }));

    await post({ ...validBody, type: 'BREAKDOWN' });

    expect(prisma.bus.update).toHaveBeenCalledWith({
      where: { id: 'bus-1' },
      data: { status: 'MAINTENANCE' },
    });
  });

  it('notifies drivers, audits and flushes the cache', async () => {
    prisma.maintenance.findMany.mockResolvedValue([]);
    prisma.bus.findUnique.mockResolvedValue(busFixture());
    prisma.maintenance.create.mockResolvedValue(maintenanceFixture());

    await get();
    await post(validBody);

    const notification = prisma.notification.create.mock.calls.at(-1)[0].data;
    expect(notification.userRole).toBe('DRIVER');
    expect(notification.type).toBe('MAINTENANCE_CREATED');

    const log = prisma.activityLog.create.mock.calls.at(-1)[0].data;
    expect(log.action).toBe('CREATE_MAINTENANCE');

    const after = await get();
    expect(after.headers.get('X-Cache')).toBe('MISS');
  });
});

describe('PUT /api/maintenance', () => {
  it('restricts updates to admins', async () => {
    actAs(prisma, driver);

    const response = await put({ id: 'maintenance-1', status: 'IN_PROGRESS' }, driver);

    expect(response.status).toBe(403);
    expect(prisma.maintenance.update).not.toHaveBeenCalled();
  });

  it('requires the id and status', async () => {
    const response = await put({ id: 'maintenance-1' });

    expect(response.status).toBe(400);
    expect((await response.json()).error).toMatch(/required/i);
  });

  it('rejects an unknown status', async () => {
    const response = await put({ id: 'maintenance-1', status: 'FINISHED' });

    expect(response.status).toBe(400);
    expect((await response.json()).error).toMatch(/invalid status/i);
  });

  it('returns 404 for an unknown record', async () => {
    prisma.maintenance.findUnique.mockResolvedValue(null);

    const response = await put({ id: 'missing', status: 'IN_PROGRESS' });

    expect(response.status).toBe(404);
  });

  it('starts the work without releasing the bus', async () => {
    prisma.maintenance.findUnique.mockResolvedValue(maintenanceFixture());
    prisma.maintenance.update.mockResolvedValue(
      maintenanceFixture({ status: 'IN_PROGRESS' }),
    );

    const response = await put({ id: 'maintenance-1', status: 'IN_PROGRESS' });

    expect(response.status).toBe(200);

    const { data } = prisma.maintenance.update.mock.calls[0][0];
    expect(data.status).toBe('IN_PROGRESS');
    expect(data).not.toHaveProperty('completedDate');
    expect(prisma.bus.update).not.toHaveBeenCalled();
  });

  it('completes the record and returns the bus to service', async () => {
    prisma.maintenance.findUnique.mockResolvedValue(maintenanceFixture());
    prisma.maintenance.update.mockResolvedValue(
      maintenanceFixture({ status: 'COMPLETED' }),
    );
    prisma.bus.update.mockResolvedValue(busFixture());

    const response = await put({ id: 'maintenance-1', status: 'COMPLETED', cost: 200 });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.message).toMatch(/updated successfully/i);

    const { data } = prisma.maintenance.update.mock.calls[0][0];
    expect(data.completedDate).toBeInstanceOf(Date);
    expect(data.cost).toBe(200);

    // Finishing maintenance must clear the MAINTENANCE bus status.
    expect(prisma.bus.update).toHaveBeenCalledWith({
      where: { id: 'bus-1' },
      data: { status: 'ACTIVE', lastMaintenance: expect.any(Date) },
    });

    const log = prisma.activityLog.create.mock.calls.at(-1)[0].data;
    expect(log.action).toBe('UPDATE_MAINTENANCE');
  });
});

describe('DELETE /api/maintenance', () => {
  it('restricts deletion to admins', async () => {
    actAs(prisma, passenger);

    const response = await del('?id=maintenance-1', passenger);

    expect(response.status).toBe(403);
    expect(prisma.maintenance.delete).not.toHaveBeenCalled();
  });

  it('requires the record id', async () => {
    const response = await del();

    expect(response.status).toBe(400);
    expect((await response.json()).error).toMatch(/id is required/i);
  });

  it('returns 404 for an unknown record', async () => {
    prisma.maintenance.findUnique.mockResolvedValue(null);

    expect((await del('?id=missing')).status).toBe(404);
  });

  it('deletes the record and audits it', async () => {
    prisma.maintenance.findUnique.mockResolvedValue(maintenanceFixture());
    prisma.maintenance.delete.mockResolvedValue(maintenanceFixture());

    const response = await del('?id=maintenance-1');
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.message).toMatch(/deleted successfully/i);
    expect(prisma.maintenance.delete).toHaveBeenCalledWith({
      where: { id: 'maintenance-1' },
    });

    const log = prisma.activityLog.create.mock.calls.at(-1)[0].data;
    expect(log.action).toBe('DELETE_MAINTENANCE');
  });
});
