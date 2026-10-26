import { describe, expect, it } from 'vitest';

import { GET as getLiveness } from '@/app/api/health/live/route';

/**
 * The liveness endpoint exists purely so the Docker HEALTHCHECK has something
 * that works without credentials. These tests pin the properties that make it
 * suitable for that job.
 */
describe('GET /api/health/live', () => {
  it('returns 200 with an ok status', async () => {
    const response = await getLiveness();

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'ok' });
  });

  it('does not require authentication', async () => {
    // A probe cannot send a bearer token, so requiring auth here would make
    // every container report unhealthy.
    const response = await getLiveness(new Request('http://localhost/api/health/live'));
    expect(response.status).toBe(200);
  });

  it('touches no dependency, so it cannot fail during a Redis or DB outage', async () => {
    // No prisma mock is installed for this suite. If the handler imported or
    // called Prisma (or Redis), this would throw instead of returning 200.
    const response = await getLiveness();
    expect(response.status).toBe(200);
  });

  it('is not cacheable, so a probe never reads a stale 200', async () => {
    const response = await getLiveness();
    expect(response.headers.get('Cache-Control')).toContain('no-store');
  });
});
