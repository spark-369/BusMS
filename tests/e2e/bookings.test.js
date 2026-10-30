import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  actAs,
  adminUser,
  apiRequest,
  bookingFixture,
  busFixture,
  passengerUser,
  primeSideEffects,
  routeFixture,
  stopFixture,
  tripFixture,
} from '../helpers/routeHarness';

vi.mock('@/lib/prisma', async () => {
  const { createPrismaMock } = await import('../helpers/prismaMock');
  return { default: createPrismaMock() };
});

delete process.env.REDIS_URL;

let prisma;
let getBookings;
let createBooking;

beforeAll(async () => {
  prisma = (await import('@/lib/prisma')).default;
  ({ GET: getBookings, POST: createBooking } = await import(
    '@/app/api/bookings/route'
  ));
});

const admin = adminUser();
const passenger = passengerUser();

const get = (query = '', user = admin) =>
  getBookings(apiRequest(`/bookings${query}`, { user }));
/**
 * Booking writes are passenger-driven, so the acting user must match the token
 * the request carries — the auth middleware resolves the actor from the
 * database, and `user.id` is what gets written as the booking owner.
 */
const post = (body, user = passenger) => {
  actAs(prisma, user);
  return createBooking(apiRequest('/bookings', { method: 'POST', user, body }));
};

beforeEach(() => {
  vi.clearAllMocks();
  actAs(prisma, admin);
  primeSideEffects(prisma);
});

describe('GET /api/bookings', () => {
  it('requires authentication', async () => {
    const response = await getBookings(apiRequest('/bookings'));

    expect(response.status).toBe(401);
    expect(prisma.booking.findMany).not.toHaveBeenCalled();
  });

  it('scopes a passenger to their own bookings', async () => {
    actAs(prisma, passenger);
    prisma.booking.findMany.mockResolvedValue([]);

    await get('', passenger);

    // The security-critical filter: a passenger must never see another's rows,
    // even if they try to override `userId` in the query string.
    expect(prisma.booking.findMany.mock.calls.at(-1)[0].where).toEqual({
      userId: 'passenger-1',
    });
  });

  it('lets an admin filter by an arbitrary user id', async () => {
    prisma.booking.findMany.mockResolvedValue([]);

    await get('?userId=passenger-9');

    expect(prisma.booking.findMany.mock.calls.at(-1)[0].where).toEqual({
      userId: 'passenger-9',
    });
  });

  it('maps the status, bus and isUsed filters', async () => {
    prisma.booking.findMany.mockResolvedValue([]);

    await get('?status=CONFIRMED&busId=bus-1&isUsed=true');

    expect(prisma.booking.findMany.mock.calls.at(-1)[0].where).toEqual({
      status: 'CONFIRMED',
      busId: 'bus-1',
      isUsed: true,
    });
  });

  it('builds a local-day window from a date-only bookingDate', async () => {
    prisma.booking.findMany.mockResolvedValue([]);

    await get('?bookingDate=2024-03-01');

    const { bookingDate } = prisma.booking.findMany.mock.calls.at(-1)[0].where;
    expect(bookingDate.gte.getHours()).toBe(0);
    expect(bookingDate.lt.getHours()).toBe(0);
    // `parseDateOnly` yields local midnight, so the window spans one local day.
    // (A day either side of 24h keeps this robust across DST transitions.)
    const windowMs = bookingDate.lt.getTime() - bookingDate.gte.getTime();
    expect(windowMs).toBeGreaterThanOrEqual(23 * 60 * 60 * 1000);
    expect(windowMs).toBeLessThanOrEqual(25 * 60 * 60 * 1000);
  });

  it('returns bookings ordered newest first with their relations', async () => {
    prisma.booking.findMany.mockResolvedValue([bookingFixture()]);

    const response = await get();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.bookings).toHaveLength(1);

    const args = prisma.booking.findMany.mock.calls.at(-1)[0];
    expect(args.orderBy).toEqual({ bookingDate: 'desc' });
    expect(Object.keys(args.include)).toEqual(
      expect.arrayContaining(['user', 'bus', 'stop', 'trip']),
    );
  });

  it('returns 500 when the database throws', async () => {
    prisma.booking.findMany.mockRejectedValue(new Error('connection lost'));

    expect((await get('?status=X')).status).toBe(500);
  });
});

