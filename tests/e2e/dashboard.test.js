import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  actAs,
  adminUser,
  apiRequest,
  driverUser,
  primeSideEffects,
} from '../helpers/routeHarness';

vi.mock('@/lib/prisma', async () => {
  const { createPrismaMock } = await import('../helpers/prismaMock');
  return { default: createPrismaMock() };
});

delete process.env.REDIS_URL;

let prisma;
let getDashboard;
let emergencyBroadcast;

beforeAll(async () => {
  prisma = (await import('@/lib/prisma')).default;
  ({ GET: getDashboard, POST: emergencyBroadcast } = await import(
    '@/app/api/dashboard/route'
  ));
});

const admin = adminUser();
const driver = driverUser();

const get = (user = admin) => getDashboard(apiRequest('/dashboard', { user }));
const post = (body, user = admin) =>
  emergencyBroadcast(apiRequest('/dashboard', { method: 'POST', user, body }));

/** Every aggregate the dashboard reads, all zeroed out. */
const primeEmptyAggregates = () => {
  prisma.user.count.mockResolvedValue(0);
  prisma.bus.count.mockResolvedValue(0);
  prisma.route.count.mockResolvedValue(0);
  prisma.schedule.count.mockResolvedValue(0);
  prisma.trip.count.mockResolvedValue(0);
  prisma.booking.count.mockResolvedValue(0);
  prisma.notification.count.mockResolvedValue(0);
  prisma.trip.findMany.mockResolvedValue([]);
  prisma.schedule.findMany.mockResolvedValue([]);
  prisma.maintenance.findMany.mockResolvedValue([]);
};

beforeEach(() => {
  vi.clearAllMocks();
  actAs(prisma, admin);
  primeSideEffects(prisma);
});

describe('GET /api/dashboard', () => {
  it('requires authentication', async () => {
    const response = await getDashboard(apiRequest('/dashboard'));

    expect(response.status).toBe(401);
  });

  it('restricts the dashboard to admins', async () => {
    actAs(prisma, driver);

    expect((await get(driver)).status).toBe(403);
  });

  it('aggregates the counters, recent trips, schedules and alerts', async () => {
    primeEmptyAggregates();
    prisma.user.count.mockResolvedValue(12);
    prisma.bus.count.mockResolvedValue(5);
    prisma.booking.count.mockResolvedValue(4);
    prisma.notification.count.mockResolvedValue(2);
    prisma.trip.findMany.mockResolvedValue([{ id: 'trip-1' }]);
    prisma.schedule.findMany.mockResolvedValue([{ id: 'schedule-1' }]);
    prisma.maintenance.findMany.mockResolvedValue([{ id: 'maintenance-1' }]);

    const response = await get();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.stats.totalUsers).toBe(12);
    expect(body.stats.totalBuses).toBe(5);
    expect(body.stats.pendingBookings).toBe(4);
    expect(body.stats.unreadNotifications).toBe(2);
    expect(body.recentTrips).toHaveLength(1);
    expect(body.upcomingSchedules).toHaveLength(1);
    expect(body.maintenanceAlerts).toHaveLength(1);

    // The dashboard is a bounded summary, never a full table dump.
    expect(prisma.trip.findMany.mock.calls.at(-1)[0].take).toBe(5);
    expect(prisma.schedule.findMany.mock.calls.at(-1)[0].take).toBe(5);
    expect(prisma.maintenance.findMany.mock.calls.at(-1)[0].take).toBe(5);
  });

  it('scopes the available-driver count to active drivers', async () => {
    primeEmptyAggregates();

    await get();

    const driverCount = prisma.user.count.mock.calls.find(
      ([args]) => args?.where?.role === 'DRIVER',
    );
    expect(driverCount[0].where).toEqual({ role: 'DRIVER', isActive: true });
  });

  it('caches the dashboard across requests', async () => {
    primeEmptyAggregates();

    const first = await get();
    expect(first.headers.get('X-Cache')).toBe('MISS');

    // NOTE: `user.count` runs twice per uncached render — once for the total and
    // once for the available-driver count — so the hit is compared against the
    // miss's call count rather than a hard-coded number.
    const callsAfterMiss = prisma.user.count.mock.calls.length;
    expect(callsAfterMiss).toBeGreaterThan(0);

    const second = await get();
    expect(second.headers.get('X-Cache')).toBe('HIT');

    // A cache hit must not re-run a single aggregate query.
    expect(prisma.user.count.mock.calls.length).toBe(callsAfterMiss);
    expect(prisma.trip.findMany).toHaveBeenCalledTimes(1);
  });
});

describe('POST /api/dashboard — emergency broadcast', () => {
  it('restricts broadcasts to admins', async () => {
    actAs(prisma, driver);

    const response = await post({ message: 'Evacuate' }, driver);

    expect(response.status).toBe(403);
    expect(prisma.notification.create).not.toHaveBeenCalled();
  });

  it('requires a message', async () => {
    const response = await post({});

    expect(response.status).toBe(400);
    expect((await response.json()).error).toMatch(/message is required/i);
  });

  it('fans the alert out to every role and records an audit entry', async () => {
    const response = await post({ message: 'Campus closed' });
    const body = await response.json();

    expect(response.status).toBe(201);
    expect(body.message).toMatch(/broadcast sent successfully/i);

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(prisma.notification.create).toHaveBeenCalledTimes(3);

    const roles = prisma.notification.create.mock.calls.map(
      ([args]) => args.data.userRole,
    );
    expect(roles.sort()).toEqual(['ADMIN', 'DRIVER', 'PASSENGER']);

    const log = prisma.activityLog.create.mock.calls.at(-1)[0].data;
    expect(log.action).toBe('EMERGENCY_BROADCAST');
    expect(log.userId).toBe(admin.id);
  });

  it('caps broadcasts far more tightly than ordinary writes', async () => {
    const ip = '203.0.113.77';

    // The BROADCAST policy allows 5 per window; the 6th must be refused.
    for (let i = 0; i < 5; i += 1) {
      const response = await emergencyBroadcast(
        apiRequest('/dashboard', {
          method: 'POST',
          user: admin,
          body: { message: `Alert ${i}` },
          ip,
        }),
      );
      expect(response.status).toBe(201);
    }

    const blocked = await emergencyBroadcast(
      apiRequest('/dashboard', {
        method: 'POST',
        user: admin,
        body: { message: 'Alert 6' },
        ip,
      }),
    );

    expect(blocked.status).toBe(429);
    expect((await blocked.json()).code).toBe('RATE_LIMITED');
  });

  it('does not fail the request when the notification fan-out fails', async () => {
    // `enqueueEmergencyBroadcast` is a best-effort side effect: the facade
    // swallows delivery errors and falls back to inline execution (see
    // src/lib/enqueue.js), so a database outage must NOT turn the broadcast
    // into a 5xx. The alert is queued/attempted and the caller still succeeds.
    prisma.$transaction.mockRejectedValue(new Error('connection lost'));

    const response = await post({ message: 'Evacuate now' });

    expect(response.status).toBe(201);
    expect((await response.json()).message).toMatch(/broadcast sent successfully/i);
  });
});

