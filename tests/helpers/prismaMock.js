import { vi } from 'vitest';

/**
 * Prisma double used by the end-to-end route tests.
 *
 * Usage inside a test file (the async factory is what makes this safe):
 *
 *     vi.mock('@/lib/prisma', async () => {
 *       const { createPrismaMock } = await import('../helpers/prismaMock');
 *       return { default: createPrismaMock() };
 *     });
 *
 *     let prisma;
 *     beforeAll(async () => {
 *       prisma = (await import('@/lib/prisma')).default;
 *     });
 *
 * Why the async factory matters: `vi.mock` calls are hoisted above the file's
 * imports, so a factory that referenced a module-scope `const` would hit a
 * temporal-dead-zone error ("Cannot access 'prisma' before initialization").
 * Importing the helper *inside* the factory sidesteps hoisting entirely, and
 * keeps the mock definition in one place instead of duplicated per test file.
 *
 * Nothing about routing, auth, caching, limiting or queueing is stubbed — only
 * the database. That keeps these tests fast and dependency-free while still
 * exercising the whole request path over real `Request`/`NextResponse` objects.
 */

/**
 * Default return value per Prisma delegate method.
 *
 * These mirror real Prisma's *shapes* rather than returning `null` for
 * everything. That matters: a `findMany` returning `null` makes the
 * application's `.filter()` / `.length` calls throw, and a `count` returning
 * `null` turns arithmetic into `NaN`. Matching the real types means a test only
 * has to configure the calls it actually asserts on.
 */
const METHOD_DEFAULTS = {
  findMany: () => [],
  findFirst: () => null,
  findFirstOrThrow: () => null,
  findUnique: () => null,
  findUniqueOrThrow: () => null,
  count: () => 0,
  aggregate: () => ({}),
  groupBy: () => [],
  create: () => null,
  createMany: () => ({ count: 0 }),
  update: () => null,
  updateMany: () => ({ count: 0 }),
  upsert: () => null,
  delete: () => null,
  deleteMany: () => ({ count: 0 }),
};

/**
 * Every delegate method Prisma exposes.
 *
 * Giving each model the COMPLETE surface (rather than hand-listing a subset) is
 * deliberate. A hand-written list previously omitted `busPass.findFirst`, so a
 * test failed with `Cannot read properties of undefined` instead of exercising
 * the code under test — the double, not the application, was wrong.
 */
const MODEL_METHODS = Object.keys(METHOD_DEFAULTS);

const buildModel = () => {
  const delegate = {};

  for (const name of MODEL_METHODS) {
    delegate[name] = vi.fn(async () => METHOD_DEFAULTS[name]());
  }

  return delegate;
};

/**
 * Builds a Prisma-shaped object covering every model in the schema, each with
 * the full delegate surface. A test configures only the calls it cares about.
 */
export const createPrismaMock = (overrides = {}) => {
  const prisma = {
    // Every model from prisma/schema.prisma, each with the full delegate surface.
    user: buildModel(),
    bus: buildModel(),
    route: buildModel(),
    stop: buildModel(),
    schedule: buildModel(),
    trip: buildModel(),
    booking: buildModel(),
    busPass: buildModel(),
    maintenance: buildModel(),
    notification: buildModel(),
    feedback: buildModel(),
    activityLog: buildModel(),
    // Supports both the callback form and the array form used across the app.
    $transaction: vi.fn(async (arg) =>
      typeof arg === 'function' ? arg(prisma) : Promise.all(arg),
    ),
    $connect: vi.fn(async () => {}),
    $disconnect: vi.fn(async () => {}),
    ...overrides,
  };

  return prisma;
};

/** A valid-looking user row. Pass `password` for login flows. */
export const buildUser = (overrides = {}) => ({
  id: 'user-1',
  email: 'admin@campus.edu',
  name: 'Admin User',
  phone: '+10000000000',
  role: 'ADMIN',
  passengerId: null,
  licenseNumber: null,
  isActive: true,
  createdAt: new Date('2024-01-01T00:00:00Z'),
  updatedAt: new Date('2024-01-01T00:00:00Z'),
  ...overrides,
});

/**
 * Shape the auth middleware expects from `prisma.user.findUnique`. It selects
 * only these fields, so returning the full row would not match reality.
 */
export const buildAuthUser = (user) => ({
  id: user.id,
  email: user.email,
  name: user.name,
  role: user.role,
  isActive: user.isActive ?? true,
});
