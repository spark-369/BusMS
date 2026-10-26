/**
 * Standalone BullMQ worker.
 *
 * Run with:  npm run worker
 *
 * Why a separate process?
 * -----------------------
 * BullMQ workers are long-lived: they hold a blocking Redis connection and
 * poll for jobs continuously. That is fundamentally incompatible with Next.js
 * serverless functions (which freeze between invocations) and with `next dev`
 * hot reloading. Hosting the worker outside the Next.js process is the only
 * correct deployment shape, and it is what this file exists for.
 *
 * Deployment options:
 *   - A long-lived container/VM:      `node worker/index.mjs`
 *   - A second service on Render/Railway/Fly.io (same `REDIS_URL`)
 *   - Locally, alongside `npm run dev`
 *
 * The API never *requires* this process to be running: `src/lib/queue.js`
 * executes jobs inline when Redis is unconfigured or an enqueue fails, so a
 * missing worker degrades to synchronous side effects rather than losing them.
 *
 * Prisma is imported directly here (plain Node, CommonJS-friendly) and injected
 * into the job handlers, which keeps the handlers free of path aliases so they
 * can be shared with the bundled Next.js runtime.
 */

import { Worker, QueueEvents } from 'bullmq';
import { PrismaClient } from '@prisma/client';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import notificationHandlers, {
  NOTIFICATION_JOBS,
} from '../src/lib/jobs/notification.jobs.mjs';
import auditHandlers, { AUDIT_JOBS } from '../src/lib/jobs/audit.jobs.mjs';

/**
 * Minimal `.env` loader.
 *
 * Plain Node does not read `.env` (only the Next.js runtime does), so without
 * this the worker would not see `REDIS_URL` or `DATABASE_URL` when started with
 * `npm run worker`. `node --env-file` exists but requires Node 20.6+, and this
 * project supports Node 18.18+.
 *
 * Existing `process.env` values always win, so an explicit shell export or a
 * platform-injected variable (Docker/Render/Railway) is never overwritten.
 */
const loadDotEnv = () => {
  const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const envPath = resolve(projectRoot, '.env');

  if (!existsSync(envPath)) return;

  for (const rawLine of readFileSync(envPath, 'utf8').split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    const separator = line.indexOf('=');
    if (separator === -1) continue;

    const key = line.slice(0, separator).trim();
    if (!key || key in process.env) continue;

    let value = line.slice(separator + 1).trim();

    // Strip one layer of matching quotes, then unescape \" / \n.
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length > 1) ||
      (value.startsWith("'") && value.endsWith("'") && value.length > 1)
    ) {
      value = value.slice(1, -1);
    }

    process.env[key] = value.replace(/\\n/g, '\n').replace(/\\"/g, '"');
  }
};

loadDotEnv();

const REDIS_URL = process.env.REDIS_URL;

if (!REDIS_URL) {
  console.error(
    '[worker] REDIS_URL is not set. Nothing to consume — the API is running in\n' +
      '         inline-fallback mode, so notifications and audit logs are written\n' +
      '         synchronously inside the request. Set REDIS_URL to enable the queue.',
  );
  process.exit(0);
}

const QUEUE_NAMES = {
  NOTIFICATIONS: 'notifications',
  AUDIT: 'audit',
};

const HANDLERS = {
  [QUEUE_NAMES.NOTIFICATIONS]: notificationHandlers,
  [QUEUE_NAMES.AUDIT]: auditHandlers,
};

// A dedicated Prisma client: the worker has its own lifecycle and must not share
// a connection pool with a Next.js server process.
const prisma = new PrismaClient({ log: ['error'] });

const connection = { url: REDIS_URL, maxRetriesPerRequest: null };
const workers = [];
const queueEvents = [];

const log = (message, meta = '') => {
  console.log(`[worker] ${message}`, meta);
};

/**
 * Build one Worker per queue. `autorun` defaults to true; concurrency is kept
 * modest because the jobs are short database writes.
 */
const startQueue = (queueName, concurrency) => {
  const worker = new Worker(
    queueName,
    async (job) => {
      const handler = HANDLERS[queueName]?.[job.name];

      if (typeof handler !== 'function') {
        throw new Error(`No handler for "${job.name}" on queue "${queueName}"`);
      }

      return handler({ prisma, data: job.data });
    },
    {
      connection,
      concurrency,
      // Keep the process alive through transient Redis blips.
      lockDuration: 30_000,
      stalledInterval: 30_000,
      maxStalledCount: 2,
    },
  );

  worker.on('completed', (job) => {
    log(`✓ ${queueName}/${job.name} (${job.id})`);
  });

  worker.on('failed', (job, error) => {
    log(`✗ ${queueName}/${job?.name} (${job?.id}) — ${error?.message}`);
  });

  worker.on('error', (error) => {
    log(`connection error on ${queueName} — ${error?.message}`);
  });

  workers.push(worker);

  // QueueEvents exposes aggregate failure/retry signals for logging only.
  const events = new QueueEvents(queueName, { connection });
  events.on('error', (error) => {
    log(`events error on ${queueName} — ${error?.message}`);
  });
  queueEvents.push(events);

  log(`listening on "${queueName}" (concurrency ${concurrency})`);
};

log(`starting with ${Object.keys(HANDLERS).length} queues`);
log(`known jobs: ${[...Object.values(NOTIFICATION_JOBS), ...Object.values(AUDIT_JOBS)].join(', ')}`);

startQueue(QUEUE_NAMES.NOTIFICATIONS, 5);
startQueue(QUEUE_NAMES.AUDIT, 10);

// ---------------------------------------------------------------------------
// Graceful shutdown
// ---------------------------------------------------------------------------
let shuttingDown = false;

const shutdown = async (signal) => {
  if (shuttingDown) return;
  shuttingDown = true;

  log(`${signal} received — draining…`);

  // Close workers first (waits for in-flight jobs), then the event listeners
  // and finally Prisma, so no job can lose its database connection mid-flight.
  await Promise.all(workers.map((worker) => worker.close().catch(() => {})));
  await Promise.all(queueEvents.map((events) => events.close().catch(() => {})));
  await prisma.$disconnect().catch(() => {});

  log('shutdown complete');
  process.exit(0);
};

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

process.on('unhandledRejection', (reason) => {
  log(`unhandled rejection — ${reason?.message || reason}`);
});
