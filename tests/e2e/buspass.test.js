import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  actAs,
  adminUser,
  apiRequest,
  busPassFixture,
  driverUser,
  mockUserLookups,
  passengerUser,
  primeSideEffects,
} from '../helpers/routeHarness';
import { buildAuthUser } from '../helpers/prismaMock';

vi.mock('@/lib/prisma', async () => {
  const { createPrismaMock } = await import('../helpers/prismaMock');
  return { default: createPrismaMock() };
});

delete process.env.REDIS_URL;

let prisma;
let getBusPasses;
let createBusPass;
let verifyPass;
let patchBusPass;
let deleteBusPass;

beforeAll(async () => {
  prisma = (await import('@/lib/prisma')).default;
  ({
    GET: getBusPasses,
    POST: createBusPass,
    PUT: verifyPass,
    PATCH: patchBusPass,
    DELETE: deleteBusPass,
  } = await import('@/app/api/buspass/route'));
});

const admin = adminUser();
const driver = driverUser();
const passenger = passengerUser();

const get = (query = '', user = admin) =>
  getBusPasses(apiRequest(`/buspass${query}`, { user }));
const post = (body, user = admin) =>
  createBusPass(apiRequest('/buspass', { method: 'POST', user, body }));
const patch = (body, user = admin) =>
  patchBusPass(apiRequest('/buspass', { method: 'PATCH', user, body }));
const del = (query = '', user = admin) =>
  deleteBusPass(apiRequest(`/buspass${query}`, { method: 'DELETE', user }));

beforeEach(() => {
  vi.clearAllMocks();
  actAs(prisma, admin);
  primeSideEffects(prisma);
});

describe('GET /api/buspass', () => {
  it('requires authentication', async () => {
    const response = await getBusPasses(apiRequest('/buspass'));

    expect(response.status).toBe(401);
    expect(prisma.busPass.findMany).not.toHaveBeenCalled();
  });

  it('scopes a passenger to their own pass', async () => {
    actAs(prisma, passenger);
    prisma.busPass.findMany.mockResolvedValue([]);

    await get('', passenger);

    // A passenger must not be able to enumerate other passes via ?passengerId.
    expect(prisma.busPass.findMany.mock.calls.at(-1)[0].where).toEqual({
      passengerId: 'passenger-1',
    });
  });

  it('lets an admin filter by passenger id', async () => {
    prisma.busPass.findMany.mockResolvedValue([]);

    await get('?passengerId=passenger-9');

    expect(prisma.busPass.findMany.mock.calls.at(-1)[0].where).toEqual({
      passengerId: 'passenger-9',
    });
  });

  it('returns passes newest-first with the passenger relation', async () => {
    prisma.busPass.findMany.mockResolvedValue([busPassFixture()]);

    const response = await get();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.busPasses).toHaveLength(1);

    const args = prisma.busPass.findMany.mock.calls.at(-1)[0];
    expect(args.orderBy).toEqual({ endDate: 'desc' });
    expect(args.include.passenger).toBe(true);
  });

  it('returns 500 when the database throws', async () => {
    prisma.busPass.findMany.mockRejectedValue(new Error('connection lost'));

    expect((await get('?passengerId=x')).status).toBe(500);
  });
});

