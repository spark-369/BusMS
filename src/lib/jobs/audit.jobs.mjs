/**
 * Audit-log job processor.
 *
 * `logActivity` already swallows its own errors so an audit failure can never
 * break a request. Running it through the queue additionally means the request
 * path no longer waits on the `INSERT`, and transient database errors are
 * retried with backoff instead of being dropped.
 *
 * Prisma is injected (see notification.jobs.mjs for why).
 */

export const AUDIT_JOBS = {
  LOG: 'audit.log',
};

export const writeAuditLog = async ({ prisma, data }) => {
  const { userId, action, details, ipAddress, userAgent } = data || {};

  if (!userId || !action) {
    // Nothing to record — treat as a successful no-op rather than a retry loop.
    return { skipped: true };
  }

  const entry = await prisma.activityLog.create({
    data: {
      userId,
      action,
      details: details || null,
      ipAddress: ipAddress || null,
      userAgent: userAgent || null,
    },
  });

  return { id: entry.id };
};

export default {
  [AUDIT_JOBS.LOG]: writeAuditLog,
};
