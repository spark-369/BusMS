import { NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Public liveness probe.
 *
 * Deliberately separate from `/api/health`:
 *
 *  - `/api/health` is **admin-only** and reports Redis/queue internals, so a
 *    container healthcheck hitting it would always receive a 401 and Docker
 *    would mark the container permanently unhealthy.
 *  - This endpoint performs **no** database, Redis or auth work, so it answers
 *    the only question a liveness probe should ask: "is the HTTP server up?".
 *    Tying container restarts to a dependency (Postgres/Redis) causes restart
 *    storms during an outage that the app is designed to survive.
 *
 * It is intentionally NOT rate limited. A limiter rejection here would surface
 * as a failed healthcheck and Docker would kill a perfectly healthy container.
 * The handler does no work, so there is nothing to protect.
 */
export async function GET() {
  return NextResponse.json(
    { status: 'ok' },
    {
      headers: {
        // Never let a probe response be cached by an intermediary.
        'Cache-Control': 'no-store, max-age=0',
      },
    },
  );
}
