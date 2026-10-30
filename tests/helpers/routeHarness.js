import { generateToken } from '@/utils/jwt';

import { buildAuthUser, buildUser } from './prismaMock';

/**
 * Shared scaffolding for the route-handler (end-to-end) suites.
 *
 * These suites import a `route.js` handler directly and drive it with real
 * `Request`/`NextResponse` objects. Only the database is doubled (see
 * prismaMock.js) — auth, rate limiting, caching and the queue facade all run for
 * real. That is what makes them "end-to-end" rather than unit tests: the whole
 * five-step request contract (authMiddleware -> enforceRateLimit -> withCache ->
 * Prisma -> side effects) is exercised.
 *
 * Everything here is deliberately free of `vi.mock`: a mock factory is hoisted
 * above a file's imports, so it must live in each test file (and import this
 * module *inside* the factory). These helpers are plain functions, so they can
 * be imported normally.
 */

export const API_BASE = 'http://localhost/api';

/** Signs the same payload the login/register routes issue. */
export const signToken = (user) =>
  generateToken({ userId: user.id, email: user.email, role: user.role });

/**
 * Builds a `Request` for a route handler.
 *
 * `x-forwarded-for` is always set so the rate limiter has a deterministic
 * identity, and the bearer token is only attached when a user is supplied (so a
 * test can assert the unauthenticated path without passing `user`).
 */
export const apiRequest = (
  path,
  { method = 'GET', user, body, headers = {}, ip = '203.0.113.10' } = {},
) => {
  const finalHeaders = {
    'content-type': 'application/json',
    'x-forwarded-for': ip,
    ...headers,
  };

  if (user) finalHeaders.authorization = `Bearer ${signToken(user)}`;

  return new Request(`${API_BASE}${path}`, {
    method,
    headers: finalHeaders,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
};

/**
 * The second argument Next.js passes to a dynamic route handler.
 *
 * Note handlers in this app destructure it eagerly (`const { id } = params`), so
 * it must always be an object — passing `undefined` throws before any guard runs.
 */
export const params = (id) => ({ params: { id } });

/** Makes the auth middleware resolve `user` on the next request. */
export const actAs = (prisma, user) =>
  prisma.user.findUnique.mockResolvedValue(buildAuthUser(user));

/**
 * Installs a discriminating `prisma.user.findUnique` double.
 *
 * Needed whenever the auth middleware *and* the handler both call
 * `user.findUnique` — the middleware looks the actor up by `id`, while a handler
 * may look a target up by `id` (e.g. `/api/users/[id]`) or by `email` (e.g. the
 * duplicate check in `POST /api/users`). A single `mockResolvedValue` cannot
 * serve both, so lookups are keyed by whichever field was used.
 *
 * @param {object} prisma  the Prisma double
 * @param {Record<string, object|null>} lookups  keyed by user id OR email
 */
export const mockUserLookups = (prisma, lookups) =>
  prisma.user.findUnique.mockImplementation(async ({ where = {} } = {}) => {
    const key = where.id ?? where.email;
    if (key === undefined) return null;
    return lookups[key] ?? null;
  });

/**
 * Resolves the two inline side effects every write route triggers, so tests can
 * assert on them without a null-safe `entry.id` blowing up inside the job
 * handler. With no Redis the handlers run in-process (see src/lib/queue.js).
 */
export const primeSideEffects = (prisma) => {
  prisma.activityLog.create.mockResolvedValue({ id: 'log-1' });
  prisma.notification.create.mockImplementation(async ({ data }) => ({
    id: 'notification-1',
    ...data,
  }));
};

// ---------------------------------------------------------------------------
// User fixtures
// ---------------------------------------------------------------------------

export const adminUser = (overrides = {}) =>
  buildUser({
    id: 'admin-1',
    role: 'ADMIN',
    email: 'admin@campus.edu',
    ...overrides,
  });

export const driverUser = (overrides = {}) =>
  buildUser({
    id: 'driver-1',
    role: 'DRIVER',
    email: 'driver@campus.edu',
    licenseNumber: 'LIC-1',
    ...overrides,
  });

export const passengerUser = (overrides = {}) =>
  buildUser({
    id: 'passenger-1',
    role: 'PASSENGER',
    email: 'passenger@campus.edu',
    passengerId: 'P-1',
    ...overrides,
  });

// ---------------------------------------------------------------------------
// Entity fixtures
// ---------------------------------------------------------------------------

export const busFixture = (overrides = {}) => ({
  id: 'bus-1',
  busNumber: 'B1',
  plateNumber: 'PL-1',
  capacity: 40,
  model: 'Volvo 7900',
  year: 2020,
  status: 'ACTIVE',
  fuelType: 'DIESEL',
  mileage: 1000,
  lastMaintenance: null,
  ...overrides,
});

export const routeFixture = (overrides = {}) => ({
  id: 'route-1',
  name: 'Campus Loop',
  description: 'Main campus circuit',
  isActive: true,
  estimatedDuration: 30,
  distance: 12.5,
  ...overrides,
});

export const stopFixture = (overrides = {}) => ({
  id: 'stop-1',
  name: 'Main Gate',
  latitude: 23.81,
  longitude: 90.41,
  address: 'Gate 1',
  order: 1,
  isActive: true,
  routeId: 'route-1',
  ...overrides,
});

export const scheduleFixture = (overrides = {}) => ({
  id: 'schedule-1',
  routeId: 'route-1',
  busId: 'bus-1',
  scheduleType: 'MORNING',
  departureTime: new Date('2024-01-01T07:00:00Z'),
  arrivalTime: new Date('2024-01-01T08:00:00Z'),
  daysOfWeek: ['MON'],
  isActive: true,
  isSpecial: false,
  specialDate: null,
  notes: null,
  ...overrides,
});

export const tripFixture = (overrides = {}) => ({
  id: 'trip-1',
  scheduleId: 'schedule-1',
  routeId: 'route-1',
  busId: 'bus-1',
  driverId: 'driver-1',
  startTime: new Date('2024-01-01T07:00:00Z'),
  endTime: new Date('2024-01-01T08:00:00Z'),
  status: 'SCHEDULED',
  actualStartTime: null,
  actualEndTime: null,
  ...overrides,
});

export const bookingFixture = (overrides = {}) => ({
  id: 'booking-1',
  userId: 'passenger-1',
  busId: 'bus-1',
  stopId: 'stop-1',
  tripId: 'trip-1',
  bookingDate: new Date('2024-01-01T00:00:00Z'),
  status: 'CONFIRMED',
  seatNumber: '1A',
  qrCode: 'qr-data',
  qrCodeData: 'uuid',
  isUsed: false,
  ...overrides,
});

export const maintenanceFixture = (overrides = {}) => ({
  id: 'maintenance-1',
  busId: 'bus-1',
  type: 'ROUTINE',
  status: 'SCHEDULED',
  description: 'Oil change',
  scheduledDate: new Date('2024-02-01T00:00:00Z'),
  completedDate: null,
  cost: null,
  notes: null,
  ...overrides,
});

export const busPassFixture = (overrides = {}) => ({
  id: 'pass-1',
  passengerId: 'passenger-1',
  passNumber: 'BP-1',
  startDate: new Date('2024-01-01T00:00:00Z'),
  endDate: new Date(Date.now() + 86_400_000),
  isActive: true,
  qrCode: 'qr-data',
  ...overrides,
});
