import { beforeEach, describe, expect, it, vi } from 'vitest';

import notificationHandlers, {
  broadcastNotification,
  createNotification,
  emergencyBroadcast,
  NOTIFICATION_JOBS,
} from '@/lib/jobs/notification.jobs.mjs';
import auditHandlers, { AUDIT_JOBS, writeAuditLog } from '@/lib/jobs/audit.jobs.mjs';

/**
 * These handlers take Prisma by injection rather than importing it, which is
 * what lets the same file run inside the Next.js bundle and in the standalone
 * worker. The tests therefore pass a hand-rolled stub instead of mocking a
 * module — which also documents exactly which Prisma surface the handlers use.
 */
const createPrismaStub = () => {
  const notificationCreate = vi.fn(async ({ data }) => ({ id: 'n1', ...data }));
  const activityLogCreate = vi.fn(async ({ data }) => ({ id: 'a1', ...data }));

  return {
    notificationCreate,
    activityLogCreate,
    prisma: {
      notification: { create: notificationCreate },
      activityLog: { create: activityLogCreate },
      // The fan-out handlers use a transaction so a partial broadcast cannot
      // happen; the stub runs the operations directly.
      $transaction: vi.fn(async (operations) => Promise.all(operations)),
    },
  };
};

let stub;

beforeEach(() => {
  stub = createPrismaStub();
});

describe('notification.create', () => {
  it('creates a role-targeted notification', async () => {
    const result = await createNotification({
      prisma: stub.prisma,
      data: {
        userRole: 'PASSENGER',
        type: 'ROUTE_CREATED',
        title: 'New Route',
        message: 'Route A added',
        link: '/routes',
      },
    });

    expect(stub.notificationCreate).toHaveBeenCalledTimes(1);
    expect(stub.notificationCreate).toHaveBeenCalledWith({
      data: {
        userRole: 'PASSENGER',
        type: 'ROUTE_CREATED',
        title: 'New Route',
        message: 'Route A added',
        link: '/routes',
      },
    });
    expect(result.id).toBe('n1');
  });

  it('defaults the link to an empty string', async () => {
    await createNotification({
      prisma: stub.prisma,
      data: { userRole: 'ADMIN', type: 'DELAY', title: 't', message: 'm' },
    });

    expect(stub.notificationCreate.mock.calls[0][0].data.link).toBe('');
  });

  it.each([
    ['userRole', { type: 'DELAY', title: 't', message: 'm' }],
    ['type', { userRole: 'ADMIN', title: 't', message: 'm' }],
    ['title', { userRole: 'ADMIN', type: 'DELAY', message: 'm' }],
    ['message', { userRole: 'ADMIN', type: 'DELAY', title: 't' }],
  ])('throws when %s is missing', async (_field, data) => {
    // A malformed job must fail loudly so BullMQ retries rather than silently
    // writing a half-empty row.
    await expect(createNotification({ prisma: stub.prisma, data })).rejects.toThrow(
      /requires userRole, type, title and message/,
    );

    expect(stub.notificationCreate).not.toHaveBeenCalled();
  });
});

