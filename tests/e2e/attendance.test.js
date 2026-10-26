import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildAuthUser, buildUser } from '../helpers/prismaMock';

vi.mock('@/lib/prisma', async () => {
  const { createPrismaMock } = await import('../helpers/prismaMock');
  return { default: createPrismaMock() };
});

// No Redis -> in-memory cache, so invalidation is observable within one process.
delete process.env.REDIS_URL;

let prisma;
let generateToken;
let getReports;
let verifyPass;

beforeAll(async () => {
  prisma = (await import('@/lib/prisma')).default;
  ({ generateToken } = await import('@/utils/jwt'));
  ({ GET: getReports } = await import('@/app/api/reports/route'));
  ({ PUT: verifyPass } = await import('@/app/api/buspass/route'));
});

const admin = buildUser({ id: 'admin-1', role: 'ADMIN' });
const driver = buildUser({
  id: 'driver-1',
  role: 'DRIVER',
  email: 'driver@campus.edu',
});

const authedRequest = (url, { method = 'GET', user, body } = {}) =>
  new Request(url, {
    method,
    headers: {
      authorization: `Bearer ${generateToken({
        userId: user.id,
        email: user.email,
        role: user.role,
      })}`,
      'content-type': 'application/json',
      'x-forwarded-for': '203.0.113.90',
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });

const fetchDailySummary = () =>
  getReports(
    authedRequest('http://localhost/api/reports?type=daily-summary', {
      user: admin,
    }),
  );

beforeEach(() => {
  vi.clearAllMocks();
  prisma.user.findUnique.mockImplementation(async ({ where }) =>
    where.id === driver.id ? buildAuthUser(driver) : buildAuthUser(admin),
  );
  prisma.trip.findMany.mockResolvedValue([]);
  prisma.booking.findMany.mockResolvedValue([]);
  prisma.activityLog.create.mockResolvedValue({ id: 'log-1' });
});

describe('GET /api/reports?type=daily-summary — attendance', () => {
  it('reports 0 total and a 0 (not NaN) rate when there are no bookings', async () => {
    const response = await fetchDailySummary();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.stats.total).toBe(0);
    expect(body.stats.present).toBe(0);
    expect(body.stats.absent).toBe(0);
    // Must be a real 0, because 0/0 would render as "NaN%" in the UI.
    expect(body.stats.attendanceRate).toBe(0);
  });

  it('counts a booking with isUsed=true as present', async () => {
    prisma.booking.findMany.mockResolvedValue([
      { id: 'b1', isUsed: true },
      { id: 'b2', isUsed: false },
    ]);

    const body = await (await fetchDailySummary()).json();

    expect(body.stats.total).toBe(2);
    expect(body.stats.present).toBe(1);
    expect(body.stats.absent).toBe(1);
    expect(body.stats.attendanceRate).toBe(50);
  });

  it('queries bookings by bookingDate for today, matching the write path', async () => {
    await fetchDailySummary();

    const where = prisma.booking.findMany.mock.calls.at(-1)[0].where;

    // The regression this pins: filtering by `tripId IN today's trips` dropped
    // every booking with a null tripId (optional in the schema), so attendance
    // that HAD been recorded was reported as absent.
    expect(where).not.toHaveProperty('tripId');
    expect(where).toHaveProperty('bookingDate');
    expect(where.bookingDate.gte).toBeInstanceOf(Date);
    expect(where.bookingDate.lte).toBeInstanceOf(Date);
    expect(where.status).toEqual({ in: ['CONFIRMED', 'COMPLETED'] });
  });

  it('uses a local-day window covering exactly one day', async () => {
    await fetchDailySummary();

    const { gte, lte } = prisma.booking.findMany.mock.calls.at(-1)[0].where
      .bookingDate;

    expect(gte.getHours()).toBe(0);
    expect(gte.getMinutes()).toBe(0);
    expect(lte.getHours()).toBe(23);
    expect(lte.getMinutes()).toBe(59);
    expect(lte.getTime() - gte.getTime()).toBeLessThan(24 * 60 * 60 * 1000);
  });

  it('labels the report with the LOCAL date, not the UTC one', async () => {
    const body = await (await fetchDailySummary()).json();

    const now = new Date();
    const expected = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(
      2,
      '0',
    )}-${String(now.getDate()).padStart(2, '0')}`;

    expect(body.date).toBe(expected);
  });
});

describe('attendance write path is visible to the read path', () => {
  const verifiedPass = (passNumber, passengerId) => ({
    id: `pass-${passengerId}`,
    passNumber,
    passengerId,
    endDate: new Date(Date.now() + 86_400_000),
    passenger: { name: 'Passenger', passengerId: 'P-1' },
  });

  it('flushes the reports cache when a pass is verified', async () => {
    // Prime the cache with a report showing zero attendance.
    const first = await fetchDailySummary();
    expect(first.headers.get('X-Cache')).toBe('MISS');

    // A driver verifies a pass, which marks today's booking attended.
    prisma.busPass.findFirst.mockResolvedValue(
      verifiedPass('BP-1', 'passenger-1'),
    );
    prisma.booking.updateMany.mockResolvedValue({ count: 1 });

    const verifyResponse = await verifyPass(
      authedRequest('http://localhost/api/buspass', {
        method: 'PUT',
        user: driver,
        body: { passNumber: 'BP-1' },
      }),
    );

    expect(verifyResponse.status).toBe(200);
    expect((await verifyResponse.json()).attendance.marked).toBe(1);

    // The next report must NOT be served from the stale cached entry — this is
    // what made the Attendance Summary appear stuck at 0% for up to the 60s TTL.
    const second = await fetchDailySummary();
    expect(second.headers.get('X-Cache')).toBe('MISS');
  });

  it('marks attendance using the same day window the report reads with', async () => {
    prisma.busPass.findFirst.mockResolvedValue(
      verifiedPass('BP-2', 'passenger-2'),
    );
    prisma.booking.updateMany.mockResolvedValue({ count: 0 });

    await verifyPass(
      authedRequest('http://localhost/api/buspass', {
        method: 'PUT',
        user: driver,
        body: { passNumber: 'BP-2' },
      }),
    );

    // Trigger a report read so its window can be compared.
    await fetchDailySummary();

    const writeWhere = prisma.booking.updateMany.mock.calls.at(-1)[0].where;
    const readWhere = prisma.booking.findMany.mock.calls.at(-1)[0].where;

    // The write uses an EXCLUSIVE upper bound so the final millisecond of the
    // day is never excluded; the read uses an inclusive range over the same day.
    expect(writeWhere.bookingDate.gte.getHours()).toBe(0);
    expect(writeWhere.bookingDate.lt.getHours()).toBe(0);
    expect(writeWhere.isUsed).toBe(false);
    expect(writeWhere.userId).toBe('passenger-2');

    // Both windows must start at the same local midnight, or recorded attendance
    // would fall outside the report's range.
    expect(writeWhere.bookingDate.gte.getTime()).toBe(
      readWhere.bookingDate.gte.getTime(),
    );
  });
});
