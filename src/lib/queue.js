import { Queue } from 'bullmq';
import {
  createQueueConnection,
  isRedisConfigured,
  isRedisUsable,
} from './redis';

/**
 * BullMQ producers.
 *
 * Design notes
 * ------------
 * 1. **Graceful degradation.** When `REDIS_URL` is absent (e.g. the Vercel
 *    Hobby deployment this repo targets) there is no broker to enqueue into and
 *    no long-lived process to host a worker. Every `enqueue*` helper therefore
 *    falls back to executing the job inline. Behaviour is identical, only the
 *    latency/retry characteristics differ — which keeps the app fully
 *    functional with zero Redis configuration.
 *
 * 2. **Lazy connections.** Queues are created on first use and cached on
 *    `global` so hot reloads and serverless invocations reuse the connection
 *    instead of leaking one per request.
 *
 * 3. **Producers never throw.** A failed enqueue degrades to inline execution
 *    rather than failing the user's request. Notification delivery is a side
 *    effect; losing it must not fail a booking.
 *
 * The worker that consumes these queues lives in `worker/index.mjs` and is
 * started with `npm run worker`.
 */

const globalForQueue = global;

export const QUEUE_NAMES = {
  NOTIFICATIONS: 'notifications',
  AUDIT: 'audit',
};

export const JOB_NAMES = {
  NOTIFICATION_CREATE: 'notification.create',
  NOTIFICATION_BROADCAST: 'notification.broadcast',
  NOTIFICATION_EMERGENCY: 'notification.emergency',
  AUDIT_LOG: 'audit.log',
};

// Retry/retention defaults. Notifications are user-visible so they get more
// attempts; the backoff is exponential so a database blip does not hammer it.
const DEFAULT_JOB_OPTIONS = {
  attempts: 5,
  backoff: { type: 'exponential', delay: 2_000 },
  removeOnComplete: { age: 3_600, count: 1_000 },
  removeOnFail: { age: 86_400 },
};

/**
 * How long to wait for an enqueue before giving up and running inline.
 *
 * This matters more than it looks. BullMQ *requires* `maxRetriesPerRequest:
 * null` on its connections so blocking commands are not aborted mid-wait. The
 * consequence is that if Redis is configured but unreachable, `queue.add()`
 * never rejects — it waits forever. Without this timeout a Redis outage would
 * hang every mutating API request instead of degrading.
 *
 * Read at call time (not module load) so the value reflects the environment the
 * process actually ended up with.
 */
const getEnqueueTimeoutMs = () =>
  Number.parseInt(process.env.QUEUE_ENQUEUE_TIMEOUT_MS || '', 10) || 2_000;

const withTimeout = (promise, ms, label) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${label} timed out after ${ms}ms`)),
      ms,
    );

    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });

const queues = (globalForQueue.__busQueues = globalForQueue.__busQueues || {});

/**
 * Get (or lazily create) a BullMQ queue.
 * @returns {Queue | null} `null` when Redis is not configured.
 */
export const getQueue = (name) => {
  if (!isRedisConfigured()) return null;

  if (!queues[name]) {
    queues[name] = new Queue(name, {
      connection: createQueueConnection(),
      defaultJobOptions: DEFAULT_JOB_OPTIONS,
    });
  }

  return queues[name];
};

/**
 * Execute a job handler in-process. Shared by the inline fallback and the
 * worker so both paths run identical code.
 *
 * @param {Record<string, Function>} handlers  map of job name -> handler
 * @param {string} name
 * @param {object} data
 * @param {object} ctx  e.g. `{ prisma }`
 */
export const runJobInline = async (handlers, name, data, ctx) => {
  const handler = handlers?.[name];
  if (typeof handler !== 'function') {
    throw new Error(`No handler registered for job "${name}"`);
  }
  return handler({ ...ctx, data });
};

/**
 * Enqueue a job, falling back to inline execution when BullMQ is unavailable.
 *
 * @param {string} queueName
 * @param {string} jobName
 * @param {object} data
 * @param {{ handlers: Record<string, Function>, ctx: object, options?: object }} config
 * @returns {Promise<{ mode: 'queued'|'inline', id?: string, result?: any }>}
 */
export const enqueueJob = async (queueName, jobName, data, config = {}) => {
  const { handlers, ctx, options } = config;

  // Skip the broker entirely while the shared circuit breaker is open. Without
  // this, every write during a Redis outage would still pay ENQUEUE_TIMEOUT_MS
  // before falling back to inline execution.
  const queue = isRedisUsable() ? getQueue(queueName) : null;

  if (queue) {
    try {
      const job = await withTimeout(
        queue.add(jobName, data, options),
        getEnqueueTimeoutMs(),
        `enqueue ${jobName}`,
      );
      return { mode: 'queued', id: job.id };
    } catch (error) {
      // Broker unreachable or too slow: do not drop the work, and do not let
      // the request hang on BullMQ's infinite retry.
      console.error(`[queue] failed to enqueue ${jobName}:`, error?.message);
    }
  }

  if (!handlers) {
    // No fallback available — the caller only wanted a best-effort enqueue.
    return { mode: 'inline', skipped: true };
  }

  const result = await runJobInline(handlers, jobName, data, ctx);
  return { mode: 'inline', result };
};

/** Aggregate counts for diagnostics (`/api/health`). */
export const queueStatus = async () => {
  if (!isRedisConfigured()) {
    return { configured: false, queues: {} };
  }

  const entries = await Promise.all(
    Object.values(QUEUE_NAMES).map(async (name) => {
      try {
        const queue = getQueue(name);
        const counts = await queue.getJobCounts(
          'waiting',
          'active',
          'completed',
          'failed',
          'delayed',
        );
        return [name, counts];
      } catch (error) {
        return [name, { error: error?.message || 'unavailable' }];
      }
    }),
  );

  return { configured: true, queues: Object.fromEntries(entries) };
};

/** Close every queue (used by scripts/tests to allow a clean exit). */
export const closeQueues = async () => {
  await Promise.all(
    Object.values(queues).map((queue) => queue.close().catch(() => {})),
  );
};

export default enqueueJob;