describe('POST /api/buspass', () => {
  const validBody = {
    passengerId: 'passenger-1',
    startDate: '2024-01-01',
    endDate: '2024-12-31',
  };

  /**
   * The auth middleware and this handler BOTH call `user.findUnique` — the
   * middleware by actor id, the handler by the target passenger id. A blanket
   * `mockResolvedValue` would hand the passenger row to the auth check and turn
   * an expected 400/404 into a 403, so the double is keyed by id.
   */
  const actingAsAdminWith = (target) =>
    mockUserLookups(prisma, {
      [admin.id]: buildAuthUser(admin),
      ...(target ? { 'passenger-1': target } : {}),
    });

  it('restricts issuance to admins', async () => {
    actAs(prisma, passenger);

    const response = await post(validBody, passenger);

    expect(response.status).toBe(403);
    expect(prisma.busPass.create).not.toHaveBeenCalled();
  });

  it('requires a passenger and both dates', async () => {
    const response = await post({ passengerId: 'passenger-1' });

    expect(response.status).toBe(400);
    expect((await response.json()).error).toMatch(/required/i);
  });

  it('returns 404 when the passenger does not exist', async () => {
    actingAsAdminWith(null);

    const response = await post(validBody);

    expect(response.status).toBe(404);
    expect((await response.json()).error).toMatch(/passenger not found/i);
  });

  it('refuses to issue a pass to a non-passenger account', async () => {
    actingAsAdminWith({ id: 'passenger-1', role: 'DRIVER' });

    const response = await post(validBody);

    expect(response.status).toBe(400);
    expect((await response.json()).error).toMatch(
      /only be issued to passengers/i,
    );
  });

  it('rejects an end date that is not after the start date', async () => {
    actingAsAdminWith({ id: 'passenger-1', role: 'PASSENGER' });

    const response = await post({
      ...validBody,
      startDate: '2024-12-31',
      endDate: '2024-01-01',
    });

    expect(response.status).toBe(400);
    expect((await response.json()).error).toMatch(/after the start date/i);
  });

  it('rejects a passenger who already has an active pass', async () => {
    actingAsAdminWith({ id: 'passenger-1', role: 'PASSENGER' });
    prisma.busPass.findFirst.mockResolvedValue(busPassFixture());

    const response = await post(validBody);

    expect(response.status).toBe(400);
    expect((await response.json()).error).toMatch(/already exists/i);
    expect(prisma.busPass.create).not.toHaveBeenCalled();
  });

  it('issues the pass with a generated number, QR code and notification', async () => {
    actingAsAdminWith({
      id: 'passenger-1',
      role: 'PASSENGER',
      email: 'passenger@campus.edu',
    });
    prisma.busPass.findFirst.mockResolvedValue(null);
    prisma.busPass.create.mockResolvedValue(busPassFixture({ id: 'pass-9' }));

    const response = await post(validBody);
    const body = await response.json();

    expect(response.status).toBe(201);
    expect(body.message).toMatch(/created successfully/i);

    const { data } = prisma.busPass.create.mock.calls[0][0];
    expect(data.passengerId).toBe('passenger-1');
    expect(data.passNumber).toMatch(/^BP-/);
    expect(data.qrCode).toContain('data:image');
    expect(data.isActive).toBe(true);

    const notification = prisma.notification.create.mock.calls.at(-1)[0].data;
    expect(notification.type).toBe('BUS_PASS_CREATED');
    expect(notification.userRole).toBe('PASSENGER');

    const log = prisma.activityLog.create.mock.calls.at(-1)[0].data;
    expect(log.action).toBe('CREATE_BUS_PASS');
  });
});

describe('PUT /api/buspass — QR verification and attendance', () => {
  it('restricts verification to admins and drivers', async () => {
    actAs(prisma, passenger);

    const response = await verifyPass(
      apiRequest('/buspass', { method: 'PUT', user: passenger, body: { passNumber: 'BP-1' } }),
    );

    expect(response.status).toBe(403);
    expect(prisma.busPass.findFirst).not.toHaveBeenCalled();
  });

  it('returns 404 for an invalid or expired pass', async () => {
    actAs(prisma, driver);
    prisma.busPass.findFirst.mockResolvedValue(null);

    const response = await verifyPass(
      apiRequest('/buspass', { method: 'PUT', user: driver, body: { passNumber: 'BP-X' } }),
    );

    expect(response.status).toBe(404);
    expect((await response.json()).error).toMatch(/invalid or expired/i);
  });

  it('accepts the pass number from either field', async () => {
    actAs(prisma, driver);
    prisma.busPass.findFirst.mockResolvedValue(
      busPassFixture({ passenger: { name: 'Passenger', passengerId: 'P-1' } }),
    );
    prisma.booking.updateMany.mockResolvedValue({ count: 0 });

    // The QR scanner sends `qrCode`; a manual entry sends `passNumber`.
    await verifyPass(
      apiRequest('/buspass', { method: 'PUT', user: driver, body: { qrCode: 'BP-1' } }),
    );

    expect(prisma.busPass.findFirst.mock.calls.at(-1)[0].where.passNumber).toBe('BP-1');
  });

  it('verifies the pass and marks today attendance as used', async () => {
    actAs(prisma, driver);
    prisma.busPass.findFirst.mockResolvedValue(
      busPassFixture({ passenger: { name: 'Passenger', passengerId: 'P-1' } }),
    );
    prisma.booking.updateMany.mockResolvedValue({ count: 2 });

    const response = await verifyPass(
      apiRequest('/buspass', { method: 'PUT', user: driver, body: { passNumber: 'BP-1' } }),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.valid).toBe(true);
    expect(body.busPass.passNumber).toBe('BP-1');
    expect(body.attendance.marked).toBe(2);

    const { where, data } = prisma.booking.updateMany.mock.calls.at(-1)[0];
    // Attendance is scoped to the pass holder and to today's local window.
    expect(where.userId).toBe('passenger-1');
    expect(where.bookingDate.gte.getHours()).toBe(0);
    expect(where.bookingDate.lt.getHours()).toBe(0);
    expect(where.isUsed).toBe(false);
    expect(where.status.in).toEqual(['CONFIRMED', 'COMPLETED']);
    expect(data).toEqual({ isUsed: true });

    const log = prisma.activityLog.create.mock.calls.at(-1)[0].data;
    expect(log.action).toBe('VERIFY_BUS_PASS');
  });

  it('returns 500 when the database throws', async () => {
    actAs(prisma, driver);
    prisma.busPass.findFirst.mockRejectedValue(new Error('connection lost'));

    expect(
      (await verifyPass(
        apiRequest('/buspass', { method: 'PUT', user: driver, body: { passNumber: 'BP-1' } }),
      )).status,
    ).toBe(500);
  });
});