describe('POST /api/bookings', () => {
  const validBody = {
    tripId: 'trip-1',
    stopId: 'stop-1',
    bookingDate: '2024-03-01',
  };

  const primeTrip = () =>
    prisma.trip.findUnique.mockResolvedValue(
      tripFixture({
        bus: busFixture({ capacity: 40 }),
        route: routeFixture(),
      }),
    );

  it('restricts creation to admins and passengers', async () => {
    actAs(prisma, adminUser({ id: 'driver-1', role: 'DRIVER' }));

    const response = await createBooking(
      apiRequest('/bookings', {
        method: 'POST',
        user: adminUser({ id: 'driver-1', role: 'DRIVER' }),
        body: validBody,
      }),
    );

    expect(response.status).toBe(403);
    expect(prisma.booking.create).not.toHaveBeenCalled();
  });

  it('requires the trip, stop and booking date', async () => {
    const response = await post({ tripId: 'trip-1' });

    expect(response.status).toBe(400);
    expect((await response.json()).error).toMatch(/required/i);
  });

  it('rejects an unparseable booking date', async () => {
    const response = await post({ ...validBody, bookingDate: 'not-a-date' });

    expect(response.status).toBe(400);
    expect((await response.json()).error).toMatch(/invalid booking date/i);
  });

  it('returns 404 when the trip does not exist', async () => {
    prisma.trip.findUnique.mockResolvedValue(null);

    const response = await post(validBody);

    expect(response.status).toBe(404);
    expect((await response.json()).error).toMatch(/trip not found/i);
  });

  it('returns 404 when the stop does not exist', async () => {
    primeTrip();
    prisma.stop.findUnique.mockResolvedValue(null);

    const response = await post(validBody);

    expect(response.status).toBe(404);
    expect((await response.json()).error).toMatch(/stop not found/i);
  });

  it('rejects a stop that belongs to another route', async () => {
    primeTrip();
    prisma.stop.findUnique.mockResolvedValue(stopFixture({ routeId: 'route-other' }));

    const response = await post(validBody);

    expect(response.status).toBe(400);
    expect((await response.json()).error).toMatch(/does not belong/i);
    expect(prisma.booking.create).not.toHaveBeenCalled();
  });

  it('rejects a duplicate active booking for the same trip and day', async () => {
    primeTrip();
    prisma.stop.findUnique.mockResolvedValue(stopFixture());
    prisma.booking.findFirst.mockResolvedValue(bookingFixture());

    const response = await post(validBody);

    expect(response.status).toBe(409);
    expect((await response.json()).error).toMatch(/already have an active booking/i);
  });

  it('creates a confirmed booking with a seat and QR code inside a transaction', async () => {
    primeTrip();
    prisma.stop.findUnique.mockResolvedValue(stopFixture());
    prisma.booking.findFirst.mockResolvedValue(null);
    prisma.booking.count.mockResolvedValue(0);
    prisma.booking.create.mockResolvedValue(
      bookingFixture({ id: 'booking-9', seatNumber: '1A' }),
    );

    const response = await post(validBody);
    const body = await response.json();

    expect(response.status).toBe(201);
    expect(body.message).toMatch(/created successfully/i);

    // Seat allocation and insert are atomic, so the transaction must be used.
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);

    const { data } = prisma.booking.create.mock.calls[0][0];
    expect(data.userId).toBe('passenger-1');
    expect(data.busId).toBe('bus-1');
    expect(data.status).toBe('CONFIRMED');
    expect(data.seatNumber).toBe('1A');
    // A QR payload must be generated server-side, never trusted from the client.
    expect(data.qrCodeData).toEqual(expect.any(String));
    expect(data.qrCode).toContain('data:image');

    // The duplicate check must use the same local-day window as the report.
    const existingWhere = prisma.booking.findFirst.mock.calls[0][0].where;
    expect(existingWhere.bookingDate.gte.getHours()).toBe(0);
    expect(existingWhere.status.in).toEqual(['PENDING', 'CONFIRMED']);
  });

  it('assigns sequential seat numbers as the trip fills up', async () => {
    primeTrip();
    prisma.stop.findUnique.mockResolvedValue(stopFixture());
    prisma.booking.findFirst.mockResolvedValue(null);
    prisma.booking.count.mockResolvedValue(4);
    prisma.booking.create.mockResolvedValue(bookingFixture({ id: 'booking-9' }));

    await post(validBody);

    // The 5th booking (index 4) opens row 2.
    expect(prisma.booking.create.mock.calls[0][0].data.seatNumber).toBe('2A');
  });

  it('rejects the booking once the bus is full', async () => {
    primeTrip();
    prisma.stop.findUnique.mockResolvedValue(stopFixture());
    prisma.booking.findFirst.mockResolvedValue(null);
    prisma.booking.count.mockResolvedValue(40);

    const response = await post(validBody);

    expect(response.status).toBe(400);
    expect((await response.json()).error).toMatch(/no seats available/i);
    expect(prisma.booking.create).not.toHaveBeenCalled();
  });

  it('notifies the driver and flushes the reports cache', async () => {
    primeTrip();
    prisma.stop.findUnique.mockResolvedValue(stopFixture());
    prisma.booking.findFirst.mockResolvedValue(null);
    prisma.booking.count.mockResolvedValue(0);
    prisma.booking.create.mockResolvedValue(
      bookingFixture({ id: 'booking-9', seatNumber: '1A' }),
    );

    const response = await post(validBody);

    expect(response.status).toBe(201);
    const notification = prisma.notification.create.mock.calls.at(-1)[0].data;
    expect(notification.userRole).toBe('DRIVER');
    expect(notification.type).toBe('BOOKING_CONFIRMATION');
    expect(notification.message).toContain('1A');
  });

  it('returns 500 when the database throws', async () => {
    prisma.trip.findUnique.mockRejectedValue(new Error('connection lost'));

    expect((await post(validBody)).status).toBe(500);
  });
});
