import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  actAs,
  adminUser,
  apiRequest,
  passengerUser,
  primeSideEffects,
} from '../helpers/routeHarness';

vi.mock('@/lib/prisma', async () => {
  const { createPrismaMock } = await import('../helpers/prismaMock');
  return { default: createPrismaMock() };
});

delete process.env.REDIS_URL;

let prisma;
let getNotifications;
let createNotification;
let updateNotifications;
let deleteNotifications;

beforeAll(async () => {
  prisma = (await import('@/lib/prisma')).default;
  ({ GET: getNotifications, POST: createNotification, PUT: updateNotifications, DELETE: deleteNotifications } =
    await import('@/app/api/notifications/route'));
});

const admin = adminUser();
const passenger = passengerUser();

const notification = (overrides = {}) => ({
  id: 'notification-1',
  userRole: 'PASSENGER',
  type: 'SCHEDULE_CHANGE',
  title: 'Route update',
  message: 'Something changed',
  link: '/routes',
  isRead: false,
  sentAt: new Date('2024-01-01T00:00:00Z'),
  ...overrides,
});

const get = (query = '', user = admin) =>
  getNotifications(apiRequest(`/notifications${query}`, { user }));
const post = (body, user = admin) =>
  createNotification(apiRequest('/notifications', { method: 'POST', user, body }));
const put = (body, user = admin) =>
  updateNotifications(apiRequest('/notifications', { method: 'PUT', user, body }));
const del = (query = '', user = admin) =>
  deleteNotifications(apiRequest(`/notifications${query}`, { method: 'DELETE', user }));

beforeEach(() => {
  vi.clearAllMocks();
  actAs(prisma, admin);
  primeSideEffects(prisma);
});

describe('GET /api/notifications', () => {
  it('requires authentication', async () => {
    const response = await getNotifications(apiRequest('/notifications'));

    expect(response.status).toBe(401);
  });

  it('scopes a passenger feed to their role', async () => {
    actAs(prisma, passenger);
    prisma.notification.findMany.mockResolvedValue([]);
    prisma.notification.count.mockResolvedValue(0);

    await get('', passenger);

    // Without this filter a passenger would receive driver/admin notices.
    expect(prisma.notification.findMany.mock.calls.at(-1)[0].where).toEqual({
      userRole: 'PASSENGER',
    });
    expect(prisma.notification.count.mock.calls.at(-1)[0].where).toEqual({
      userRole: 'PASSENGER',
      isRead: false,
    });
  });

  it('lets an admin see every role with an unread total', async () => {
    prisma.notification.findMany.mockResolvedValue([notification()]);
    prisma.notification.count.mockResolvedValue(3);

    const response = await get();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.unreadCount).toBe(3);

    // An empty `where` is how the route expresses "admin sees all".
    expect(prisma.notification.findMany.mock.calls.at(-1)[0].where).toEqual({});
    expect(prisma.notification.count.mock.calls.at(-1)[0].where).toEqual({
      isRead: false,
    });
  });

  it('applies the isRead and type filters', async () => {
    prisma.notification.findMany.mockResolvedValue([]);
    prisma.notification.count.mockResolvedValue(0);

    await get('?isRead=true&type=EMERGENCY');

    expect(prisma.notification.findMany.mock.calls.at(-1)[0].where).toEqual({
      isRead: true,
      type: 'EMERGENCY',
    });
  });

  it('caps the feed at the 50 most recent entries', async () => {
    prisma.notification.findMany.mockResolvedValue([]);
    prisma.notification.count.mockResolvedValue(0);

    await get();

    const args = prisma.notification.findMany.mock.calls.at(-1)[0];
    expect(args.take).toBe(50);
    expect(args.orderBy).toEqual({ sentAt: 'desc' });
  });

  it('does not leak one role cached feed to another role', async () => {
    // The cache key must include the role, or a passenger could be served an
    // admin's cached list.
    prisma.notification.findMany.mockResolvedValue([notification()]);
    prisma.notification.count.mockResolvedValue(0);

    const adminResponse = await get();
    expect(adminResponse.headers.get('X-Cache')).toBe('MISS');

    actAs(prisma, passenger);
    const passengerResponse = await get('', passenger);
    expect(passengerResponse.headers.get('X-Cache')).toBe('MISS');
  });

  it('returns 500 when the database throws', async () => {
    prisma.notification.findMany.mockRejectedValue(new Error('connection lost'));

    expect((await get('?type=X')).status).toBe(500);
  });
});

