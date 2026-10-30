import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  adminUser,
  apiRequest,
  mockUserLookups,
  params,
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
let getUser;
let updateUser;
let deleteUser;

beforeAll(async () => {
  prisma = (await import('@/lib/prisma')).default;
  ({ GET: getUser, PUT: updateUser, DELETE: deleteUser } = await import(
    '@/app/api/users/[id]/route'
  ));
});

const admin = adminUser();
const passenger = passengerUser();

/** The actor (by id) and the target profile the handler reads. */
const actingAs = (actor, target) =>
  mockUserLookups(prisma, {
    [actor.id]: buildAuthUser(actor),
    ...(target ? { [target.id]: target } : {}),
  });

const get = (id = 'passenger-1', user = admin) =>
  getUser(apiRequest(`/users/${id}`, { user }), params(id));
const put = (body, { id = 'passenger-1', user = admin } = {}) =>
  updateUser(
    apiRequest(`/users/${id}`, { method: 'PUT', user, body }),
    params(id),
  );
const del = (id = 'passenger-1') =>
  deleteUser(
    apiRequest(`/users/${id}`, { method: 'DELETE', user: admin }),
    params(id),
  );

beforeEach(() => {
  vi.clearAllMocks();
  primeSideEffects(prisma);
});

describe('GET /api/users/[id]', () => {
  it('requires authentication', async () => {
    const response = await getUser(
      apiRequest('/users/passenger-1'),
      params('passenger-1'),
    );

    expect(response.status).toBe(401);
  });

  it('lets an admin read any profile, including the bus pass', async () => {
    actingAs(admin, passenger);
    prisma.user.findUnique.mockImplementation(async ({ where }) =>
      where.id === admin.id
        ? buildAuthUser(admin)
        : { ...passenger, busPass: { passNumber: 'BP-1' } },
    );

    const response = await get();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.user.id).toBe('passenger-1');

    const args = prisma.user.findUnique.mock.calls.at(-1)[0];
    expect(args.select.password).toBeUndefined();
    expect(args.select.busPass).toBe(true);
  });

  it('lets a user read their own profile', async () => {
    actingAs(passenger, passenger);

    const response = await get('passenger-1', passenger);

    expect(response.status).toBe(200);
  });

  it("blocks a user from reading another user's profile", async () => {
    actingAs(passenger, passenger);

    const response = await get('someone-else', passenger);

    expect(response.status).toBe(403);
    expect((await response.json()).error).toMatch(/access denied/i);
  });

  it('returns 404 when the profile does not exist', async () => {
    actingAs(admin, null);

    expect((await get('ghost')).status).toBe(404);
  });
});

describe('PUT /api/users/[id]', () => {
  it('requires authentication', async () => {
    const response = await updateUser(
      apiRequest('/users/passenger-1', { method: 'PUT', body: { name: 'X' } }),
      params('passenger-1'),
    );

    expect(response.status).toBe(401);
  });

  it("blocks a user from updating someone else's profile", async () => {
    actingAs(passenger, passenger);

    const response = await put({ name: 'Hacked' }, { id: 'someone-else', user: passenger });

    expect(response.status).toBe(403);
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it('lets a user update their own profile and hashes a new password', async () => {
    actingAs(passenger, passenger);
    prisma.user.update.mockResolvedValue({
      ...passenger,
      name: 'Renamed',
      password: '$2a$12$newhash',
    });

    const response = await put(
      { name: 'Renamed', password: 'brand-new-secret' },
      { user: passenger },
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.message).toMatch(/updated successfully/i);
    expect(body.user.password).toBeUndefined();

    const { data } = prisma.user.update.mock.calls[0][0];
    expect(data.name).toBe('Renamed');
    expect(data.password).not.toBe('brand-new-secret');
    expect(data.password).toMatch(/^\$2[aby]\$/);
  });

  it('lets an admin update another user', async () => {
    actingAs(admin, passenger);
    prisma.user.update.mockResolvedValue({ ...passenger, phone: '+1000' });

    const response = await put({ phone: '+1000' });

    expect(response.status).toBe(200);
    expect(prisma.user.update.mock.calls[0][0].data.phone).toBe('+1000');

    const log = prisma.activityLog.create.mock.calls.at(-1)[0].data;
    expect(log.action).toBe('UPDATE_USER');
  });
});

describe('DELETE /api/users/[id]', () => {
  it('restricts deactivation to admins', async () => {
    actingAs(passenger, passenger);

    const response = await deleteUser(
      apiRequest('/users/passenger-1', { method: 'DELETE', user: passenger }),
      params('passenger-1'),
    );

    expect(response.status).toBe(403);
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it('returns 404 for an unknown user', async () => {
    actingAs(admin, null);

    expect((await del('ghost')).status).toBe(404);
  });

  it('soft-deletes by deactivating the account', async () => {
    actingAs(admin, passenger);
    prisma.user.update.mockResolvedValue({ ...passenger, isActive: false });

    const response = await del();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.message).toMatch(/deactivated successfully/i);

    // Users are deactivated, never deleted, so history and FKs stay intact.
    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: 'passenger-1' },
      data: { isActive: false },
    });
    expect(prisma.user.delete).not.toHaveBeenCalled();

    const log = prisma.activityLog.create.mock.calls.at(-1)[0].data;
    expect(log.action).toBe('DEACTIVATE_USER');
  });
});
