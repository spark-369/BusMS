import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// `vi.hoisted` is required because `vi.mock` factories are hoisted above the
// file's imports. Prisma is mocked because the facade's own job is the wiring,
// not the database access (covered separately in jobs.test.js).
const { notificationCreate, activityLogCreate } = vi.hoisted(() => ({
  notificationCreate: vi.fn(),
  activityLogCreate: vi.fn(),
}));

vi.mock('@/lib/prisma', () => ({
  default: {
    notification: { create: notificationCreate },
    activityLog: { create: activityLogCreate },
    $transaction: async (operations) => Promise.all(operations),
  },
}));

let enqueueActivity;
let enqueueBroadcast;
let enqueueEmergencyBroadcast;
let enqueueNotification;

beforeAll(async () => {
  ({
    enqueueActivity,
    enqueueBroadcast,
    enqueueEmergencyBroadcast,
    enqueueNotification,
  } = await import('@/lib/enqueue'));
});

beforeEach(() => {
  // No Redis -> the facade runs the real handlers inline, so the assertions
  // below verify the end-to-end wiring rather than a mock's return value.
  delete process.env.REDIS_URL;

  notificationCreate.mockReset();
  activityLogCreate.mockReset();

  // Restore the default behaviour that `mockReset` cleared.
  notificationCreate.mockImplementation(async ({ data }) => ({ id: 'n1', ...data }));
  activityLogCreate.mockImplementation(async ({ data }) => ({ id: 'a1', ...data }));
});

describe('enqueueNotification', () => {
  it('runs the real handler inline and writes the notification', async () => {
    const result = await enqueueNotification({
      userRole: 'PASSENGER',
      type: 'ROUTE_CREATED',
      title: 'New Route',
      message: 'Route A',
      link: '/routes',
    });

    expect(result.mode).toBe('inline');
    expect(notificationCreate).toHaveBeenCalledWith({
      data: {
        userRole: 'PASSENGER',
        type: 'ROUTE_CREATED',
        title: 'New Route',
        message: 'Route A',
        link: '/routes',
      },
    });
  });

  it('never throws — a notification is a side effect', async () => {
    notificationCreate.mockRejectedValueOnce(new Error('db down'));

    // A failing notification must not fail the caller's booking/route creation.
    await expect(
      enqueueNotification({
        userRole: 'DRIVER',
        type: 'DELAY',
        title: 't',
        message: 'm',
      }),
    ).resolves.toEqual({ mode: 'inline', skipped: true });
  });
});

describe('enqueueBroadcast', () => {
  it('writes one row per role', async () => {
    await enqueueBroadcast({
      roles: ['ADMIN', 'DRIVER', 'PASSENGER'],
      type: 'EMERGENCY',
      title: 't',
      message: 'm',
    });

    expect(notificationCreate).toHaveBeenCalledTimes(3);
  });

  it('never throws on a failure', async () => {
    notificationCreate.mockRejectedValue(new Error('db down'));

    await expect(
      enqueueBroadcast({ type: 'DELAY', title: 't', message: 'm' }),
    ).resolves.toEqual({ mode: 'inline', skipped: true });
  });
});

describe('enqueueEmergencyBroadcast', () => {
  it('fans out and records the audit trail', async () => {
    await enqueueEmergencyBroadcast({ message: 'Evacuate', userId: 'admin-1' });

    expect(notificationCreate).toHaveBeenCalledTimes(3);
    expect(activityLogCreate).toHaveBeenCalledTimes(1);
    expect(activityLogCreate.mock.calls[0][0].data.action).toBe(
      'EMERGENCY_BROADCAST',
    );
  });

  it('tolerates a null userId', async () => {
    await enqueueEmergencyBroadcast({ message: 'Evacuate', userId: null });

    expect(notificationCreate).toHaveBeenCalledTimes(3);
    expect(activityLogCreate).not.toHaveBeenCalled();
  });
});

describe('enqueueActivity', () => {
  it('extracts ip and user agent from the request headers', async () => {
    const req = new Request('http://localhost/api/buses', {
      headers: {
        'x-forwarded-for': '203.0.113.7, 70.41.3.18',
        'user-agent': 'vitest-agent',
      },
    });

    await enqueueActivity({
      userId: 'u1',
      action: 'CREATE_BUS',
      details: 'Bus created',
      req,
    });

    expect(activityLogCreate).toHaveBeenCalledWith({
      data: {
        userId: 'u1',
        action: 'CREATE_BUS',
        details: 'Bus created',
        ipAddress: '203.0.113.7',
        userAgent: 'vitest-agent',
      },
    });
  });

  it('works without a request object', async () => {
    await enqueueActivity({ userId: 'u1', action: 'LOGIN' });

    expect(activityLogCreate.mock.calls[0][0].data.ipAddress).toBeNull();
  });

  it('short-circuits when userId or action is missing', async () => {
    expect(await enqueueActivity({ action: 'LOGIN' })).toEqual({
      mode: 'inline',
      skipped: true,
    });
    expect(await enqueueActivity({ userId: 'u1' })).toEqual({
      mode: 'inline',
      skipped: true,
    });
    expect(activityLogCreate).not.toHaveBeenCalled();
  });

  it('never throws on a failure', async () => {
    activityLogCreate.mockRejectedValueOnce(new Error('db down'));

    // Audit logging must never break the primary operation.
    await expect(
      enqueueActivity({ userId: 'u1', action: 'LOGIN' }),
    ).resolves.toEqual({ mode: 'inline', skipped: true });
  });
});
