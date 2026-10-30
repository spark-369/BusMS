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
let getActivityLogs;

beforeAll(async () => {
  prisma = (await import('@/lib/prisma')).default;
  ({ GET: getActivityLogs } = await import('@/app/api/activity-logs/route'));
});

const admin = adminUser();
const driver = driverUser();

const get = (query = '', user = admin) =>
  getActivityLogs(apiRequest(`/activity-logs${query}`, { user }));

beforeEach(() => {
  vi.clearAllMocks();
  actAs(prisma, admin);
});

describe('GET /api/activity-logs', () => {
  it('requires authentication', async () => {
    const response = await getActivityLogs(apiRequest('/activity-logs'));

    expect(response.status).toBe(401);
    expect(prisma.activityLog.findMany).not.toHaveBeenCalled();
  });

  it('restricts the audit trail to admins', async () => {
    actAs(prisma, driver);

    expect((await get('', driver)).status).toBe(403);
    expect(prisma.activityLog.findMany).not.toHaveBeenCalled();
  });

  it('maps the user, action and date filters', async () => {
    prisma.activityLog.findMany.mockResolvedValue([]);
    prisma.activityLog.count.mockResolvedValue(0);

    await get('?userId=user-1&action=CREATE_BUS&startDate=2024-01-01&endDate=2024-02-01');

    const { where } = prisma.activityLog.findMany.mock.calls.at(-1)[0];
    expect(where.userId).toBe('user-1');
    expect(where.action).toBe('CREATE_BUS');
    expect(where.createdAt.gte).toBeInstanceOf(Date);
    expect(where.createdAt.lte).toBeInstanceOf(Date);
  });

  it('defaults to page 1 with a limit of 20', async () => {
    prisma.activityLog.findMany.mockResolvedValue([]);
    prisma.activityLog.count.mockResolvedValue(0);

    const body = await (await get()).json();

    expect(body.pagination).toEqual({
      page: 1,
      limit: 20,
      total: 0,
      totalPages: 0,
    });

    const args = prisma.activityLog.findMany.mock.calls.at(-1)[0];
    expect(args.skip).toBe(0);
    expect(args.take).toBe(20);
  });

  it('paginates with skip/take derived from the page', async () => {
    prisma.activityLog.findMany.mockResolvedValue([]);
    prisma.activityLog.count.mockResolvedValue(45);

    const body = await (await get('?page=3&limit=10')).json();

    const args = prisma.activityLog.findMany.mock.calls.at(-1)[0];
    expect(args.skip).toBe(20);
    expect(args.take).toBe(10);
    expect(body.pagination).toEqual({
      page: 3,
      limit: 10,
      total: 45,
      totalPages: 5,
    });
  });

  it('sanitizes invalid pagination into safe bounds', async () => {
    prisma.activityLog.findMany.mockResolvedValue([]);
    prisma.activityLog.count.mockResolvedValue(0);

    // Negative page and an over-large limit must be clamped, not passed through.
    const body = await (await get('?page=-5&limit=100000')).json();

    expect(body.pagination.page).toBe(1);
    expect(body.pagination.limit).toBe(100);
    expect(prisma.activityLog.findMany.mock.calls.at(-1)[0].take).toBe(100);
  });

  it('falls back to the defaults for non-numeric pagination', async () => {
    prisma.activityLog.findMany.mockResolvedValue([]);
    prisma.activityLog.count.mockResolvedValue(0);

    const body = await (await get('?page=abc&limit=xyz')).json();

    expect(body.pagination.page).toBe(1);
    expect(body.pagination.limit).toBe(20);
  });

  it('returns logs newest first with the actor relation', async () => {
    prisma.activityLog.findMany.mockResolvedValue([{ id: 'log-1', action: 'LOGIN' }]);
    prisma.activityLog.count.mockResolvedValue(1);

    const body = await (await get()).json();

    expect(body.logs).toHaveLength(1);

    const args = prisma.activityLog.findMany.mock.calls.at(-1)[0];
    expect(args.orderBy).toEqual({ createdAt: 'desc' });
    expect(args.include.user.select).toEqual({
      name: true,
      email: true,
      role: true,
    });
  });

  it('returns 500 when the database throws', async () => {
    prisma.activityLog.findMany.mockRejectedValue(new Error('connection lost'));

    expect((await get('?action=X')).status).toBe(500);
  });
});
