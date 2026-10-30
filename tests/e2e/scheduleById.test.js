import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  actAs,
  adminUser,
  apiRequest,
  passengerUser,
  params,
  primeSideEffects,
  scheduleFixture,
} from '../helpers/routeHarness';

vi.mock('@/lib/prisma', async () => {
  const { createPrismaMock } = await import('../helpers/prismaMock');
  return { default: createPrismaMock() };
});

delete process.env.REDIS_URL;

let prisma;
let getSchedule;
let updateSchedule;
let deleteSchedule;

beforeAll(async () => {
  prisma = (await import('@/lib/prisma')).default;
  ({ GET: getSchedule, PUT: updateSchedule, DELETE: deleteSchedule } =
    await import('@/app/api/schedules/[id]/route'));
});

const admin = adminUser();
const passenger = passengerUser();

const get = (id = 'schedule-1') =>
  getSchedule(apiRequest(`/schedules/${id}`, { user: admin }), params(id));
const put = (body, id = 'schedule-1') =>
  updateSchedule(
    apiRequest(`/schedules/${id}`, { method: 'PUT', user: admin, body }),
    params(id),
  );
const del = (id = 'schedule-1') =>
  deleteSchedule(
    apiRequest(`/schedules/${id}`, { method: 'DELETE', user: admin }),
    params(id),
  );

beforeEach(() => {
  vi.clearAllMocks();
  actAs(prisma, admin);
  primeSideEffects(prisma);
});

describe('GET /api/schedules/[id]', () => {
  it('requires authentication', async () => {
    const response = await getSchedule(
      apiRequest('/schedules/schedule-1'),
      params('schedule-1'),
    );

    expect(response.status).toBe(401);
  });

  it('returns the schedule with its route and bus', async () => {
    prisma.schedule.findUnique.mockResolvedValue(scheduleFixture());

    const response = await get();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.schedule.id).toBe('schedule-1');

    const args = prisma.schedule.findUnique.mock.calls.at(-1)[0];
    expect(args.where).toEqual({ id: 'schedule-1' });
    expect(Object.keys(args.include)).toEqual(
      expect.arrayContaining(['route', 'bus']),
    );
  });

  it('returns 404 for an unknown schedule', async () => {
    prisma.schedule.findUnique.mockResolvedValue(null);

    expect((await get('missing')).status).toBe(404);
  });

  it('caches a repeated read of the same id', async () => {
    prisma.schedule.findUnique.mockResolvedValue(scheduleFixture());

    await get();
    const second = await get();

    expect(second.headers.get('X-Cache')).toBe('HIT');
    expect(prisma.schedule.findUnique).toHaveBeenCalledTimes(1);
  });
});

describe('PUT /api/schedules/[id]', () => {
  it('restricts updates to admins', async () => {
    actAs(prisma, passenger);

    const response = await updateSchedule(
      apiRequest('/schedules/schedule-1', {
        method: 'PUT',
        user: passenger,
        body: {},
      }),
      params('schedule-1'),
    );

    expect(response.status).toBe(403);
    expect(prisma.schedule.update).not.toHaveBeenCalled();
  });

  it('returns 404 for an unknown schedule', async () => {
    prisma.schedule.findUnique.mockResolvedValue(null);

    expect((await put({ notes: 'x' }, 'missing')).status).toBe(404);
  });

  it('rejects an unparseable departure time', async () => {
    prisma.schedule.findUnique.mockResolvedValue(scheduleFixture());

    const response = await put({ departureTime: 'not-a-time' });

    expect(response.status).toBe(400);
    expect((await response.json()).error).toMatch(/invalid departure time/i);
  });

  it('updates only supplied fields and ignores an invalid enum value', async () => {
    prisma.schedule.findUnique
      .mockResolvedValueOnce(scheduleFixture())
      .mockResolvedValueOnce(scheduleFixture({ notes: 'Updated' }));
    prisma.schedule.update.mockResolvedValue(scheduleFixture());

    const response = await put({
      notes: 'Updated',
      isActive: false,
      scheduleType: 'REGULAR',
    });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.message).toMatch(/updated successfully/i);

    const { data } = prisma.schedule.update.mock.calls[0][0];
    expect(data.notes).toBe('Updated');
    expect(data.isActive).toBe(false);
    // An unrecognised enum value must be dropped rather than written.
    expect(data).not.toHaveProperty('scheduleType');
    expect(data).not.toHaveProperty('routeId');
  });

  it('audits the update and flushes the schedules cache', async () => {
    prisma.schedule.findUnique.mockResolvedValue(scheduleFixture());
    prisma.schedule.update.mockResolvedValue(scheduleFixture());

    await get();
    await put({ notes: 'Updated' });

    const log = prisma.activityLog.create.mock.calls.at(-1)[0].data;
    expect(log.action).toBe('UPDATE_SCHEDULE');

    const after = await get();
    expect(after.headers.get('X-Cache')).toBe('MISS');
  });

  it('returns 500 when the database throws', async () => {
    prisma.schedule.findUnique.mockRejectedValue(new Error('connection lost'));

    expect((await put({ notes: 'x' })).status).toBe(500);
  });
});

describe('DELETE /api/schedules/[id]', () => {
  it('restricts deletion to admins', async () => {
    actAs(prisma, passenger);

    const response = await deleteSchedule(
      apiRequest('/schedules/schedule-1', { method: 'DELETE', user: passenger }),
      params('schedule-1'),
    );

    expect(response.status).toBe(403);
  });

  it('soft-deletes by deactivating the schedule', async () => {
    prisma.schedule.findUnique.mockResolvedValue(scheduleFixture());
    prisma.schedule.update.mockResolvedValue(scheduleFixture({ isActive: false }));

    const response = await del();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.message).toMatch(/deactivated successfully/i);

    expect(prisma.schedule.update).toHaveBeenCalledWith({
      where: { id: 'schedule-1' },
      data: { isActive: false },
    });
    expect(prisma.schedule.delete).not.toHaveBeenCalled();

    const log = prisma.activityLog.create.mock.calls.at(-1)[0].data;
    expect(log.action).toBe('DEACTIVATE_SCHEDULE');
  });

  it('returns 404 for an unknown schedule', async () => {
    prisma.schedule.findUnique.mockResolvedValue(null);

    expect((await del('missing')).status).toBe(404);
  });
});