describe('notification.broadcast', () => {
  it('creates one row per role inside a single transaction', async () => {
    const result = await broadcastNotification({
      prisma: stub.prisma,
      data: { type: 'EMERGENCY', title: 't', message: 'm', link: '/x' },
    });

    expect(stub.prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(stub.notificationCreate).toHaveBeenCalledTimes(3);
    expect(result).toEqual({ created: 3, roles: ['ADMIN', 'DRIVER', 'PASSENGER'] });
  });

  it('honours an explicit role list', async () => {
    const result = await broadcastNotification({
      prisma: stub.prisma,
      data: { roles: ['DRIVER'], type: 'DELAY', title: 't', message: 'm' },
    });

    expect(result.roles).toEqual(['DRIVER']);
    expect(stub.notificationCreate).toHaveBeenCalledTimes(1);
  });

  it('throws when required fields are missing', async () => {
    await expect(
      broadcastNotification({ prisma: stub.prisma, data: { title: 't' } }),
    ).rejects.toThrow(/requires type, title and message/);
  });
});

describe('notification.emergency', () => {
  it('notifies every role and writes the audit record', async () => {
    const result = await emergencyBroadcast({
      prisma: stub.prisma,
      data: { message: 'Evacuate', userId: 'admin-1' },
    });

    expect(stub.notificationCreate).toHaveBeenCalledTimes(3);
    expect(stub.activityLogCreate).toHaveBeenCalledWith({
      data: {
        userId: 'admin-1',
        action: 'EMERGENCY_BROADCAST',
        details: 'Evacuate',
      },
    });
    expect(result).toEqual({ created: 3, audited: true });
  });

  it('skips the audit row when there is no authenticated user', async () => {
    // The ActivityLog.userId FK would otherwise fail, which is exactly the
    // guard the original route had.
    const result = await emergencyBroadcast({
      prisma: stub.prisma,
      data: { message: 'Evacuate', userId: null },
    });

    expect(stub.activityLogCreate).not.toHaveBeenCalled();
    expect(result.audited).toBe(false);
  });

  it('throws when the message is missing', async () => {
    await expect(emergencyBroadcast({ prisma: stub.prisma, data: {} })).rejects.toThrow(
      /requires a message/,
    );
  });
});

describe('audit.log', () => {
  it('writes the audit entry with ip and user agent', async () => {
    const result = await writeAuditLog({
      prisma: stub.prisma,
      data: {
        userId: 'u1',
        action: 'CREATE_BUS',
        details: 'Bus B1 created',
        ipAddress: '203.0.113.7',
        userAgent: 'vitest',
      },
    });

    expect(stub.activityLogCreate).toHaveBeenCalledWith({
      data: {
        userId: 'u1',
        action: 'CREATE_BUS',
        details: 'Bus B1 created',
        ipAddress: '203.0.113.7',
        userAgent: 'vitest',
      },
    });
    expect(result).toEqual({ id: 'a1' });
  });

  it('normalises missing optional fields to null', async () => {
    await writeAuditLog({
      prisma: stub.prisma,
      data: { userId: 'u1', action: 'LOGIN' },
    });

    expect(stub.activityLogCreate.mock.calls[0][0].data).toEqual({
      userId: 'u1',
      action: 'LOGIN',
      details: null,
      ipAddress: null,
      userAgent: null,
    });
  });

  it('is a successful no-op without a userId or action', async () => {
    // Returning success (not throwing) avoids an infinite retry loop for a job
    // that can never succeed.
    expect(await writeAuditLog({ prisma: stub.prisma, data: {} })).toEqual({
      skipped: true,
    });
    expect(
      await writeAuditLog({ prisma: stub.prisma, data: { action: 'X' } }),
    ).toEqual({ skipped: true });
    expect(stub.activityLogCreate).not.toHaveBeenCalled();
  });

  it('propagates a database error so BullMQ can retry it', async () => {
    stub.prisma.activityLog.create.mockRejectedValueOnce(new Error('db down'));

    await expect(
      writeAuditLog({ prisma: stub.prisma, data: { userId: 'u1', action: 'LOGIN' } }),
    ).rejects.toThrow('db down');
  });
});

describe('handler registries', () => {
  it('maps every exported job name to a callable handler', () => {
    for (const name of Object.values(NOTIFICATION_JOBS)) {
      expect(typeof notificationHandlers[name]).toBe('function');
    }
    for (const name of Object.values(AUDIT_JOBS)) {
      expect(typeof auditHandlers[name]).toBe('function');
    }
  });

  it('uses namespaced job names so the two queues cannot collide', () => {
    expect(Object.values(AUDIT_JOBS)).toContain('audit.log');
    expect(Object.values(NOTIFICATION_JOBS)).toContain('notification.create');
  });
});