describe('POST /api/notifications', () => {
  const validBody = {
    type: 'SCHEDULE_CHANGE',
    title: 'Route update',
    message: 'Something changed',
    userRole: 'PASSENGER',
  };

  it('restricts sending to admins', async () => {
    actAs(prisma, passenger);

    const response = await post(validBody, passenger);

    expect(response.status).toBe(403);
    expect(prisma.notification.create).not.toHaveBeenCalled();
  });

  it('requires type, title and message', async () => {
    const response = await post({ type: 'DELAY' });

    expect(response.status).toBe(400);
    expect((await response.json()).error).toMatch(/required/i);
  });

  it('rejects an unknown notification type', async () => {
    const response = await post({ ...validBody, type: 'NOT_A_TYPE' });

    expect(response.status).toBe(400);
    expect((await response.json()).error).toMatch(/invalid notification type/i);
  });

  it('creates a single role-targeted notification', async () => {
    const response = await post(validBody);
    const body = await response.json();

    expect(response.status).toBe(201);
    expect(body.message).toMatch(/sent successfully/i);

    const { data } = prisma.notification.create.mock.calls.at(-1)[0];
    expect(data.userRole).toBe('PASSENGER');
    expect(data.title).toBe('Route update');
  });

  it('fans a general notification out to all three roles', async () => {
    // No userRole -> a broadcast through the transaction-based job handler.
    const response = await post({
      type: 'EMERGENCY',
      title: 'Campus closed',
      message: 'All buses suspended',
    });

    expect(response.status).toBe(201);
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(prisma.notification.create).toHaveBeenCalledTimes(3);

    const roles = prisma.notification.create.mock.calls.map(([args]) => args.data.userRole);
    expect(roles.sort()).toEqual(['ADMIN', 'DRIVER', 'PASSENGER']);
  });

  it('flushes the notification cache after sending', async () => {
    prisma.notification.findMany.mockResolvedValue([]);
    prisma.notification.count.mockResolvedValue(0);

    await get();
    await post(validBody);

    const after = await get();
    expect(after.headers.get('X-Cache')).toBe('MISS');
  });
});

describe('PUT /api/notifications', () => {
  it('requires authentication', async () => {
    const response = await updateNotifications(
      apiRequest('/notifications', { method: 'PUT', body: { markAllRead: true } }),
    );

    expect(response.status).toBe(401);
  });

  it('marks only the caller role as read for a non-admin', async () => {
    actAs(prisma, passenger);

    const response = await put({ markAllRead: true }, passenger);

    expect(response.status).toBe(200);
    expect(prisma.notification.updateMany.mock.calls.at(-1)[0].where).toEqual({
      userRole: 'PASSENGER',
      isRead: false,
    });
  });

  it('marks every role as read for an admin', async () => {
    const response = await put({ markAllRead: true });

    expect(response.status).toBe(200);
    expect(prisma.notification.updateMany.mock.calls.at(-1)[0].where).toEqual({
      isRead: false,
    });
  });

  it('marks specific ids as read, scoped to the caller role', async () => {
    actAs(prisma, passenger);

    await put({ notificationIds: ['n1', 'n2'] }, passenger);

    expect(prisma.notification.updateMany.mock.calls.at(-1)[0].where).toEqual({
      id: { in: ['n1', 'n2'] },
      userRole: 'PASSENGER',
    });
  });

  it('deletes ids, scoped to the caller role for a non-admin', async () => {
    actAs(prisma, passenger);

    await put({ deleteNotificationIds: ['n1'] }, passenger);

    expect(prisma.notification.deleteMany.mock.calls.at(-1)[0].where).toEqual({
      id: { in: ['n1'] },
      userRole: 'PASSENGER',
    });
  });

  it('returns 500 when the database throws', async () => {
    prisma.notification.updateMany.mockRejectedValue(new Error('connection lost'));

    expect((await put({ markAllRead: true })).status).toBe(500);
  });
});

describe('DELETE /api/notifications', () => {
  it('restricts deletion to admins', async () => {
    actAs(prisma, passenger);

    const response = await del('?id=n1', passenger);

    expect(response.status).toBe(403);
    expect(prisma.notification.delete).not.toHaveBeenCalled();
  });

  it('deletes a single notification by id', async () => {
    prisma.notification.delete.mockResolvedValue(notification());

    const response = await del('?id=notification-1');
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.message).toMatch(/deleted successfully/i);
    expect(prisma.notification.delete).toHaveBeenCalledWith({
      where: { id: 'notification-1' },
    });
  });

  it('cleans up read notifications when no id is given', async () => {
    prisma.notification.deleteMany.mockResolvedValue({ count: 4 });

    await del();

    expect(prisma.notification.deleteMany).toHaveBeenCalledWith({
      where: { isRead: true },
    });
    expect(prisma.notification.delete).not.toHaveBeenCalled();
  });

  it('returns 500 when the database throws', async () => {
    prisma.notification.delete.mockRejectedValue(new Error('connection lost'));

    expect((await del('?id=n1')).status).toBe(500);
  });
});
