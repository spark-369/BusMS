import prisma from '@/lib/prisma';
import { enqueueJob, JOB_NAMES, QUEUE_NAMES } from '@/lib/queue';
import notificationHandlers, {
  NOTIFICATION_JOBS,
} from '@/lib/jobs/notification.jobs.mjs';
import auditHandlers, { AUDIT_JOBS } from '@/lib/jobs/audit.jobs.mjs';

/**
 * Thin, intent-revealing facade over the BullMQ producers.
 *
 * Route handlers call these instead of touching queues directly, so the
 * `handlers` + `ctx` wiring (needed for the inline fallback) lives in exactly
 * one place. Both helpers resolve to the same shape regardless of whether the
 * work was queued or run inline, and neither rejects on a delivery problem —
 * notification and audit side effects must never fail the primary request.
 */

/**
 * Queue (or inline-run) a single role-targeted notification.
 * @param {{ userRole: string, type: string, title: string, message: string, link?: string }} data
 */
export const enqueueNotification = async (data) => {
  try {
    return await enqueueJob(
      QUEUE_NAMES.NOTIFICATIONS,
      JOB_NAMES.NOTIFICATION_CREATE,
      data,
      { handlers: notificationHandlers, ctx: { prisma } },
    );
  } catch (error) {
    console.error('enqueueNotification failed:', error?.message || error);
    return { mode: 'inline', skipped: true };
  }
};

/**
 * Queue (or inline-run) a notification fanned out to several roles.
 * @param {{ roles?: string[], type: string, title: string, message: string, link?: string }} data
 */
export const enqueueBroadcast = async (data) => {
  try {
    return await enqueueJob(
      QUEUE_NAMES.NOTIFICATIONS,
      JOB_NAMES.NOTIFICATION_BROADCAST,
      data,
      { handlers: notificationHandlers, ctx: { prisma } },
    );
  } catch (error) {
    console.error('enqueueBroadcast failed:', error?.message || error);
    return { mode: 'inline', skipped: true };
  }
};

/**
 * Queue (or inline-run) an emergency broadcast, including its audit record.
 * @param {{ message: string, userId?: string }} data
 */
export const enqueueEmergencyBroadcast = async (data) => {
  try {
    return await enqueueJob(
      QUEUE_NAMES.NOTIFICATIONS,
      JOB_NAMES.NOTIFICATION_EMERGENCY,
      data,
      { handlers: notificationHandlers, ctx: { prisma } },
    );
  } catch (error) {
    console.error('enqueueEmergencyBroadcast failed:', error?.message || error);
    return { mode: 'inline', skipped: true };
  }
};

/**
 * Queue (or inline-run) an audit-trail entry.
 * @param {{ userId?: string, action: string, details?: string, req?: Request }} params
 */
export const enqueueActivity = async ({ userId, action, details, req }) => {
  if (!userId || !action) return { mode: 'inline', skipped: true };

  let ipAddress = null;
  let userAgent = null;

  if (req?.headers) {
    ipAddress =
      req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
      req.headers.get('x-real-ip') ||
      null;
    userAgent = req.headers.get('user-agent') || null;
  }

  try {
    return await enqueueJob(
      QUEUE_NAMES.AUDIT,
      JOB_NAMES.AUDIT_LOG,
      { userId, action, details: details || null, ipAddress, userAgent },
      { handlers: auditHandlers, ctx: { prisma } },
    );
  } catch (error) {
    console.error('enqueueActivity failed:', error?.message || error);
    return { mode: 'inline', skipped: true };
  }
};

export { NOTIFICATION_JOBS, AUDIT_JOBS };
