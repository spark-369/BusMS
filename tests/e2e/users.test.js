import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  actAs,
  adminUser,
  apiRequest,
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
let getUsers;
let createUser;

beforeAll(async () => {
  prisma = (await import('@/lib/prisma')).default;
  ({ GET: getUsers, POST: createUser } = await import('@/app/api/users/route'));
});

const admin = adminUser();
const passenger = passengerUser();

const get = (query = '', user = admin) =>
  getUsers(apiRequest(`/users${query}`, { user }));
const post = (body, user = admin) =>
  createUser(apiRequest('/users', { method: 'POST', user, body }));

beforeEach(() => {
  vi.clearAllMocks();
  actAs(prisma, admin);
  primeSideEffects(prisma);
});

describe('GET /api/users', () => {
  it('requires authentication', async () => {
    const response = await getUsers(apiRequest('/users'));

    expect(response.status).toBe(401);
    expect(prisma.user.findMany).not.toHaveBeenCalled();
  });

  it('restricts the user directory to admins', async () => {
    actAs(prisma, passenger);

    const response = await get('', passenger);

    expect(response.status).toBe(403);
    expect(prisma.user.findMany).not.toHaveBeenCalled();
  });

  it('never selects the password hash', async () => {
    prisma.user.findMany.mockResolvedValue([]);

    await get();

    // The projection is the guarantee: the hash is not even fetched.
    const { select } = prisma.user.findMany.mock.calls.at(-1)[0];
    expect(select.password).toBeUndefined();
    expect(select.email).toBe(true);
    expect(select.role).toBe(true);
  });

  it('maps the role and isActive filters', async () => {
    prisma.user.findMany.mockResolvedValue([]);

    await get('?role=DRIVER&isActive=true');

    expect(prisma.user.findMany.mock.calls.at(-1)[0].where).toEqual({
      role: 'DRIVER',
      isActive: true,
    });
  });

  it('orders users newest first', async () => {
    prisma.user.findMany.mockResolvedValue([]);

    await get();

    expect(prisma.user.findMany.mock.calls.at(-1)[0].orderBy).toEqual({
      createdAt: 'desc',
    });
  });

  it('returns 500 when the database throws', async () => {
    prisma.user.findMany.mockRejectedValue(new Error('connection lost'));

    expect((await get('?role=X')).status).toBe(500);
  });
});

describe('POST /api/users', () => {
  const validBody = {
    email: 'new-user@campus.edu',
    password: 'secret123',
    name: 'New User',
    role: 'PASSENGER',
    passengerId: 'P-77',
  };

  it('restricts creation to admins', async () => {
    actAs(prisma, passenger);

    const response = await post(validBody, passenger);

    expect(response.status).toBe(403);
    expect(prisma.user.create).not.toHaveBeenCalled();
  });

  it('requires email, password and name', async () => {
    const response = await post({ email: 'a@campus.edu' });

    expect(response.status).toBe(400);
    expect((await response.json()).error).toMatch(/required/i);
  });

  it('rejects an email that is already registered', async () => {
    // The auth middleware looks the actor up by id; the handler checks the new
    // email — both hit `user.findUnique`, so the double discriminates by field.
    mockUserLookups(prisma, {
      [admin.id]: buildAuthUser(admin),
      'new-user@campus.edu': { id: 'existing-1' },
    });

    const response = await post(validBody);

    expect(response.status).toBe(400);
    expect((await response.json()).error).toMatch(/already registered/i);
    expect(prisma.user.create).not.toHaveBeenCalled();
  });

  it('creates the user, hashes the password and strips it from the response', async () => {
    mockUserLookups(prisma, { [admin.id]: buildAuthUser(admin) });
    prisma.user.create.mockResolvedValue({
      id: 'user-9',
      email: validBody.email,
      name: validBody.name,
      role: 'PASSENGER',
      passengerId: 'P-77',
      licenseNumber: null,
      isActive: true,
      password: '$2a$12$hashed',
    });

    const response = await post(validBody);
    const body = await response.json();

    expect(response.status).toBe(201);
    expect(body.message).toMatch(/created successfully/i);
    expect(body.user.password).toBeUndefined();

    const { data } = prisma.user.create.mock.calls[0][0];
    // The plaintext password must never be persisted.
    expect(data.password).not.toBe(validBody.password);
    expect(data.passengerId).toBe('P-77');
    expect(data.licenseNumber).toBeNull();

    const log = prisma.activityLog.create.mock.calls.at(-1)[0].data;
    expect(log.action).toBe('CREATE_USER');
  });

  it('defaults the role to PASSENGER when none is supplied', async () => {
    mockUserLookups(prisma, { [admin.id]: buildAuthUser(admin) });
    prisma.user.create.mockResolvedValue({
      id: 'user-9',
      email: validBody.email,
      name: validBody.name,
      role: 'PASSENGER',
      password: 'hashed',
    });

    await post({ email: validBody.email, password: 'secret123', name: 'No Role' });

    expect(prisma.user.create.mock.calls[0][0].data.role).toBe('PASSENGER');
  });

  it('returns 500 when the database throws', async () => {
    prisma.user.findUnique.mockRejectedValue(new Error('connection lost'));

    expect((await post(validBody)).status).toBe(500);
  });
});
