import { beforeEach, describe, expect, it, vi } from 'vitest';

// `vi.hoisted` is required: `vi.mock` factories are hoisted above the imports
// below, so a factory referencing a plain module-scope const would throw
// "Cannot access 'addMock' before initialization".
const { addMock } = vi.hoisted(() => ({ addMock: vi.fn() }));

/**
 * Queue behaviour with Redis present.
 *
 * BullMQ is mocked at the module boundary rather than emulated: the goal is to
 * verify *our* wrapper (timeout, fallback, circuit-breaker pre-check), not
 * BullMQ itself.
 */
vi.mock('bullmq', () => ({
  Queue: class {
    constructor(name, options) {
      this.name = name;
      this.options = options;
      this.add = addMock;
    }

    async getJobCounts() {
      return { waiting: 2, active: 1, completed: 5, failed: 0, delayed: 0 };
    }

    async close() {}
  },
}));

vi.mock('ioredis', () => ({
  default: class {
    constructor() {
      this.status = 'ready';
    }

    on() {
      return this;
    }
  },
}));

process.env.REDIS_URL = 'redis://fake:6379';
process.env.QUEUE_ENQUEUE_TIMEOUT_MS = '50';

const { enqueueJob, getQueue, QUEUE_NAMES, queueStatus } = await import('@/lib/queue');
const { recordRedisFailure } = await import('@/lib/redis');

const handlers = {
  'test.ok': vi.fn(async ({ data }) => ({ echoed: data.value })),
};

beforeEach(() => {
  addMock.mockReset();
  handlers['test.ok'].mockClear();
});

describe('enqueueJob with Redis', () => {
  it('publishes the job and reports mode "queued"', async () => {
    addMock.mockResolvedValue({ id: 'job-1' });

    const result = await enqueueJob(
      QUEUE_NAMES.NOTIFICATIONS,
      'test.ok',
      { value: 3 },
      { handlers, ctx: {} },
    );

    expect(result).toEqual({ mode: 'queued', id: 'job-1' });
    expect(addMock).toHaveBeenCalledWith('test.ok', { value: 3 }, undefined);
    // The handler must NOT have run — the worker owns execution.
    expect(handlers['test.ok']).not.toHaveBeenCalled();
  });

  it('passes per-job options through to BullMQ', async () => {
    addMock.mockResolvedValue({ id: 'job-2' });
    const options = { delay: 5_000 };

    await enqueueJob(QUEUE_NAMES.AUDIT, 'test.ok', {}, { handlers, ctx: {}, options });

    expect(addMock).toHaveBeenCalledWith('test.ok', {}, options);
  });

  it('falls back to inline execution when the enqueue rejects', async () => {
    addMock.mockRejectedValue(new Error('redis unreachable'));

    const result = await enqueueJob(
      QUEUE_NAMES.NOTIFICATIONS,
      'test.ok',
      { value: 9 },
      { handlers, ctx: {} },
    );

    // The work must not be dropped just because the broker refused it.
    expect(result).toEqual({ mode: 'inline', result: { echoed: 9 } });
    expect(handlers['test.ok']).toHaveBeenCalledTimes(1);
  });

  it('times out a hanging enqueue and falls back to inline execution', async () => {
    vi.useFakeTimers();

    // BullMQ connections require `maxRetriesPerRequest: null`, so `add()` never
    // rejects when Redis is unreachable — it waits forever. Without the timeout
    // this would hang the HTTP request; that is the behaviour under test.
    addMock.mockImplementation(() => new Promise(() => {}));

    const promise = enqueueJob(
      QUEUE_NAMES.NOTIFICATIONS,
      'test.ok',
      { value: 11 },
      { handlers, ctx: {} },
    );

    await vi.advanceTimersByTimeAsync(60);

    const result = await promise;
    expect(result).toEqual({ mode: 'inline', result: { echoed: 11 } });
    expect(handlers['test.ok']).toHaveBeenCalledTimes(1);
  });

  it('skips the broker entirely once the circuit breaker is open', async () => {
    // Trip the shared breaker.
    recordRedisFailure(new Error('e1'));
    recordRedisFailure(new Error('e2'));
    recordRedisFailure(new Error('e3'));

    const result = await enqueueJob(
      QUEUE_NAMES.NOTIFICATIONS,
      'test.ok',
      { value: 5 },
      { handlers, ctx: {} },
    );

    // No timeout penalty: the enqueue was never attempted.
    expect(addMock).not.toHaveBeenCalled();
    expect(result).toEqual({ mode: 'inline', result: { echoed: 5 } });
  });
});

describe('getQueue', () => {
  it('reuses a single Queue instance per name', () => {
    const first = getQueue(QUEUE_NAMES.NOTIFICATIONS);
    const second = getQueue(QUEUE_NAMES.NOTIFICATIONS);

    expect(first).toBe(second);
  });

  it('creates distinct queues for distinct names', () => {
    expect(getQueue(QUEUE_NAMES.NOTIFICATIONS)).not.toBe(getQueue(QUEUE_NAMES.AUDIT));
  });

  it('returns null when Redis is not configured', () => {
    const saved = process.env.REDIS_URL;
    delete process.env.REDIS_URL;

    expect(getQueue('anything')).toBeNull();

    process.env.REDIS_URL = saved;
  });
});

describe('queueStatus', () => {
  it('reports counts for every queue when configured', async () => {
    const status = await queueStatus();

    expect(status.configured).toBe(true);
    expect(status.queues[QUEUE_NAMES.NOTIFICATIONS].waiting).toBe(2);
    expect(status.queues[QUEUE_NAMES.AUDIT].completed).toBe(5);
  });

  it('reports configured: false when Redis is absent', async () => {
    const saved = process.env.REDIS_URL;
    delete process.env.REDIS_URL;

    expect(await queueStatus()).toEqual({ configured: false, queues: {} });

    process.env.REDIS_URL = saved;
  });
});