describe('PATCH /api/buspass — admin updates', () => {
  it('restricts updates to admins', async () => {
    actAs(prisma, passenger);

    const response = await patch({ id: 'pass-1' }, passenger);

    expect(response.status).toBe(403);
    expect(prisma.busPass.update).not.toHaveBeenCalled();
  });

  it('requires the bus pass id', async () => {
    const response = await patch({});

    expect(response.status).toBe(400);
    expect((await response.json()).error).toMatch(/id is required/i);
  });

  it('returns 404 for an unknown pass', async () => {
    prisma.busPass.findUnique.mockResolvedValue(null);

    const response = await patch({ id: 'missing' });

    expect(response.status).toBe(404);
  });

  it('updates only the supplied fields and audits it', async () => {
    prisma.busPass.findUnique.mockResolvedValue(busPassFixture());
    prisma.busPass.update.mockResolvedValue(busPassFixture({ isActive: false }));

    const response = await patch({ id: 'pass-1', isActive: false });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.message).toMatch(/updated successfully/i);

    const { data } = prisma.busPass.update.mock.calls[0][0];
    expect(data.isActive).toBe(false);
    expect(data).not.toHaveProperty('startDate');
    expect(data).not.toHaveProperty('endDate');

    const log = prisma.activityLog.create.mock.calls.at(-1)[0].data;
    expect(log.action).toBe('UPDATE_BUS_PASS');
  });

  it('parses supplied dates into Date objects', async () => {
    prisma.busPass.findUnique.mockResolvedValue(busPassFixture());
    prisma.busPass.update.mockResolvedValue(busPassFixture());

    await patch({ id: 'pass-1', startDate: '2024-05-01', endDate: '2024-11-01' });

    const { data } = prisma.busPass.update.mock.calls[0][0];
    expect(data.startDate).toBeInstanceOf(Date);
    expect(data.endDate).toBeInstanceOf(Date);
  });
});

describe('DELETE /api/buspass', () => {
  it('restricts deletion to admins', async () => {
    actAs(prisma, passenger);

    const response = await del('?id=pass-1', passenger);

    expect(response.status).toBe(403);
    expect(prisma.busPass.delete).not.toHaveBeenCalled();
  });

  it('requires the bus pass id', async () => {
    const response = await del();

    expect(response.status).toBe(400);
    expect((await response.json()).error).toMatch(/id is required/i);
  });

  it('returns 404 for an unknown pass', async () => {
    prisma.busPass.findUnique.mockResolvedValue(null);

    expect((await del('?id=missing')).status).toBe(404);
  });

  it('deletes the pass and audits it', async () => {
    prisma.busPass.findUnique.mockResolvedValue(busPassFixture());
    prisma.busPass.delete.mockResolvedValue(busPassFixture());

    const response = await del('?id=pass-1');
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.message).toMatch(/deleted successfully/i);
    expect(prisma.busPass.delete).toHaveBeenCalledWith({ where: { id: 'pass-1' } });

    const log = prisma.activityLog.create.mock.calls.at(-1)[0].data;
    expect(log.action).toBe('DELETE_BUS_PASS');
  });

  it('returns 500 when the database throws', async () => {
    prisma.busPass.findUnique.mockRejectedValue(new Error('connection lost'));

    expect((await del('?id=pass-1')).status).toBe(500);
  });
});
