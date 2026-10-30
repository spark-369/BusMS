import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  actAs,
  adminUser,
  apiRequest,
  passengerUser,
  primeSideEffects,
} from '../helpers/routeHarness';

vi.mock('@/lib/prisma', async () => {
  const { createPrismaMock } = await import('../helpers/prismaMock');
  return { default: createPrismaMock() };
});

delete process.env.REDIS_URL;

let prisma;
let getFeedback;
let createFeedback;

beforeAll(async () => {
  prisma = (await import('@/lib/prisma')).default;
  ({ GET: getFeedback, POST: createFeedback } = await import(
    '@/app/api/feedback/route'
  ));
});

const admin = adminUser();
const passenger = passengerUser();

const get = (query = '', user = admin) =>
  getFeedback(apiRequest(`/feedback${query}`, { user }));
/** Feedback is submitted by the acting user, so the token and the DB row must agree. */
const post = (body, user = passenger) => {
  actAs(prisma, user);
  return createFeedback(apiRequest('/feedback', { method: 'POST', user, body }));
};

beforeEach(() => {
  vi.clearAllMocks();
  actAs(prisma, admin);
  primeSideEffects(prisma);
});

describe('GET /api/feedback', () => {
  it('requires authentication', async () => {
    const response = await getFeedback(apiRequest('/feedback'));

    expect(response.status).toBe(401);
    expect(prisma.feedback.findMany).not.toHaveBeenCalled();
  });

  it('scopes a passenger to their own feedback', async () => {
    actAs(prisma, passenger);
    prisma.feedback.findMany.mockResolvedValue([]);

    await get('', passenger);

    expect(prisma.feedback.findMany.mock.calls.at(-1)[0].where).toEqual({
      userId: 'passenger-1',
    });
  });

  it('lets an admin read all feedback and filter by trip', async () => {
    prisma.feedback.findMany.mockResolvedValue([]);

    await get('?tripId=trip-1');

    // An admin is not scoped by userId; only the trip filter applies.
    expect(prisma.feedback.findMany.mock.calls.at(-1)[0].where).toEqual({
      tripId: 'trip-1',
    });
  });

  it('computes the average rating and guards the empty case', async () => {
    prisma.feedback.findMany.mockResolvedValue([
      { id: 'f1', rating: 5 },
      { id: 'f2', rating: 3 },
    ]);

    const body = await (await get()).json();
    expect(body.averageRating).toBe(4);

    // 0 feedback must report 0, not NaN.
    prisma.feedback.findMany.mockResolvedValue([]);
    const empty = await (await get('?tripId=none')).json();
    expect(empty.averageRating).toBe(0);
  });

  it('orders feedback newest first', async () => {
    prisma.feedback.findMany.mockResolvedValue([]);

    await get();

    expect(prisma.feedback.findMany.mock.calls.at(-1)[0].orderBy).toEqual({
      createdAt: 'desc',
    });
  });
});

describe('POST /api/feedback', () => {
  it('restricts submission to admins and passengers', async () => {
    actAs(prisma, adminUser({ id: 'driver-1', role: 'DRIVER' }));

    const response = await createFeedback(
      apiRequest('/feedback', {
        method: 'POST',
        user: adminUser({ id: 'driver-1', role: 'DRIVER' }),
        body: { rating: 5 },
      }),
    );

    expect(response.status).toBe(403);
    expect(prisma.feedback.create).not.toHaveBeenCalled();
  });

  it('requires a rating between 1 and 5', async () => {
    expect((await post({ rating: 0 })).status).toBe(400);
    expect((await post({ rating: 6 })).status).toBe(400);

    const response = await post({ rating: 6 });
    expect((await response.json()).error).toMatch(/between 1 and 5/i);
  });

  it('returns 404 when the referenced trip does not exist', async () => {
    prisma.trip.findUnique.mockResolvedValue(null);

    const response = await post({ rating: 4, tripId: 'missing' });

    expect(response.status).toBe(404);
    expect((await response.json()).error).toMatch(/trip not found/i);
  });

  it('rejects a second submission for the same trip', async () => {
    prisma.trip.findUnique.mockResolvedValue({ id: 'trip-1' });
    prisma.feedback.findFirst.mockResolvedValue({ id: 'f1' });

    const response = await post({ rating: 4, tripId: 'trip-1' });

    expect(response.status).toBe(400);
    expect((await response.json()).error).toMatch(/already provided feedback/i);
    expect(prisma.feedback.create).not.toHaveBeenCalled();
  });

  it('stores the feedback, notifies admins and audits it', async () => {
    prisma.trip.findUnique.mockResolvedValue({ id: 'trip-1' });
    prisma.feedback.findFirst.mockResolvedValue(null);
    prisma.feedback.create.mockResolvedValue({ id: 'f9', rating: 5 });

    const response = await post({ rating: 5, comment: 'Great ride', tripId: 'trip-1' });
    const body = await response.json();

    expect(response.status).toBe(201);
    expect(body.message).toMatch(/submitted successfully/i);

    const { data } = prisma.feedback.create.mock.calls[0][0];
    expect(data.userId).toBe('passenger-1');
    expect(data.rating).toBe(5);
    expect(data.tripId).toBe('trip-1');

    const notification = prisma.notification.create.mock.calls.at(-1)[0].data;
    expect(notification.userRole).toBe('ADMIN');
    expect(notification.type).toBe('FEEDBACK_RECEIVED');

    const log = prisma.activityLog.create.mock.calls.at(-1)[0].data;
    expect(log.action).toBe('SUBMIT_FEEDBACK');
  });

  it('accepts feedback without a trip', async () => {
    prisma.feedback.findFirst.mockResolvedValue(null);
    prisma.feedback.create.mockResolvedValue({ id: 'f9', rating: 3 });

    const response = await post({ rating: 3 });

    expect(response.status).toBe(201);
    // No trip id means no existence check is needed.
    expect(prisma.trip.findUnique).not.toHaveBeenCalled();
  });

  it('returns 500 when the database throws', async () => {
    prisma.feedback.findFirst.mockRejectedValue(new Error('connection lost'));

    expect((await post({ rating: 4 })).status).toBe(500);
  });
});
