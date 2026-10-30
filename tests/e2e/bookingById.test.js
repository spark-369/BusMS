import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  actAs,
  adminUser,
  apiRequest,
  bookingFixture,
  params,
  passengerUser,
  primeSideEffects,
} from '../helpers/routeHarness';

vi.mock('@/lib/prisma', async () => {
  const { createPrismaMock } = await import('../helpers/prismaMock');
  return { default: createPrismaMock() };
});

delete process.env.REDIS_URL;

let prisma;
let getBooking;
let updateBooking;
let deleteBooking;

beforeAll(async () => {
  prisma = (await import('@/lib/prisma')).default;
  ({ GET: getBooking, PUT: updateBooking, DELETE: deleteBooking } = await import(
    '@/app/api/bookings/[id]/route'
  ));
});

const admin = adminUser();
const passenger = passengerUser();

const get = (id = 'booking-1', user = admin) =>
  getBooking(apiRequest(`/bookings/${id}`, { user }), params(id));
const put = (body, { id = 'booking-1', user = admin } = {}) =>
  updateBooking(
    apiRequest(`/bookings/${id}`, { method: 'PUT', user, body }),
    params(id),
  );
const del = (id = 'booking-1') =>
  deleteBooking(
    apiRequest(`/bookings/${id}`, { method: 'DELETE', user: admin }),
    params(id),
  );

beforeEach(() => {
  vi.clearAllMocks();
  actAs(prisma, admin);
  primeSideEffects(prisma);
});

describe('GET /api/bookings/[id]', () => {
  it('requires authentication', async () => {
    const response = await getBooking(
      apiRequest('/bookings/booking-1'),
      params('booking-1'),
    );

    expect(response.status).toBe(401);
  });

  it('returns a booking to an admin', async () => {
    prisma.booking.findUnique.mockResolvedValue(bookingFixture());

    const response = await get();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.booking.id).toBe('booking-1');
  });

  it('returns 404 for an unknown booking', async () => {
    prisma.booking.findUnique.mockResolvedValue(null);

    expect((await get('missing')).status).toBe(404);
  });

  it("lets a passenger read their own booking", async () => {
    actAs(prisma, passenger);
    prisma.booking.findUnique.mockResolvedValue(bookingFixture());

    const response = await get('booking-1', passenger);

    expect(response.status).toBe(200);
  });

  it("blocks a passenger from reading someone else's booking", async () => {
    actAs(prisma, passenger);
    prisma.booking.findUnique.mockResolvedValue(
      bookingFixture({ userId: 'another-passenger' }),
    );

    const response = await get('booking-1', passenger);

    expect(response.status).toBe(403);
    expect((await response.json()).error).toMatch(/unauthorized/i);
  });
});

describe('PUT /api/bookings/[id]', () => {
  it('restricts updates to admins and passengers', async () => {
    actAs(prisma, adminUser({ id: 'driver-1', role: 'DRIVER' }));

    const response = await updateBooking(
      apiRequest('/bookings/booking-1', {
        method: 'PUT',
        user: adminUser({ id: 'driver-1', role: 'DRIVER' }),
        body: { status: 'CANCELLED' },
      }),
      params('booking-1'),
    );

    expect(response.status).toBe(403);
    expect(prisma.booking.update).not.toHaveBeenCalled();
  });

  it('returns 404 for an unknown booking', async () => {
    prisma.booking.findUnique.mockResolvedValue(null);

    expect((await put({ status: 'CANCELLED' }, { id: 'missing' })).status).toBe(
      404,
    );
  });

  it('blocks a passenger from updating another passenger booking', async () => {
    actAs(prisma, passenger);
    prisma.booking.findUnique.mockResolvedValue(
      bookingFixture({ userId: 'another-passenger' }),
    );

    const response = await put(
      { status: 'CANCELLED' },
      { user: passenger },
    );

    expect(response.status).toBe(403);
    expect(prisma.booking.update).not.toHaveBeenCalled();
  });

  it('allows a passenger to cancel their own booking', async () => {
    actAs(prisma, passenger);
    prisma.booking.findUnique.mockResolvedValue(bookingFixture());
    prisma.booking.update.mockResolvedValue(bookingFixture({ status: 'CANCELLED' }));

    const response = await put({ status: 'CANCELLED' }, { user: passenger });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.message).toMatch(/updated successfully/i);
    expect(prisma.booking.update.mock.calls[0][0].data.status).toBe('CANCELLED');
  });

  it('stops a passenger from setting any status other than CANCELLED', async () => {
    actAs(prisma, passenger);
    prisma.booking.findUnique.mockResolvedValue(bookingFixture());

    const response = await put({ status: 'CONFIRMED' }, { user: passenger });

    expect(response.status).toBe(403);
    expect((await response.json()).error).toMatch(/only cancel/i);
    expect(prisma.booking.update).not.toHaveBeenCalled();
  });

  it('lets an admin change status, stop and date, and audits it', async () => {
    prisma.booking.findUnique.mockResolvedValue(bookingFixture());
    prisma.booking.update.mockResolvedValue(bookingFixture({ status: 'COMPLETED' }));

    const response = await put({
      status: 'COMPLETED',
      stopId: 'stop-2',
      bookingDate: '2024-04-01',
    });

    expect(response.status).toBe(200);

    const { data } = prisma.booking.update.mock.calls[0][0];
    expect(data.status).toBe('COMPLETED');
    expect(data.stopId).toBe('stop-2');
    expect(data.bookingDate).toBeInstanceOf(Date);

    const log = prisma.activityLog.create.mock.calls.at(-1)[0].data;
    expect(log.action).toBe('UPDATE_BOOKING');
  });

  it('returns 500 when the database throws', async () => {
    prisma.booking.findUnique.mockRejectedValue(new Error('connection lost'));

    expect((await put({ status: 'CANCELLED' })).status).toBe(500);
  });
});

describe('DELETE /api/bookings/[id]', () => {
  it('restricts deletion to admins', async () => {
    actAs(prisma, passenger);

    const response = await deleteBooking(
      apiRequest('/bookings/booking-1', { method: 'DELETE', user: passenger }),
      params('booking-1'),
    );

    expect(response.status).toBe(403);
    expect(prisma.booking.delete).not.toHaveBeenCalled();
  });

  it('returns 404 for an unknown booking', async () => {
    prisma.booking.findUnique.mockResolvedValue(null);

    expect((await del('missing')).status).toBe(404);
  });

  it('deletes the booking and audits it', async () => {
    prisma.booking.findUnique.mockResolvedValue(bookingFixture());
    prisma.booking.delete.mockResolvedValue(bookingFixture());

    const response = await del();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.message).toMatch(/deleted successfully/i);
    expect(prisma.booking.delete).toHaveBeenCalledWith({
      where: { id: 'booking-1' },
    });

    const log = prisma.activityLog.create.mock.calls.at(-1)[0].data;
    expect(log.action).toBe('DELETE_BOOKING');
  });
});
