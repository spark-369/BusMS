import { beforeEach, describe, expect, it, vi } from 'vitest';

// Redis is deliberately left unset: the queue must never construct a client on
// this path, and `queueStatus` must report `configured: false`.
import {
  enqueueJob,
  getQueue,
  JOB_NAMES,
  QUEUE_NAMES,
  queueStatus,
  runJobInline,
} from '@/lib/queue';

const handlers = {
  'test.ok': vi.fn(async ({ data }) => ({ echoed: data.value })),
};

beforeEach(() => {
  delete process.env.REDIS_URL;
  vi.useRealTimers();
  handlers['test.ok'].mockClear();
});

describe('runJobInline', () => {
  it('calls the handler with the injected context and job data', async () => {
    const ctx = { prisma: { marker: true } };
    const result = await runJobInline(handlers, 'test.ok', { value: 7 }, ctx);

    expect(result).toEqual({ echoed: 7 });
    expect(handlers['test.ok']).toHaveBeenCalledWith({
      ...ctx,
      data: { value: 7 },
    });
  });

  it('throws for an unregistered job name', async () => {
    await expect(runJobInline(handlers, 'nope', {}, {})).rejects.toThrow(
      /No handler registered/,
    );
  });

  it('throws when no handlers are supplied at all', async () => {
    await expect(runJobInline(undefined, 'test.ok', {}, {})).rejects.toThrow(
      /No handler registered/,
    );
  });
});

describe('enqueueJob without Redis', () => {
  it('executes the job inline and reports the mode', async () => {
    const result = await enqueueJob(
      QUEUE_NAMES.NOTIFICATIONS,
      'test.ok',
      { value: 1 },
      { handlers, ctx: {} },
    );

    // This is the documented behaviour for a deployment with no Redis add-on:
    // identical outcome, just synchronous.
    expect(result).toEqual({ mode: 'inline', result: { echoed: 1 } });
    expect(handlers['test.ok']).toHaveBeenCalledTimes(1);
  });

  it('skips silently when no fallback handlers were provided', async () => {
    const result = await enqueueJob(QUEUE_NAMES.AUDIT, 'test.ok', {}, {});

    expect(result).toEqual({ mode: 'inline', skipped: true });
    expect(handlers['test.ok']).not.toHaveBeenCalled();
  });

  it('propagates a handler error so the caller can decide', async () => {
    const failing = { 'test.ok': vi.fn().mockRejectedValue(new Error('handler boom')) };

    await expect(
      enqueueJob(QUEUE_NAMES.AUDIT, 'test.ok', {}, { handlers: failing, ctx: {} }),
    ).rejects.toThrow('handler boom');
  });
});

describe('queue/job name constants', () => {
  it('uses distinct queue names', () => {
    expect(QUEUE_NAMES.NOTIFICATIONS).not.toBe(QUEUE_NAMES.AUDIT);
  });

  it('namespaces job names by concern', () => {
    expect(JOB_NAMES.NOTIFICATION_CREATE.startsWith('notification.')).toBe(true);
    expect(JOB_NAMES.AUDIT_LOG.startsWith('audit.')).toBe(true);
  });
});

describe('getQueue without Redis', () => {
  it('returns null instead of constructing a client', () => {
    expect(getQueue(QUEUE_NAMES.NOTIFICATIONS)).toBeNull();
    expect(getQueue('anything')).toBeNull();
  });
});

describe('queueStatus without Redis', () => {
  it('reports configured: false so /api/health shows the inline mode', async () => {
    expect(await queueStatus()).toEqual({ configured: false, queues: {} });
  });
});
