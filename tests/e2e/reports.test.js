import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  actAs,
  adminUser,
  apiRequest,
  driverUser,
} from '../helpers/routeHarness';

vi.mock('@/lib/prisma', async () => {
  const { createPrismaMock } = await import('../helpers/prismaMock');
  return { default: createPrismaMock() };
});

delete process.env.REDIS_URL;

let prisma;
let getReports;

beforeAll(async () => {
  prisma = (await import('@/lib/prisma')).default;
  ({ GET: getReports } = await import('@/app/api/reports/route'));
});

const admin = adminUser();
const driver = driverUser();

const get = (query = '', user = admin) =>
  getReports(apiRequest(`/reports${query}`, { user }));

beforeEach(() => {
  vi.clearAllMocks();
  actAs(prisma, admin);
});

describe('GET /api/reports — access control', () => {
  it('requires authentication', async () => {
    const response = await getReports(apiRequest('/reports'));

    expect(response.status).toBe(401);
  });

  it('restricts every report to admins', async () => {
    actAs(prisma, driver);

    const response = await get('?type=bus-usage', driver);

    expect(response.status).toBe(403);
    expect(prisma.bus.findMany).not.toHaveBeenCalled();
  });
});

describe('GET /api/reports — overview (default)', () => {
  it('returns the platform totals when no type is given', async () => {
    prisma.user.count.mockResolvedValue(10);
    prisma.bus.count.mockResolvedValue(6);
    prisma.route.count.mockResolvedValue(4);
    prisma.trip.count.mockResolvedValue(8);

    const response = await get();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.overview).toEqual({
      totalUsers: 10,
      totalBuses: 6,
      totalRoutes: 4,
      totalTrips: 8,
      activeBuses: 6,
    });
  });

  it('counts only ACTIVE buses for activeBuses', async () => {
    prisma.user.count.mockResolvedValue(0);
    prisma.bus.count.mockResolvedValue(6);
    prisma.route.count.mockResolvedValue(0);
    prisma.trip.count.mockResolvedValue(0);

    await get();

    const activeQuery = prisma.bus.count.mock.calls.find(
      ([args]) => args?.where?.status === 'ACTIVE',
    );
    expect(activeQuery).toBeDefined();
  });

  it('returns 500 when the database throws', async () => {
    prisma.user.count.mockRejectedValue(new Error('connection lost'));

    expect((await get()).status).toBe(500);
  });
});

describe('GET /api/reports?type=bus-usage', () => {
  it('reports trips and bookings per bus', async () => {
    prisma.bus.findMany.mockResolvedValue([
      {
        id: 'bus-1',
        busNumber: 'B1',
        plateNumber: 'PL-1',
        capacity: 40,
        status: 'ACTIVE',
        _count: { trips: 5, bookings: 9 },
      },
    ]);

    const body = await (await get('?type=bus-usage')).json();

    expect(body.buses[0]).toEqual({
      id: 'bus-1',
      busNumber: 'B1',
      plateNumber: 'PL-1',
      capacity: 40,
      status: 'ACTIVE',
      totalTrips: 5,
      totalBookings: 9,
    });
  });

  it('applies a date range to both counts when supplied', async () => {
    prisma.bus.findMany.mockResolvedValue([]);

    await get('?type=bus-usage&startDate=2024-01-01&endDate=2024-02-01');

    const { include } = prisma.bus.findMany.mock.calls.at(-1)[0];
    expect(include._count.select.trips.where.startTime.gte).toBeInstanceOf(Date);
    expect(include._count.select.bookings.where.bookingDate.lte).toBeInstanceOf(Date);
  });
});

