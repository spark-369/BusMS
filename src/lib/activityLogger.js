import prisma from '@/lib/prisma';
import { enqueueActivity } from '@/lib/enqueue';
import { isRedisConfigured } from '@/lib/redis';

/**
 * Writes an audit-trail entry. Never throws — audit logging must never break
 * the primary operation.
 *
 * Delivery path:
 *  - Redis configured  -> the entry is published to the `audit` BullMQ queue and
 *    written by `worker/index.mjs`. The request no longer waits on the INSERT,
 *    and transient database errors are retried with exponential backoff.
 *  - Redis absent      -> executed inline (same handler, same code path), so
 *    audit logging still works with zero infrastructure.
 *
 * Both paths swallow errors. Note that with Redis configured but no worker
 * running, entries queue up instead of being written — `GET /api/health`
 * exposes the queue depth so this misconfiguration is visible.
 *
 * @param {object} params
 * @param {string} params.userId  - ID of the user performing the action
 * @param {string} params.action  - short action code, e.g. "CREATE_BUS"
 * @param {string} [params.details] - human readable description
 * @param {object} [params.req]   - optional NextRequest for ip/user-agent
 */
export const logActivity = async ({ userId, action, details, req }) => {
  try {
    if (!userId || !action) return;

    await enqueueActivity({ userId, action, details, req });
  } catch (error) {
    // Swallow — an audit failure must not fail the request.
    console.error('logActivity failed:', error);
  }
};

/**
 * Direct (un-brokered) write. Retained so callers that must guarantee the row
 * exists before responding — and the inline fallback path — have a synchronous
 * option. Prefer `logActivity`.
 */
export const writeActivityDirect = async ({ userId, action, details, req }) => {
  try {
    if (!userId || !action) return;

    let ipAddress = null;
    let userAgent = null;

    if (req?.headers) {
      ipAddress =
        req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
        req.headers.get('x-real-ip') ||
        null;
      userAgent = req.headers.get('user-agent') || null;
    }

    await prisma.activityLog.create({
      data: {
        userId,
        action,
        details: details || null,
        ipAddress,
        userAgent,
      },
    });
  } catch (error) {
    console.error('writeActivityDirect failed:', error);
  }
};

/** True when audit entries are being brokered through BullMQ rather than written inline. */
export const isAuditQueued = () => isRedisConfigured();

export default logActivity;

