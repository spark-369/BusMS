import { NextResponse } from 'next/server';
import { authMiddleware } from '@/middleware/auth';
import { cacheStatus } from '@/lib/cache';
import { queueStatus } from '@/lib/queue';
import { rateLimiterStatus } from '@/lib/rateLimiter';
import { redisStatus } from '@/lib/redis';
import { isAuditQueued } from '@/lib/activityLogger';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Infrastructure health (Admin only).
 *
 * Reports the state of each optional subsystem so a misconfiguration is
 * visible instead of silent. The most important signal is
 * `queue.deliveryMode`:
 *
 *   - `brokered` : Redis is configured, jobs go to BullMQ. Requires
 *                  `npm run worker` to be running somewhere.
 *   - `inline`   : no Redis; jobs run inside the request. Fully functional.
 *
 * A `queues.*.waiting` count that keeps climbing with `deliveryMode: brokered`
 * means the API is publishing but no worker is consuming.
 */
export async function GET(req) {
  const authResult = await authMiddleware(req, ['ADMIN']);

  if (authResult instanceof NextResponse) {
    return authResult;
  }

  try {
    const redis = redisStatus();
    const queues = await queueStatus();

    const waiting = Object.values(queues.queues || {}).reduce(
      (total, counts) => total + (counts?.waiting || 0) + (counts?.delayed || 0),
      0,
    );

    return NextResponse.json({
      status: 'ok',
      timestamp: new Date().toISOString(),
      redis,
      cache: cacheStatus(),
      rateLimiter: rateLimiterStatus(),
      queue: {
        ...queues,
        deliveryMode: queues.configured ? 'brokered' : 'inline',
        pendingJobs: waiting,
        workerRequired: queues.configured,
        workerHint: queues.configured
          ? 'Run `npm run worker` (or deploy worker/index.mjs as a separate service).'
          : 'No worker needed — jobs execute inline in the request.',
      },
      audit: {
        mode: isAuditQueued() ? 'brokered' : 'inline',
      },
    });
  } catch (error) {
    console.error('Health check error:', error);
    return NextResponse.json(
      { error: 'Failed to gather health information' },
      { status: 500 },
    );
  }
}