describe('GET /api/reports?type=fuel-consumption', () => {
  it('estimates consumption from mileage and sums maintenance cost', async () => {
    prisma.bus.findMany.mockResolvedValue([
      {
        id: 'bus-1',
        busNumber: 'B1',
        plateNumber: 'PL-1',
        fuelType: 'DIESEL',
        mileage: 350,
        lastMaintenance: new Date('2024-01-15T00:00:00Z'),
        updatedAt: new Date('2024-01-01T00:00:00Z'),
        maintenance: [{ cost: 100 }, { cost: 50 }],
      },
    ]);

    const body = await (await get('?type=fuel-consumption')).json();

    // 350 km at 3.5 km/L (DIESEL) == 100 units.
    expect(body.records[0].amount).toBe(100);
    expect(body.records[0].cost).toBe(150);
    expect(body.summary.totalLiters).toBe(100);
    expect(body.summary.totalCost).toBe(150);
    expect(body.summary.averagePricePerLiter).toBe(1.5);
  });

  it('guards the average against a zero denominator', async () => {
    prisma.bus.findMany.mockResolvedValue([
      {
        id: 'bus-1',
        busNumber: 'B1',
        plateNumber: 'PL-1',
        fuelType: 'DIESEL',
        mileage: 0,
        lastMaintenance: null,
        updatedAt: new Date('2024-01-01T00:00:00Z'),
        maintenance: [],
      },
    ]);

    const body = await (await get('?type=fuel-consumption')).json();

    // 0/0 would render as "NaN" in the UI.
    expect(body.summary.averagePricePerLiter).toBe(0);
  });

  it('falls back to the default efficiency for an unknown fuel type', async () => {
    prisma.bus.findMany.mockResolvedValue([
      {
        id: 'bus-1',
        busNumber: 'B1',
        plateNumber: 'PL-1',
        fuelType: 'HYDROGEN',
        mileage: 350,
        lastMaintenance: null,
        updatedAt: new Date('2024-01-01T00:00:00Z'),
        maintenance: [],
      },
    ]);

    const body = await (await get('?type=fuel-consumption')).json();

    // Default is 3.5 km/unit.
    expect(body.records[0].amount).toBe(100);
  });
});

describe('GET /api/reports?type=driver-performance', () => {
  it('reports a trip count and availability per driver', async () => {
    prisma.user.findMany.mockResolvedValue([
      {
        id: 'driver-1',
        name: 'Driver One',
        email: 'driver@campus.edu',
        phone: '+1000',
        isActive: true,
      },
    ]);
    prisma.trip.count.mockResolvedValue(7);

    const body = await (await get('?type=driver-performance')).json();

    expect(body.drivers[0]).toEqual({
      id: 'driver-1',
      name: 'Driver One',
      email: 'driver@campus.edu',
      phone: '+1000',
      totalTrips: 7,
      isAvailable: true,
    });

    // Only DRIVER-role accounts are considered.
    expect(prisma.user.findMany.mock.calls.at(-1)[0].where).toEqual({
      role: 'DRIVER',
    });
  });

  it('scopes the count to a single driver when requested', async () => {
    prisma.user.findMany.mockResolvedValue([]);
    prisma.trip.count.mockResolvedValue(0);

    await get('?type=driver-performance&driverId=driver-9');

    expect(prisma.user.findMany.mock.calls.at(-1)[0].where).toEqual({
      role: 'DRIVER',
      id: 'driver-9',
    });
  });
});

describe('GET /api/reports — caching', () => {
  it('caches each report type under its own key', async () => {
    prisma.user.count.mockResolvedValue(0);
    prisma.bus.count.mockResolvedValue(0);
    prisma.route.count.mockResolvedValue(0);
    prisma.trip.count.mockResolvedValue(0);

    const first = await get('?type=overview');
    expect(first.headers.get('X-Cache')).toBe('MISS');

    const second = await get('?type=overview');
    expect(second.headers.get('X-Cache')).toBe('HIT');
    expect(prisma.user.count).toHaveBeenCalledTimes(1);

    // A different report type must not reuse the cached payload.
    prisma.bus.findMany.mockResolvedValue([]);
    const other = await get('?type=bus-usage');
    expect(other.headers.get('X-Cache')).toBe('MISS');
  });
});
