# syntax=docker/dockerfile:1

# ---------------------------------------------------------------------------
# University Bus Scheduling Management System
#
# One image, two roles:
#   - default command  -> the Next.js web server (`node server.js`)
#   - `npm run worker` -> the BullMQ worker consuming the Redis queues
#
# Deploying the worker as a second container from this same image guarantees the
# worker and the API always run identical code and identical job handlers, which
# would not be true if they were built separately.
#
# Build:  docker build -t bus-scheduling .
# Run:    docker run -p 3000:3000 --env-file .env bus-scheduling
# Worker: docker run --env-file .env bus-scheduling npm run worker
# ---------------------------------------------------------------------------

# ---------------------------------------------------------------------------
# Stage 1 — dependencies
# Installed separately so the (slow, rarely-changing) dependency layer is cached
# and not invalidated by source edits.
# ---------------------------------------------------------------------------
FROM node:20-bookworm-slim AS deps

WORKDIR /app

# openssl is required by the Prisma query engine.
RUN apt-get update -y \
  && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# Copy only the manifests so this layer is reused unless dependencies change.
COPY package.json package-lock.json ./

# `npm ci` respects the lockfile exactly (reproducible builds). Its `postinstall`
# hook runs `prisma generate`, which reads `env("DATABASE_URL")` from the schema —
# a syntactically valid placeholder is required for that to resolve. No
# connection is made, and no real secret is baked into a layer.
COPY prisma ./prisma
ENV DATABASE_URL="postgresql://build:build@localhost:5432/build"
RUN npm ci

# ---------------------------------------------------------------------------
# Stage 2 — builder
# ---------------------------------------------------------------------------
FROM node:20-bookworm-slim AS builder

WORKDIR /app

RUN apt-get update -y \
  && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*

COPY --from=deps /app/node_modules ./node_modules
COPY . .

# `next build` requires a syntactically valid DATABASE_URL to construct the
# Prisma client, but it never connects. A dummy value keeps the build hermetic
# (no secrets baked into an image layer) and is overridden at runtime.
ENV NEXT_TELEMETRY_DISABLED=1
ENV DATABASE_URL="postgresql://build:build@localhost:5432/build"
ENV JWT_SECRET="build-time-placeholder-overridden-at-runtime"

RUN npm run build

# ---------------------------------------------------------------------------
# Stage 3 — runner
# ---------------------------------------------------------------------------
FROM node:20-bookworm-slim AS runner

WORKDIR /app

RUN apt-get update -y \
  && apt-get install -y --no-install-recommends openssl ca-certificates curl \
  && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

# Run as a non-root user. `node` (uid 1000) already exists in the base image.
RUN groupadd --system --gid 1001 nodejs \
  && useradd --system --uid 1001 --gid nodejs nextjs

# `output: "standalone"` emits a minimal server plus only the node_modules it
# actually requires — far smaller than copying the whole dependency tree.
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --from=builder --chown=nextjs:nodejs /app/public ./public

# The worker is NOT part of the Next.js build output, so it is copied explicitly
# along with the shared job handlers and the Prisma schema/migrations.
COPY --from=builder --chown=nextjs:nodejs /app/worker ./worker
COPY --from=builder --chown=nextjs:nodejs /app/src/lib/jobs ./src/lib/jobs
COPY --from=builder --chown=nextjs:nodejs /app/prisma ./prisma
COPY --from=builder --chown=nextjs:nodejs /app/package.json ./package.json

# The standalone bundle ships a *pruned* node_modules that excludes dev-only and
# worker-only packages. bullmq + @prisma/client are needed by the worker at
# runtime, so they are layered on top. Prisma's generated client lives in
# node_modules/.prisma and must be carried over too.
COPY --from=deps --chown=nextjs:nodejs /app/node_modules/bullmq ./node_modules/bullmq
COPY --from=deps --chown=nextjs:nodejs /app/node_modules/ioredis ./node_modules/ioredis
COPY --from=deps --chown=nextjs:nodejs /app/node_modules/@prisma ./node_modules/@prisma
COPY --from=deps --chown=nextjs:nodejs /app/node_modules/.prisma ./node_modules/.prisma

USER nextjs

EXPOSE 3000

# Liveness probe against the PUBLIC liveness endpoint.
#
# It must not point at `/api/health`: that route is admin-only and returns 401 to
# an unauthenticated probe, so `curl -f` would fail and Docker would mark the
# container unhealthy forever.
#
# 127.0.0.1 is used rather than localhost to avoid resolving to ::1 where the
# server binds IPv4 only.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD curl -fsS http://127.0.0.1:3000/api/health/live > /dev/null || exit 1

# `server.js` is generated by `output: "standalone"`.
CMD ["node", "server.js"]
