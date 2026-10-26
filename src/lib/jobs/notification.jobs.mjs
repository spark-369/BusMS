/**
 * Notification job processors.
 *
 * These are plain ESM modules with **no imports of their own**: Prisma is
 * injected as `{ prisma }`. That is deliberate — it lets the exact same file be
 * loaded by the Next.js bundle (where `@/lib/prisma` resolves) *and* by the
 * standalone worker process (`worker/index.mjs`, plain Node, no bundler, no
 * path aliases). A shared import would break one of the two.
 */

export const NOTIFICATION_JOBS = {
  CREATE: 'notification.create',
  BROADCAST: 'notification.broadcast',
  EMERGENCY: 'notification.emergency',
};

const ALL_ROLES = ['ADMIN', 'DRIVER', 'PASSENGER'];

/**
 * Create one notification targeted at a single role.
 * @param {{ prisma: import('@prisma/client').PrismaClient, data: object }} ctx
 */
export const createNotification = async ({ prisma, data }) => {
  const { userRole, type, title, message, link } = data || {};

  if (!userRole || !type || !title || !message) {
    throw new Error(
      'notification.create requires userRole, type, title and message',
    );
  }

  return prisma.notification.create({
    data: {
      userRole,
      type,
      title,
      message,
      link: link || '',
    },
  });
};

/**
 * Fan one notification out to several roles (one row per role, matching the
 * schema's role-targeting model rather than per-user duplication).
 */
export const broadcastNotification = async ({ prisma, data }) => {
  const { roles = ALL_ROLES, type, title, message, link } = data || {};

  if (!type || !title || !message) {
    throw new Error('notification.broadcast requires type, title and message');
  }

  const results = await prisma.$transaction(
    roles.map((userRole) =>
      prisma.notification.create({
        data: {
          userRole,
          type,
          title,
          message,
          link: link || '',
        },
      }),
    ),
  );

  return { created: results.length, roles };
};

/**
 * Emergency broadcast: notify every role and record the audit trail in one job.
 * The audit write is included here because the broadcast must be traceable —
 * splitting them would allow a notification fan-out with no audit record.
 */
export const emergencyBroadcast = async ({ prisma, data }) => {
  const { message, userId } = data || {};

  if (!message) throw new Error('notification.emergency requires a message');

  const results = await prisma.$transaction(
    ALL_ROLES.map((userRole) =>
      prisma.notification.create({
        data: {
          userRole,
          type: 'EMERGENCY',
          title: 'Emergency Broadcast',
          message,
          link: '',
        },
      }),
    ),
  );

  // Only write the audit row when we have a real user, otherwise the
  // ActivityLog foreign key constraint would fail.
  if (userId) {
    await prisma.activityLog.create({
      data: {
        userId,
        action: 'EMERGENCY_BROADCAST',
        details: message,
      },
    });
  }

  return { created: results.length, audited: Boolean(userId) };
};

export default {
  [NOTIFICATION_JOBS.CREATE]: createNotification,
  [NOTIFICATION_JOBS.BROADCAST]: broadcastNotification,
  [NOTIFICATION_JOBS.EMERGENCY]: emergencyBroadcast,
};
