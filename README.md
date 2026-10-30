# BusMS - University Bus Scheduling Management System

A full-stack **campus bus operations platform** built with Next.js 14 (App Router),
Prisma/PostgreSQL and a Redis-optional background job pipeline. It covers the
complete lifecycle of a university shuttle service: fleet and driver management,
route and stop authoring, timetable scheduling, trip dispatch, seat booking,
QR-code based digital bus passes, boarding/attendance capture, maintenance
tracking, notifications, feedback, reporting and an audit trail.

> **Design principle — zero-infrastructure by default.**
> Every optional dependency (Redis) is *additive*. With nothing but a PostgreSQL
> connection the application is fully functional: the response cache, the rate
> limiter and the job queue all transparently fall back to in-process
> implementations. Configuring `REDIS_URL` upgrades those layers to
> Redis-backed / brokered behaviour without any code change.

---

## Table of contents

- [Features](#features)
- [Tech stack](#tech-stack)
- [Architecture](#architecture)
- [Getting started](#getting-started)
- [Environment variables](#environment-variables)
- [npm scripts](#npm-scripts)
- [Project structure](#project-structure)
- [Data model](#data-model)
- [API reference](#api-reference)
- [Infrastructure layers](#infrastructure-layers)
- [Security model](#security-model)
- [Testing](#testing)
- [Deployment](#deployment)
- [Operations and troubleshooting](#operations-and-troubleshooting)
- [Coding conventions](#coding-conventions)
- [License](#license)

---

## Features

### Administrator

| Area | Capability |
| --- | --- |
| **Dashboard** | Aggregate counts (users, buses, routes, schedules, trips, active buses, available drivers, today's trips, pending bookings, unread notifications), recent trips, upcoming schedules, maintenance alerts. |
| **Fleet** | CRUD for buses (number, plate, capacity, model, year, fuel type, mileage, status). |
| **Routes & stops** | CRUD for routes (distance, estimated duration) and geo-located stops (lat/lng, address, order) with a map-based location picker. |
| **Schedules** | CRUD for timetables (`MORNING` / `NOON` / `EVENING` / `SPECIAL`), days-of-week arrays, special dates and notes. |
| **Trips** | Dispatch a trip from a schedule, monitor status (`SCHEDULED → IN_PROGRESS → COMPLETED/CANCELLED`), edit or delete. |
| **Bookings** | View all bookings, update or delete any booking. |
| **Users** | Create/update/deactivate/delete users; assign roles and role-specific identifiers (passenger ID / driving licence). |
| **Assignments** | Assign a driver to a bus, unassign, and see the pool of unassigned drivers. Enforces one-driver-per-bus and one-bus-per-driver. |
| **Bus passes** | Issue digital passes (auto-generated pass number + QR data URL), extend/deactivate, delete. |
| **Boarding** | Verify a pass QR code to mark today's bookings as attended. |
| **Maintenance** | Log `ROUTINE` / `REPAIR` / `BREAKDOWN` / `INSPECTION` work orders; a repair/breakdown flips the bus to `MAINTENANCE`, completion flips it back to `ACTIVE` and stamps `lastMaintenance`. |
| **Notifications** | Role-targeted notifications and organisation-wide broadcasts; emergency broadcast from the dashboard. |
| **Reports** | Daily summary + attendance rate, bus usage, driver performance, fuel-consumption estimate, overview. |
| **Audit trail** | Paginated activity log with filters (user, action, date range). |
| **Feedback** | Read all passenger feedback. |

### Driver

- Driver dashboard, own trips (start / complete / cancel).
- Passenger bookings for assigned trips.
- **Verify bus passes** by scanning a QR code with the device camera or entering the pass number manually.
- Routes, schedules, tracking map and notifications.

### Passenger

- Passenger dashboard, trip list, live tracking map, routes and timetables.
- **Book a seat** on a trip at a chosen stop (atomic seat allocation, duplicate-booking guard).
- View / cancel own bookings; QR-coded booking confirmation.
- Personal digital bus pass with QR code.
- Submit trip feedback (1–5 stars + comment).
- Notifications and profile management.

---

## Tech stack

| Layer | Technology | Notes |
| --- | --- | --- |
| Framework | **Next.js 14** (App Router, JavaScript) | `output: "standalone"` for container builds |
| UI | **React 18**, **Tailwind CSS v4** (`@tailwindcss/postcss`) | Dark-mode-only design system in `globals.css` |
| Icons | `react-icons` (Feather set) | |
| Maps | `leaflet` + `react-leaflet` | Dynamically imported with `ssr: false` |
| QR | `qrcode` (server-side data URL), `html5-qrcode` (client scanner) | |
| HTTP client | `axios` | Single instance with request/response interceptors |
| Database | **PostgreSQL** via **Prisma 6** | `prisma-client-js`, multi-platform binary targets |
| Auth | `jsonwebtoken` (JWT), `bcryptjs` (12 rounds) | Bearer-token auth, re-validated against the DB per request |
| Jobs | **BullMQ 5** + `ioredis` | Optional; degrades to inline execution |
| Dates | `date-fns` + local-day helpers | |
| IDs | `uuid`, Prisma `cuid()` | |
| Tests | **Vitest 2**, `@vitest/coverage-v8`, `jsdom` | Native ESM, so `.mjs` workers are testable |
| Lint | `eslint` + `eslint-config-next` (`next/core-web-vitals`) | |
| Runtime | Node.js **≥ 18.18.0** | |

---


## Architecture

```
┌──────────────────────────────────────────────────────────────────────────┐
│  Browser (React 18 client components)                                    │
│                                                                          │
│  src/app/**/page.js ──► src/context/{Auth,App}Context ──► src/services/*  │
│            │                                              (axios +        │
│            └── src/components/{ui,layout,map,QRVerifier}   interceptors)  │
└───────────────────────────────────┬──────────────────────────────────────┘
                                    │  fetch  /api/*
┌───────────────────────────────────▼──────────────────────────────────────┐
│  Next.js Route Handlers  (src/app/api/**/route.js, runtime = 'nodejs')    │
│                                                                          │
│   authMiddleware  ──►  enforceRateLimit  ──►  withCache  ──►  Prisma      │
│   (JWT + DB)           (Redis|memory)        (Redis|memory)               │
│                                    │                                     │
│                                    └──► logActivity / enqueue*            │
└───────────────────────────────────┬──────────────────────────────────────┘
                          ┌─────────┴──────────┐
                          ▼                    ▼
                ┌──────────────────┐  ┌────────────────────────────┐
                │ BullMQ (Redis)   │  │ Inline fallback            │
                │ notifications Q  │  │ same job handlers, run     │
                │ audit Q          │  │ synchronously in-request   │
                └────────┬─────────┘  └────────────────────────────┘
                         ▼
                ┌──────────────────┐
                │ worker/index.mjs │  ──►  Prisma  ──►  PostgreSQL
                └──────────────────┘
```

### Request lifecycle

Every API route follows the same five-step contract:

1. **`authMiddleware(req, roles)`** — parses the `Bearer` token, verifies it,
   loads the user, rejects inactive accounts and wrong roles. Returns either
   `{ user }` or a ready-to-return `NextResponse` (401/403). Route code always
   checks `if (authResult instanceof NextResponse) return authResult;`.
2. **`enforceRateLimit(req, POLICY, { user })`** — returns `null` when allowed or
   a `429` response when not.
3. **`withCache(namespace, suffix, producer)`** — cache-aside read. The producer
   only runs on a miss. The result carries `X-Cache` / `X-Cache-Source` headers.
4. **Prisma query / mutation**, followed by `invalidate(...)` on every namespace
   whose data the write affects (including `DASHBOARD` and `REPORTS`).
5. **Side effects** — `logActivity()` for the audit trail and `enqueue*()` for
   notifications. Both are best-effort and never fail the request.

### Why the worker is a separate process

BullMQ workers hold a **blocking** Redis connection and poll continuously, which
is incompatible with serverless functions that freeze between invocations and
with `next dev` hot reloading. `worker/index.mjs` is therefore a standalone Node
entrypoint (`npm run worker`). It imports the *same* job handler modules as the
web app, so brokered and inline execution can never diverge.

### Job handlers are dependency-injected

`src/lib/jobs/*.jobs.mjs` are plain ESM modules with **no imports of their own**;
Prisma is injected as `{ prisma }`. This lets the exact same file be consumed by
the bundled Next.js runtime (where `@/lib/prisma` resolves) and by plain Node in
the worker (no bundler, no path aliases).


## Getting started

### Prerequisites

- **Node.js ≥ 18.18.0** (Node 20 recommended; the Docker image uses `node:20-bookworm-slim`)
- **PostgreSQL 13+** (a free Neon / Supabase / Railway instance works)
- *Optional:* **Redis 6+** — only needed for brokered jobs, a shared cache and
  cross-instance rate limiting
- *Optional:* **Docker** for container builds

### 1. Install dependencies

```bash
cd my-app
npm install
```

`postinstall` runs `prisma generate`, which needs a *syntactically valid*
`DATABASE_URL` in the environment (no connection is made). Create `.env` first
(step 2) or export a placeholder.

### 2. Create `.env`

```bash
cat > .env <<'EOF'
# --- Required -------------------------------------------------------------
DATABASE_URL="postgresql://user:password@localhost:5432/bus_scheduling?schema=public"
JWT_SECRET="replace-with-a-long-random-string"
EOF
```

See [Environment variables](#environment-variables) for the full list.

### 3. Apply the database schema

```bash
npm run prisma:migrate     # prisma migrate deploy  (recommended, reproducible)
# or, during early prototyping:
npm run prisma:push        # prisma db push
```

Inspect data with `npm run prisma:studio`.

### 4. Create the first administrator

Public registration is deliberately restricted to `PASSENGER` and `DRIVER`
(`PUBLIC_REGISTER_ROLES`), so the first admin must be inserted directly:

```bash
node -e "
const bcrypt = require('bcryptjs');
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
(async () => {
  await prisma.user.create({
    data: {
      email: 'admin@campus.edu',
      password: await bcrypt.hash('ChangeMe123!', 12),
      name: 'System Administrator',
      role: 'ADMIN',
    },
  });
  console.log('admin created');
  await prisma.\$disconnect();
})();
"
```

> Change the password immediately after first login. The bcrypt cost factor is
> **12** everywhere (`/api/auth/register`, `/api/users`, and the snippet above).

### 5. Run

```bash
npm run dev        # http://localhost:3000
```

Optional, in a second terminal (only when `REDIS_URL` is set):

```bash
npm run worker
```

### 6. Production build

```bash
npm run build      # prisma generate && next build
npm start          # next start
```

---

## Environment variables

All variables are read from `process.env`. Variables described as **lazy** are
resolved at call time rather than module load, so platform/container injection is
always picked up and `next build` can safely import the module.

| Variable | Required | Default | Purpose |
| --- | --- | --- | --- |
| `DATABASE_URL` | **Yes** | — | PostgreSQL connection string used by Prisma (`env("DATABASE_URL")` in `prisma/schema.prisma`). |
| `JWT_SECRET` | **Yes in production** | dev-only fallback | Signs and verifies session tokens. In `NODE_ENV=production` a missing value throws on first use — fail fast rather than issue forgeable tokens. |
| `JWT_EXPIRES_IN` | No | `7d` | Token lifetime (any `jsonwebtoken` duration string). |
| `REDIS_URL` | No | *unset* | Enables the Redis-backed cache + rate limiter and the BullMQ queues. **Unset = fully functional degraded mode.** |
| `REDIS_DEBUG` | No | `false` | Set to `'true'` to log Redis connection errors. |
| `CACHE_TTL_SECONDS` | No | `60` | Fallback TTL for namespaces without an explicit TTL. |
| `CACHE_MEMORY_MAX_ENTRIES` | No | `500` | Upper bound on the in-process fallback cache (FIFO eviction). |
| `QUEUE_ENQUEUE_TIMEOUT_MS` | No | `2000` | How long to wait for `queue.add()` before falling back to inline execution. |
| `NEXT_PUBLIC_API_URL` | No | `''` (same origin) | Only set this if the API lives on a different origin than the UI. |
| `NODE_ENV` | No | — | `production` tightens JWT handling and disables the Prisma global cache. |

Build-time-only variables baked into the Docker image and overridden at runtime:
`DATABASE_URL`, `JWT_SECRET`, `NEXT_TELEMETRY_DISABLED`, `PORT`, `HOSTNAME`.

---

## npm scripts

| Script | Command | Description |
| --- | --- | --- |
| `npm run dev` | `next dev` | Development server with hot reload. |
| `npm run build` | `prisma generate && next build` | Production build (emits `.next/standalone`). |
| `npm run vercel-build` | `prisma generate && prisma migrate deploy && next build` | Build hook used by Vercel; applies pending migrations before building. |
| `npm start` | `next start` | Serve the production build. |
| `npm run worker` | `node worker/index.mjs` | Start the BullMQ worker (exits cleanly if `REDIS_URL` is unset). |
| `npm run lint` | `next lint` | ESLint with `next/core-web-vitals`. |
| `npm test` | `vitest run` | Full suite, single run. |
| `npm run test:watch` | `vitest` | Watch mode. |
| `npm run test:unit` | `vitest run tests/unit` | Unit suites only. |
| `npm run test:e2e` | `vitest run tests/e2e` | Route-handler (integration) suites only. |
| `npm run test:coverage` | `vitest run --coverage` | Coverage report (`text`, `html`, `lcov` → `./coverage`). |
| `postinstall` | `prisma generate` | Runs automatically after `npm install`. |
| `npm run prisma:generate` | `prisma generate` | Regenerate the Prisma client. |
| `npm run prisma:push` | `prisma db push` | Sync schema without a migration file. |
| `npm run prisma:migrate` | `prisma migrate deploy` | Apply committed migrations. |
| `npm run prisma:studio` | `prisma studio` | Visual database browser. |

---


## Project structure

```
my-app/
├── prisma/
│   ├── schema.prisma                 # Models, enums, generator + datasource
│   └── migrations/                   # Ordered SQL migrations
├── public/                           # Static assets served at /
├── src/
│   ├── app/
│   │   ├── api/                      # Route handlers (the REST API)
│   │   │   ├── activity-logs/route.js
│   │   │   ├── assignments/route.js
│   │   │   ├── auth/{login,register,me}/route.js
│   │   │   ├── bookings/{route.js,[id]/route.js}
│   │   │   ├── buses/{route.js,[id]/route.js}
│   │   │   ├── buspass/route.js
│   │   │   ├── dashboard/route.js
│   │   │   ├── feedback/route.js
│   │   │   ├── health/{route.js,live/route.js}
│   │   │   ├── maintenance/route.js
│   │   │   ├── notifications/route.js
│   │   │   ├── reports/route.js
│   │   │   ├── routes/{route.js,[id]/route.js}
│   │   │   ├── schedules/{route.js,[id]/route.js}
│   │   │   ├── stops/{route.js,[id]/route.js}
│   │   │   ├── trips/{route.js,[id]/route.js}
│   │   │   └── users/{route.js,[id]/route.js}
│   │   ├── activity-logs/page.js     # Admin audit-trail viewer
│   │   ├── assignments/page.js       # Admin driver↔bus assignment
│   │   ├── bookings/page.js          # Bookings (create/cancel/manage)
│   │   ├── buses/page.js             # Fleet CRUD
│   │   ├── buspass/page.js           # Passes + QR verification
│   │   ├── dashboard/page.js         # Role-aware dashboard
│   │   ├── feedback/page.js          # Feedback list + submit
│   │   ├── login/page.js             # Sign in
│   │   ├── maintenance/page.js       # Work orders
│   │   ├── notifications/page.js     # Notification centre
│   │   ├── profile/page.js           # Own profile
│   │   ├── register/page.js          # Self-registration
│   │   ├── reports/page.js           # Analytics
│   │   ├── routes/page.js            # Route CRUD
│   │   ├── schedules/page.js         # Timetable CRUD
│   │   ├── stops/page.js             # Stop CRUD (map picker)
│   │   ├── tracking/page.js          # Live map
│   │   ├── trips/page.js             # Trip dispatch + driver controls
│   │   ├── users/page.js             # User administration
│   │   ├── layout.js                 # Root layout, fonts, metadata
│   │   ├── providers.js              # AuthProvider + AppProvider
│   │   ├── page.js                   # Public landing page
│   │   ├── loading.js / error.js / not-found.js
│   │   └── globals.css               # Tailwind v4 + design tokens
│   ├── components/
│   │   ├── layout/{DashboardLayout,Navbar,Sidebar}.js
│   │   ├── map/{MapView,LocationPicker}.js
│   │   ├── ui/{Button,Input,Select,Card,Modal,Badge,Alert,LoadingSpinner}.js
│   │   ├── ui/index.js               # Barrel export
│   │   └── QRVerifier.js             # Camera QR scanner
│   ├── context/{AuthContext,AppContext}.js
│   ├── hooks/useRateLimit.js
│   ├── lib/
│   │   ├── prisma.js                 # Singleton PrismaClient
│   │   ├── redis.js                  # Shared Redis + circuit breaker
│   │   ├── cache.js                  # Versioned response cache
│   │   ├── rateLimiter.js            # Lua fixed/sliding windows + fallback
│   │   ├── queue.js                  # BullMQ producers + inline fallback
│   │   ├── enqueue.js                # Intent-revealing job facade
│   │   ├── activityLogger.js         # Audit-trail writer
│   │   └── jobs/{notification,audit}.jobs.mjs
│   ├── middleware/auth.js            # authMiddleware / optionalAuth
│   ├── services/                     # One module per resource (axios)
│   │   ├── client.js                 # Axios instance + interceptors
│   │   └── {auth,bus,route,stop,schedule,trip,booking,busPass,user,
│   │        notification,feedback,maintenance,report,dashboard,
│   │        activityLog,assignment}Service.js
│   └── utils/{jwt,dates,clientRateLimit}.js
├── tests/
│   ├── setup.js                      # Global env, console silencers, reset hooks
│   ├── helpers/{prismaMock,fakeRedis,routeHarness}.js
│   ├── unit/                         # cache, queue, redis, rateLimiter, dates,
│   │                                 # jobs, enqueue, clientRateLimit, coverage
│   └── e2e/                          # one suite per API resource + auth, health,
│                                     # cacheRoutes, attendance (see Testing)
├── worker/index.mjs                  # Standalone BullMQ worker
├── Dockerfile                        # 3-stage build (deps → builder → runner)
├── vercel.json                       # Build command, region, function limits
├── next.config.mjs                   # standalone output, externals, webpack
├── postcss.config.mjs                # Tailwind v4 via PostCSS
├── vitest.config.mjs                 # ESM test runner config
├── jsconfig.json                     # `@/*` → `./src/*` alias
├── .eslintrc.json                    # next/core-web-vitals
└── package.json
```


## Data model

Schema source of truth: [`prisma/schema.prisma`](prisma/schema.prisma).
Provider: **PostgreSQL**. Primary keys are Prisma `cuid()` strings.

### Enums

| Enum | Values |
| --- | --- |
| `UserRole` | `ADMIN`, `DRIVER`, `PASSENGER` |
| `BusStatus` | `ACTIVE`, `MAINTENANCE`, `INACTIVE` |
| `ScheduleType` | `MORNING`, `NOON`, `EVENING`, `SPECIAL` |
| `BookingStatus` | `PENDING`, `CONFIRMED`, `CANCELLED`, `COMPLETED` |
| `MaintenanceStatus` | `SCHEDULED`, `IN_PROGRESS`, `COMPLETED` |
| `MaintenanceType` | `ROUTINE`, `REPAIR`, `BREAKDOWN`, `INSPECTION` |
| `NotificationType` | `SCHEDULE_CHANGE`, `DELAY`, `EMERGENCY`, `BUS_ARRIVING`, `BOOKING_CONFIRMATION`, `BUS_PASS_CREATED`, `MAINTENANCE_CREATED`, `ROUTE_CREATED`, `TRIP_STARTED`, `FEEDBACK_RECEIVED`, `STOP_CREATED`, `TRIP_SCHEDULED` |

> A migration (`20261009120000_rename_student_to_passenger`) renamed the
> historical `STUDENT` enum value and the `studentId` columns to `PASSENGER` /
> `passengerId`. The domain term throughout the codebase is **passenger**.

### Models

**`User`** — every actor in the system (admins, drivers, passengers share one table).

| Field | Type | Notes |
| --- | --- | --- |
| `id` | `String` | `@id @default(cuid())` |
| `email` | `String` | `@unique` |
| `password` | `String` | bcrypt hash, cost 12 |
| `name`, `phone` | `String`, `String?` | |
| `role` | `UserRole` | |
| `passengerId` | `String?` | `@unique` — required for passengers |
| `licenseNumber` | `String?` | required for drivers |
| `isActive` | `Boolean` | `@default(true)` — deactivated users are rejected by `authMiddleware` |
| `createdAt` / `updatedAt` | `DateTime` | |

Relations: `bookings[]`, `feedbacks[]`, `activityLogs[]`, `busPass?`, `bus?`
(the bus this user drives — one-to-one), `trips[]`.

**`Bus`** — `busNumber` (`@unique`), `plateNumber` (`@unique`), `capacity`,
`model?`, `year?`, `status`, `lastMaintenance?`, `fuelType` (`@default("DIESEL")`),
`mileage` (`@default(0)`), plus `driver?`/`driverId` (`@unique` — a driver may be
assigned to at most one bus). Relations: `schedules[]`, `bookings[]`, `trips[]`,
`maintenance[]`.

**`Route`** — `name`, `description?`, `isActive`, `estimatedDuration` (minutes),
`distance` (km). Relations: `stops[]`, `schedules[]`, `trips[]`.

**`Stop`** — `name`, `latitude`, `longitude`, `address?`, `order`, `isActive`;
belongs to one `Route`.

**`Schedule`** — a recurring timetable entry: `routeId`, `busId`, `scheduleType`,
`departureTime`, `arrivalTime`, `daysOfWeek` (`String[]`, e.g.
`["MON","TUE"]`), `isActive`, `isSpecial`, `specialDate?`, `notes?`.
Relations: `trips[]`.

**`Trip`** — an actual run of a schedule: `scheduleId`, `busId`, `routeId`,
`driverId`, `startTime`, `endTime?`, `status` (`String`, default
`"SCHEDULED"`; also `IN_PROGRESS`, `COMPLETED`, `CANCELLED`),
`actualStartTime?`, `actualEndTime?`. Relations: `bookings[]`, `feedbacks[]`.

**`Booking`** — `userId`, `busId`, `stopId`, `tripId?`, `bookingDate`,
`status` (`BookingStatus`, default `PENDING`), `seatNumber?`,
`qrCode?` (`@unique`, PNG data URL), `qrCodeData?` (raw UUID payload),
`isUsed` (`@default(false)` — set to `true` when a driver verifies the pass).

**`BusPass`** — `passengerId` (`@unique`), `passNumber` (`@unique`),
`startDate`, `endDate`, `isActive`, `qrCode?` (`@unique`).

**`Maintenance`** — `busId`, `type`, `status`, `description`,
`scheduledDate`, `completedDate?`, `cost?`, `notes?`.

**`Notification`** — role-targeted, **not** per-user: `userRole` (string),
`link`, `type`, `title`, `message`, `isRead`, `sentAt`. A broadcast writes one
row per role inside a single transaction.

**`Feedback`** — `userId`, `tripId?`, `rating` (1–5), `comment?`.

**`ActivityLog`** — audit trail: `userId`, `action` (e.g. `CREATE_BUS`,
`LOGIN`, `VERIFY_BUS_PASS`, `EMERGENCY_BROADCAST`), `details?`, `ipAddress?`,
`userAgent?`, `createdAt`.

### Migration history

| Migration | Change |
| --- | --- |
| `20260216080149_init_db` | Initial schema (with `Driver`/`Student` profile tables, `Attendance`, `BusLocation`, `StopTime`, `TripStop`, `FuelRecord`). |
| `20260217061752_update_trips` | Unique index on `Trip.driverId`. |
| `20260217062128_init_db` | Unique index on `Trip.busId`. |
| `20260217124914_init_db` | Collapses the profile tables into `User`; drops `Attendance`, `BusLocation`, `BusRoute`, `Driver`, `FuelRecord`, `StopTime`, `Student`, `TripStop`. |
| `20261008154716_bus_db` | Adds new `NotificationType` values; makes `Notification` role-targeted (`userRole` + `link`, drops `userId`/`stopId`); widens `Booking.seatNumber` to `TEXT`; drops the `Trip` unique indexes. |
| `20261009120000_rename_student_to_passenger` | `STUDENT` → `PASSENGER` enum value; `studentId` → `passengerId` columns/indexes/FKs. |

---

## API reference

Base URL: same origin, path prefix `/api`. All endpoints (except `auth/login`,
`auth/register` and `health/live`) require:

```
Authorization: Bearer <jwt>
Content-Type: application/json
```

Routes export `runtime = 'nodejs'` and `dynamic = 'force-dynamic'`, so every
response is computed per request and never statically cached by Next.js.

### Standard response shapes

| Situation | Status | Body |
| --- | --- | --- |
| Success (read) | `200` | resource payload (often wrapped, e.g. `{ buses: [...] }`) |
| Created | `201` | `{ message, <resource> }` |
| Validation error | `400` | `{ error: "…" }` |
| Missing/invalid token | `401` | `{ error: "No token provided" }` / `{ error: "Invalid or expired token" }` |
| Wrong role | `403` | `{ error: "Access denied. Insufficient permissions." }` |
| Deactivated account | `403` | `{ error: "Account is deactivated" }` |
| Not found | `404` | `{ error: "… not found" }` |
| Duplicate/conflict | `400` / `409` | `{ error: "…" }` |
| Rate limited | `429` | `{ error, code: "RATE_LIMITED", retryAfter, limit }` |
| Server error | `500` | `{ error: "Failed to …" }` |

Rate-limited responses also carry `RateLimit-Limit`, `RateLimit-Remaining`,
`RateLimit-Reset`, `X-RateLimit-Limit`, `X-RateLimit-Remaining`,
`X-RateLimit-Policy` and (when blocked) `Retry-After`.
Cached reads carry `X-Cache: HIT|MISS` and, on a hit, `X-Cache-Source`.

### Auth — `/api/auth`

| Method | Path | Roles | Body / query | Notes |
| --- | --- | --- | --- | --- |
| `POST` | `/api/auth/login` | public | `{ email, password }` | Sliding-window `LOGIN` limit applied **per IP and per email**. Returns `{ message, token, user }` (password stripped). Writes a `LOGIN` audit entry. |
| `POST` | `/api/auth/register` | public | `{ email, password, name, phone?, role?, passengerId?, licenseNumber? }` | `role` defaults to `PASSENGER`; only `PASSENGER`/`DRIVER` accepted (`PUBLIC_REGISTER_ROLES`). Password ≥ 6 chars. `passengerId` required for passengers, `licenseNumber` for drivers. Returns `{ message, token, user }`. |
| `GET` | `/api/auth/me` | all | — | Re-validates the stored token and returns the fresh user. Used on app bootstrap to detect expired tokens and deactivated accounts. |

### Users — `/api/users`

| Method | Path | Roles | Notes |
| --- | --- | --- | --- |
| `GET` | `/api/users` | `ADMIN` | Query: `role`, `isActive`. Password never selected. |
| `POST` | `/api/users` | `ADMIN` | Body: `{ email, password, name, phone?, role?, passengerId?, licenseNumber? }`. Role defaults to `PASSENGER`; bcrypt cost 12. |
| `GET` | `/api/users/:id` | all | |
| `PUT` | `/api/users/:id` | all | A non-admin may only update **their own** profile (`403` otherwise). Updatable: `name`, `phone`, `password`, `passengerId`, `licenseNumber`. |
| `DELETE` | `/api/users/:id` | `ADMIN` | **Soft delete** — sets `isActive: false`, writes `DEACTIVATE_USER`. |

### Buses — `/api/buses`

| Method | Path | Roles | Notes |
| --- | --- | --- | --- |
| `GET` | `/api/buses` | all | Cached (`buses`, TTL 30 s). Query: `status`. |
| `POST` | `/api/buses` | `ADMIN` | Body: `{ busNumber, plateNumber, capacity, model?, year?, fuelType?, mileage? }`. |
| `GET` | `/api/buses/:id` | all | Cached by `id:<id>`; includes driver, schedules, maintenance. |
| `PUT` | `/api/buses/:id` | `ADMIN` | Partial update; invalidates `BUSES`, `DASHBOARD`. |
| `DELETE` | `/api/buses/:id` | `ADMIN` | |

### Routes & stops — `/api/routes`, `/api/stops`

| Method | Path | Roles | Notes |
| --- | --- | --- | --- |
| `GET` | `/api/routes` | all | Cached; includes stops ordered by `order`. |
| `POST` | `/api/routes` | `ADMIN` | Body: `{ name, description?, estimatedDuration, distance, stops? }`. Notifies passengers (`ROUTE_CREATED`). |
| `GET` `PUT` `DELETE` | `/api/routes/:id` | `GET` all, writes `ADMIN` | |
| `GET` | `/api/stops` | all | Query: `routeId`. Cached. |
| `POST` | `/api/stops` | `ADMIN` | Body: `{ name, latitude, longitude, address?, order?, routeId }`. Lat/lng must parse as finite numbers; route must exist. Notifies passengers (`STOP_CREATED`). |
| `GET` `PUT` `DELETE` | `/api/stops/:id` | `GET` all, writes `ADMIN` | Mutations invalidate `STOPS` **and** `ROUTES` (route detail embeds stops). |

### Schedules — `/api/schedules`

| Method | Path | Roles | Notes |
| --- | --- | --- | --- |
| `GET` | `/api/schedules` | all | Query: `routeId`, `busId`, `scheduleType`, `isActive`, `isSpecial`. Ordered by `departureTime`. |
| `POST` | `/api/schedules` | `ADMIN` | Body: `{ routeId, busId, scheduleType, departureTime, arrivalTime, daysOfWeek[], isSpecial?, specialDate?, notes?, stopTimes? }`. Verifies route **and** bus exist. Notifies passengers (`SCHEDULE_CHANGE`). |
| `GET` `PUT` `DELETE` | `/api/schedules/:id` | `GET` all, writes `ADMIN` | Mutations invalidate `SCHEDULES`, `BUSES`, `DASHBOARD`. |

### Trips — `/api/trips`

| Method | Path | Roles | Notes |
| --- | --- | --- | --- |
| `GET` | `/api/trips` | all | Cached (TTL **15 s**). Query: `routeId`, `busId`, `date`. |
| `POST` | `/api/trips` | `ADMIN`, `DRIVER` | Body: `{ scheduleId }`. Derives route/bus from the schedule, uses now as `startTime`, adds the schedule's duration for `endTime`, sets `status: "SCHEDULED"`, assigns the caller as driver when they are an active `DRIVER`. Notifies `TRIP_SCHEDULED`. |
| `GET` | `/api/trips/:id` | all | |
| `PUT` | `/api/trips/:id` | `ADMIN`, `DRIVER` | Body: `{ status }`. A driver may only change **their own** trip (`403` otherwise). Valid statuses: `SCHEDULED`, `IN_PROGRESS`, `COMPLETED`, `CANCELLED`. `COMPLETED`/`CANCELLED` are **terminal** — further changes are rejected with `400`. `IN_PROGRESS` stamps `actualStartTime`; `COMPLETED` stamps `endTime` + `actualEndTime`. |
| `DELETE` | `/api/trips/:id` | `ADMIN` | |

### Bookings — `/api/bookings`

| Method | Path | Roles | Notes |
| --- | --- | --- | --- |
| `GET` | `/api/bookings` | all | Passengers are **always** scoped to their own rows (`where.userId = user.id`); admins and drivers see every booking and may narrow with `userId`. Query: `status`, `bookingDate` (local-day window), `userId`, `busId`, `isUsed`. |
| `POST` | `/api/bookings` | `ADMIN`, `PASSENGER` | Body: `{ tripId, stopId, bookingDate }`. Uses the stricter `BOOKING_WRITE` policy. `bookingDate` is parsed as **local** midnight. Rejects a stop that does not belong to the trip's route (`400`) and a duplicate active booking for the same trip/day (`409`). Seat allocation + insert run in a **`Serializable`** transaction; a full bus raises `NO_SEATS` → `400 "No seats available for this trip"`. Seat labels are generated as `1A…1D, 2A…`. Generates a QR data URL and notifies drivers (`BOOKING_CONFIRMATION`). |
| `GET` | `/api/bookings/:id` | all | |
| `PUT` | `/api/bookings/:id` | `ADMIN`, `PASSENGER` | A passenger may only modify **their own** booking and may only set `status: "CANCELLED"` (`403` otherwise). Invalidates `REPORTS` + `DASHBOARD`. |
| `DELETE` | `/api/bookings/:id` | `ADMIN` | |

### Bus passes — `/api/buspass`

| Method | Path | Roles | Notes |
| --- | --- | --- | --- |
| `GET` | `/api/buspass` | `ADMIN`, `PASSENGER` | Passengers are scoped to their own pass; admins may filter with `passengerId`. |
| `POST` | `/api/buspass` | `ADMIN` | Body: `{ passengerId, startDate, endDate }`. Target must exist and be a `PASSENGER`; `endDate` must be after `startDate`; an already-active, non-expired pass is a `400`. Generates `BP-<timestamp>-<random>` and a QR data URL. Notifies the passenger (`BUS_PASS_CREATED`). Uses the `BULK_WRITE` policy. |
| `PUT` | `/api/buspass` | `ADMIN`, `DRIVER` | **QR verification / boarding.** Body: `{ qrCode \| passNumber }`. Uses the sliding `QR_VERIFY` policy. Looks up an active, non-expired pass, then marks today's `CONFIRMED`/`COMPLETED` bookings for that passenger as `isUsed: true` (attendance). The day window is `gte: startOfDay(), lt: startOfNextDay()` — deliberately matching the reports read path. Writes `VERIFY_BUS_PASS` and invalidates `REPORTS` + `DASHBOARD`. Returns `{ valid: true, busPass: {...}, attendance: { marked } }`. |
| `PATCH` | `/api/buspass` | `ADMIN` | Body: `{ id, startDate?, endDate?, isActive? }`. |
| `DELETE` | `/api/buspass?id=<id>` | `ADMIN` | |

### Maintenance — `/api/maintenance`

| Method | Path | Roles | Notes |
| --- | --- | --- | --- |
| `GET` | `/api/maintenance` | `ADMIN` | Query: `busId`, `status`, `type`. |
| `POST` | `/api/maintenance` | `ADMIN` | Body: `{ busId, type, description, scheduledDate, cost?, notes? }`. A `REPAIR`/`BREAKDOWN` flips the bus to `MAINTENANCE`. Notifies drivers (`MAINTENANCE_CREATED`). |
| `PUT` | `/api/maintenance` | `ADMIN` | Body: `{ id, status, cost?, notes? }`. `COMPLETED` stamps `completedDate` and returns the bus to `ACTIVE` with a fresh `lastMaintenance`. |
| `DELETE` | `/api/maintenance` | `ADMIN` | |

### Assignments — `/api/assignments`

| Method | Path | Roles | Notes |
| --- | --- | --- | --- |
| `GET` | `/api/assignments` | `ADMIN` | Returns `{ buses, availableDrivers, stats: { totalBuses, assignedBuses, unassignedBuses, availableDrivers } }`. Query: `status`, `search` (bus number, plate, driver name). Cached (30 s). |
| `POST` | `/api/assignments` | `ADMIN` | Body: `{ busId, driverId }`. Rejects an already-assigned bus, an already-assigned driver, a non-driver, and a deactivated driver. Notifies the driver ("Bus Assignment"). |
| `DELETE` | `/api/assignments?busId=<id>` | `ADMIN` | Unassigns the driver from that bus. |

### Notifications — `/api/notifications`

| Method | Path | Roles | Notes |
| --- | --- | --- | --- |
| `GET` | `/api/notifications` | all | Admins see everything; other roles see only their own `userRole` rows. Query: `isRead`, `type`. Returns `{ notifications, unreadCount }`, newest first, max 50. **The role is part of the cache key** (TTL 10 s) so one role can never be served another role's feed. |
| `POST` | `/api/notifications` | `ADMIN` | Body: `{ type, title, message, userRole?, link? }`. With `userRole` → one role-targeted row; without → a broadcast fanning out to all three roles in a single transaction. `type` must be one of the twelve `NotificationType` values. |
| `PUT` | `/api/notifications` | all | Body: `{ notificationIds?, markAllRead?, deleteNotificationIds? }`. |
| `DELETE` | `/api/notifications?id=<id>` | `ADMIN` | With `id` deletes one row; without, deletes all read notifications (cleanup). |

### Dashboard — `/api/dashboard`

| Method | Path | Roles | Notes |
| --- | --- | --- | --- |
| `GET` | `/api/dashboard` | `ADMIN` | ~13 aggregates executed with `Promise.all`, cached for 30 s under `dashboard:admin`. Returns `{ stats, recentTrips, upcomingSchedules, maintenanceAlerts }`. |
| `POST` | `/api/dashboard` | `ADMIN` | **Emergency broadcast.** Body: `{ message, routeId? }`. Uses the tightest policy (`BROADCAST`: 5/min). Fans out to every role and writes an `EMERGENCY_BROADCAST` audit row in the same job. Invalidates `NOTIFICATIONS` + `DASHBOARD`. |

### Feedback — `/api/feedback`

| Method | Path | Roles | Notes |
| --- | --- | --- | --- |
| `GET` | `/api/feedback` | all | Admins see all feedback; others see only their own. Query: `tripId`. Includes author and trip/route summary. |
| `POST` | `/api/feedback` | `ADMIN`, `PASSENGER` | Body: `{ tripId?, rating, comment? }`. `rating` must be 1–5. Notifies admins (`FEEDBACK_RECEIVED`). |

---


### Reports — `/api/reports`

| Method | Path | Roles | Notes |
| --- | --- | --- | --- |
| `GET` | `/api/reports` | `ADMIN` | Uses the tightest read policy (`REPORTS`: 30/min). Cached per query string (60 s). |

`type` selects the report; anything unrecognised returns the overview.

| `type` | Query params | Returns |
| --- | --- | --- |
| `daily-summary` | — | `date` (local key), trip counts (total/completed/cancelled), `trips[]`, and `stats: { total, present, absent, attendanceRate }`. Attendance is derived from bookings dated **today** with status `CONFIRMED`/`COMPLETED`; `isUsed` marks present. `attendanceRate` is guarded against 0/0 (returns `0`, not `NaN`) and rounded to one decimal. |
| `bus-usage` | `startDate?`, `endDate?`, `busId?` | Per-bus `totalTrips` and `totalBookings` via `_count`. |
| `driver-performance` | `startDate?`, `endDate?`, `driverId?` | Per-driver trip counts and availability. |
| `fuel-consumption` | `startDate?`, `endDate?`, `busId?` | Estimated fuel units (`mileage ÷ km-per-unit`) and maintenance cost totals. Ratios: `DIESEL 3.5`, `PETROL 4.0`, `CNG 4.5`, `ELECTRIC 5.5`. |
| *(default)* | — | `overview: { totalUsers, totalBuses, totalRoutes, totalTrips, activeBuses }`. |

### Activity logs — `/api/activity-logs`

| Method | Path | Roles | Notes |
| --- | --- | --- | --- |
| `GET` | `/api/activity-logs` | `ADMIN` | Query: `userId`, `action`, `startDate`, `endDate`, `page` (default 1), `limit` (default 20, clamped to 1–100). Uses the dedicated `ACTIVITY_LOGS` policy because the table grows unbounded. |

### Health

| Method | Path | Auth | Notes |
| --- | --- | --- | --- |
| `GET` | `/api/health` | `ADMIN` | Reports `{ status, timestamp, redis, cache, rateLimiter, queue, audit }`. The key field is `queue.deliveryMode`: `brokered` (Redis configured, worker required) or `inline` (no Redis, jobs run in-request). `queue.pendingJobs` climbing while `brokered` means the API is publishing but nothing is consuming. |
| `GET` | `/api/health/live` | **public** | Liveness probe. No DB, Redis, auth or rate limiting — it only answers "is the HTTP server up?". Deliberately separate from `/api/health`, which is admin-only and would make every container probe fail with `401`. Sends `Cache-Control: no-store`. |

---


## Infrastructure layers

All three layers below are **optional-additive**: they work with Redis and
without it, and the fallback is behaviourally equivalent (minus cross-instance
sharing).

### Redis client — `src/lib/redis.js`

Two deliberately different connection shapes:

| Helper | Role | Options |
| --- | --- | --- |
| `getRedis()` | app client (cache + rate limiting) | `maxRetriesPerRequest: 1`, `commandTimeout: 2000` — **fails fast** so a Redis outage can never hang an API request. |
| `createQueueConnection()` | BullMQ producers/workers | `maxRetriesPerRequest: null` — BullMQ requires this so blocking commands are not aborted mid-wait. |

A **circuit breaker** (3 consecutive failures → 30 s cooldown) skips Redis
entirely during an outage instead of paying a connection timeout on every call.
Importing the module opens **no** connection — clients are constructed lazily, so
a process without `REDIS_URL` never touches the network. `resetRedisState()`,
`isRedisUsable()`, `recordRedisSuccess()` and `recordRedisFailure()` are exported
for callers and tooling.

### Response cache — `src/lib/cache.js`

Cache-aside with **version-counter invalidation** rather than key scanning:

```
bus:cache:<namespace>:<version>:<suffix>
bus:cachever:<namespace>          <- INCR to flush
```

Flushing a namespace is a single atomic `INCR`; stale entries become unreachable
instantly and expire on their own TTL. There is never a `KEYS`/`SCAN` sweep
(which would block Redis) and never an O(n) delete.

| Namespace | TTL (s) | Notes |
| --- | --- | --- |
| `routes` | 60 | |
| `stops` | 60 | |
| `buses` | 30 | |
| `schedules` | 30 | |
| `trips` | 15 | Polled by drivers, changes intraday |
| `dashboard` | 30 | ~13 aggregates, admin-only and shared |
| `reports` | 60 | Heaviest reads |
| `notifications` | 10 | Polled by the navbar; role-scoped key |
| `maintenance` | 60 | |
| `assignments` | 30 | |

Exports: `withCache`, `invalidate(...namespaces)`, `cacheHeaders(result)`,
`searchParamsKey(req)` (sorted, so `?a=1&b=2` and `?b=2&a=1` share an entry),
`cacheStatus()`, `clearCache()`. The in-memory fallback is bounded by
`CACHE_MEMORY_MAX_ENTRIES` (FIFO eviction).

> **Correctness rule for new endpoints:** whenever a write changes data that a
> cached read exposes, invalidate *every* affected namespace — including
> `DASHBOARD` and `REPORTS`, which aggregate across collections.

---


### Rate limiter — `src/lib/rateLimiter.js`

Hand-rolled (no third-party limiter), with two algorithms, both implemented as
atomic Redis **Lua** scripts and mirrored by an in-process fallback:

- **`fixed`** — `INCR` + `PEXPIRE` in one script. One round trip, one counter per
  window. Cheapest; a burst at a window boundary can allow up to 2x the limit.
- **`sliding`** — a sorted-set log trimmed by score. Exact "N per window" with no
  boundary burst, at the cost of one member per request. Used for abuse-sensitive
  endpoints.

Lua is used instead of `MULTI/EXEC` because check-and-increment must be a single
atomic step — reading in Node and writing back would be a TOCTOU race that lets
concurrent requests overshoot the limit.

| Policy | Max / window | Algorithm | Applied to |
| --- | --- | --- | --- |
| `LOGIN` | 10 / 60 s | sliding | `/api/auth/login` (per IP **and** per email) |
| `REGISTER` | 5 / 60 s | sliding | `/api/auth/register` (per IP **and** per email) |
| `REPORTS` | 30 / 60 s | fixed | `/api/reports` |
| `DASHBOARD` | 60 / 60 s | fixed | `/api/dashboard` GET |
| `ACTIVITY_LOGS` | 60 / 60 s | fixed | `/api/activity-logs` |
| `COLLECTION_READ` | 120 / 60 s | fixed | list/detail reads |
| `COLLECTION_WRITE` | 40 / 60 s | fixed | generic mutations |
| `BOOKING_WRITE` | 20 / 60 s | fixed | `/api/bookings` POST |
| `BULK_WRITE` | 15 / 60 s | fixed | bus-pass issue/delete |
| `QR_VERIFY` | 60 / 60 s | sliding | `/api/buspass` PUT (boarding) |
| `BROADCAST` | 5 / 60 s | fixed | emergency broadcast |
| `DEFAULT` | 100 / 60 s | fixed | anything else |

Identity is `user:<id>` when authenticated (falling back to `ip:<addr>`), with an
optional `:<extra>` discriminator. The failure policy is deliberately
**fail-open**: rate limiting is a protection layer, not an authorization check,
so a Redis blip must not become a full outage.

### Client-side mirroring

`src/utils/clientRateLimit.js` + `src/hooks/useRateLimit.js` layer two mechanisms
so the UI defers *before* making a doomed request:

1. **Local token buckets** (`CLIENT_LIMITS`) mirror the server policies but are
   kept *tighter*, protecting against double-clicks and Enter-key spam.
2. **Server-signalled cooldown** — on a `429` the `Retry-After` header is trusted
   and a hard cooldown is installed for that action. This is what actually keeps
   client and server in agreement, since a local bucket cannot know about other
   tabs or devices.

State lives in `sessionStorage`, so a refresh does not clear a cooldown but a new
tab starts clean. `useRateLimit(action)` exposes `isLimited`, `waitLabel`,
`guard()`, `handleError()`, `reset()` and a `1 s` countdown that only ticks while
blocked. The axios instance in `src/services/client.js` consumes tokens
automatically and skips the local bucket for plain reads (`api-read`) so
background polling is never blocked client-side.

### Job queue — `src/lib/queue.js`, `src/lib/enqueue.js`, `worker/index.mjs`

| Queue | Jobs | Concurrency |
| --- | --- | --- |
| `notifications` | `notification.create`, `notification.broadcast`, `notification.emergency` | 5 |
| `audit` | `audit.log` | 10 |

Default job options: `attempts: 5`, exponential backoff starting at `2 s`,
`removeOnComplete: { age: 3600, count: 1000 }`, `removeOnFail: { age: 86400 }`.

- **Producers never throw.** A failed enqueue logs and falls back to running the
  same handler inline, so a notification side effect can never fail a booking.
- **Enqueue timeout** (`QUEUE_ENQUEUE_TIMEOUT_MS`, default 2 s) exists because
  BullMQ requires `maxRetriesPerRequest: null`; without the timeout a *reachable
  but unresponsive* Redis would hang every mutating request forever.
- **Circuit-breaker aware.** When the breaker is open the broker is skipped
  entirely, so writes do not each pay the enqueue timeout before falling back.
- **Audit logging is fire-and-forget** (`logActivity`): it never throws, so an
  audit failure cannot break the primary operation. With Redis configured but no
  worker running, audit rows queue up instead of being written — `/api/health`
  exposes that depth.
- **`enqueueEmergencyBroadcast`** fans out to all roles *and* writes the audit row
  in the same job, so a broadcast can never exist without its audit record. The
  audit write is skipped when `userId` is null (the `ActivityLog.userId` FK would
  otherwise fail).

The worker also handles `SIGINT`/`SIGTERM` with a graceful drain (workers → queue
events → Prisma) and reports `unhandledRejection`. It exits `0` with an
explanatory message when `REDIS_URL` is unset, since the API is already in inline
mode.

### Date helpers — `src/utils/dates.js`

Local-day helpers exist because two easy mistakes silently corrupt attendance:

1. `new Date('2026-02-16')` is parsed as **UTC** midnight, while
   `setHours(0,0,0,0)` operates in **local** time — mixing them shifts a day
   window by one day for any negative-offset timezone.
2. `date.toISOString().split('T')[0]` yields the **UTC** calendar date, which is
   the *previous* day for local times earlier than the UTC offset.

`startOfDay`, `endOfDay`, `startOfNextDay`, `dayRange`, `parseDateOnly` and
`toLocalDateKey` all work in local time, so "today" means the same instant to the
database query, the write path and the rendered label. Use `startOfNextDay()` as
the **exclusive** upper bound (`lt`) — `lte: endOfDay` silently drops anything in
the final millisecond.

---

## Security model

### Authentication

- JWT signed with `JWT_SECRET`, lifetime `JWT_EXPIRES_IN` (default `7d`). Payload:
  `{ userId, email, role }`.
- The secret is resolved **lazily** at call time, not module load, so `next build`
  can import the module for static analysis while a misconfigured production
  deployment still fails fast on the first request rather than issuing tokens
  signed with a development fallback.
- In `NODE_ENV=production` a missing `JWT_SECRET` **throws**; the
  `'your-super-secret-jwt-key-change-in-production'` fallback is used only in
  development/test.
- The token is never trusted alone: `authMiddleware` re-loads the user from the
  database on **every** request and rejects deleted users (`401`) and
  `isActive: false` accounts (`403`). This makes deactivation effective
  immediately instead of when the token expires.

### Authorization

- Role checks are declared per handler via `authMiddleware(req, [...roles])`.
- Ownership is enforced *in addition to* role checks on the resources where it
  matters: passengers may only read/modify their own bookings, feedback, and bus
  pass; drivers may only change trips they are assigned to; non-admins may only
  edit their own user profile.
- `PUBLIC_REGISTER_ROLES = ['PASSENGER', 'DRIVER']` — public self-registration can
  never mint an `ADMIN`.
- Passwords are hashed with bcrypt cost **12** and are never returned: `/api/auth/*`
  strips the field, `/api/users` uses an explicit `select`.

### Rate limiting

See [Rate limiter](#rate-limiter--srclibratelimiterjs). Credential endpoints are
keyed by **IP and email** so one noisy actor cannot exhaust the allowance of
everyone behind a campus NAT, and so credential stuffing against many accounts
from one IP is still capped.

### Transport and headers

- QR verification requires a **secure context** (HTTPS or `localhost`) because
  camera access does. `QRVerifier` detects the absence of `navigator.mediaDevices`
  and shows an actionable message instead of failing silently.
- `X-Forwarded-For` / `X-Real-IP` are used for client identification; deploy
  behind a proxy that sets them.
- `/api/health/live` sets `Cache-Control: no-store` so a probe result is never
  cached by an intermediary.

### Known limitations

- **JWTs cannot be revoked before expiry.** Deactivation works because the user is
  re-read per request, but a role change only takes effect on the next request —
  which is intentional and correct here. There is no refresh-token flow, so the
  client simply re-authenticates when a `401` arrives (the axios interceptor
  clears storage and redirects to `/login`).
- **`next.config.mjs` disables the client Router Cache** (`staleTimes: { dynamic: 0,
  static: 0 }`) so dashboard tabs always fetch fresh data. The trade-off is more
  requests; server-side caching absorbs it.
- **`/api/trips` GET has a 15 s TTL**; a driver who starts a trip may briefly see
  a stale list from another client. Writes invalidate `TRIPS`, `DASHBOARD` and
  `REPORTS` immediately for the instance that performed the write.


## Testing

```bash
npm test               # everything
npm run test:unit      # tests/unit/**
npm run test:e2e       # tests/e2e/**
npm run test:coverage  # + HTML/lcov report in ./coverage
```

The suite runs with **no database and no Redis**. It is designed so that
importing an application module cannot fail or reach a real service.

There are two groups:

- **Unit** (`tests/unit/`) — the infrastructure libraries (cache, Redis, rate
  limiter, queue, job handlers, date helpers, client-side limiter) in isolation.
- **End-to-end** (`tests/e2e/`) — one suite per API resource, plus auth, health,
  cache behaviour and the attendance round trip. Handlers are imported directly
  and driven with real `Request`/`NextResponse` objects; only Prisma is doubled.

Both groups share the same `setupFiles`, so console output is silenced and the
`globalThis` singletons are reset between tests (see below).

### Configuration — `vitest.config.mjs`

| Setting | Value | Why |
| --- | --- | --- |
| `environment` | `node` | Almost everything under test is server-side. Browser-dependent suites opt in per file with `// @vitest-environment jsdom`. |
| `globals` | `true` | `describe`/`it`/`expect` available without imports. |
| `include` | `tests/**/*.test.{js,mjs}` | |
| `setupFiles` | `./tests/setup.js` | |
| `isolate` | `true` | A fresh module registry per file, so the `globalThis` singletons used by redis/cache/rate-limiter (which exist to survive hot reloads) cannot leak state. |
| `coverage.include` | `src/lib/**`, `src/utils/**`, `src/hooks/**`, `worker/**` | `src/lib/jobs/**/*.mjs` is excluded (thin DB shims). |

Vitest was chosen over Jest because the queue layer and the BullMQ worker are
native ESM `.mjs`; Vitest runs ESM natively, so those modules are importable
without transform shims. `restoreMocks` is deliberately **not** enabled — it
would wipe the default `async () => null` behaviour of the Prisma doubles.
Isolation is handled explicitly in `tests/setup.js` instead.

### Global setup — `tests/setup.js`

- `NODE_ENV=test`, `JWT_SECRET`, `JWT_EXPIRES_IN=1h` and a dummy `DATABASE_URL`
  are set because `src/utils/jwt.js` throws in production without a secret and
  `src/lib/prisma.js` skips its hot-reload global cache outside production.
- `REDIS_URL` is **deleted** by default, so the suite exercises the documented
  zero-infrastructure paths unless a test opts in.
- `console.error`, `console.warn` and `console.log` are stubbed at module scope.
  Many suites deliberately drive a handler into its `catch` block (a rejected
  Prisma call) to assert the `500` path; the handler's own log line would
  otherwise flood the report with `stderr` blocks that look like failures but are
  the expected output of a *passing* test. Only the implementation is stubbed, so
  a test can still assert on `console.error.mock.calls` if it needs to.
- `afterEach` calls the reset hooks through `globalThis`
  (`__busCacheReset`, `__busRateLimitReset`, `__busRedisReset`, `delete
  globalThis.__busQueues`) and `vi.clearAllMocks()`. They are called via
  `globalThis` on purpose: importing `@/lib/cache` here would load
  `@/lib/redis` → `ioredis` *before* a test file's `vi.mock('ioredis')` could
  apply, leaving the real client wired up and the fake ignored.

### Helpers

| Helper | Purpose |
| --- | --- |
| `tests/helpers/prismaMock.js` | `createPrismaMock()` returns a Prisma-shaped double covering **every** model with the **complete** delegate surface (`findMany`, `findUnique`, `count`, `create`, `update`, `delete`, `$transaction`, …). Defaults mirror real return *shapes* — `findMany` → `[]`, `count` → `0` — because `null` would make `.filter()` throw and turn arithmetic into `NaN`. Also exports `buildUser()` and `buildAuthUser()`. |
| `tests/helpers/fakeRedis.js` | An in-memory Redis double covering the commands the app uses (`get`, `set`, `incr`, `eval`, sorted sets, TTLs) plus `resetFakeRedis()`. |
| `tests/helpers/routeHarness.js` | Scaffolding shared by the route-handler suites: `apiRequest()` (real `Request` with a signed bearer token + `x-forwarded-for`), `params()` (the `{ params: { id } }` second argument), `actAs()` / `mockUserLookups()` (the auth-middleware `findUnique` double, keyed by id *or* email), `primeSideEffects()` (resolves the inline audit/notification writes), plus `adminUser()` / `driverUser()` / `passengerUser()` and per-model entity fixtures. |

`vi.mock` factories must be **async** and import the helper inside the factory:
`vi.mock` is hoisted above the file's imports, so referencing a module-scope
`const` would hit a temporal-dead-zone error.

### Suites

**Unit** (`tests/unit/`)

| File | Covers |
| --- | --- |
| `cache.test.js` | `withCache` miss/hit, version-bump invalidation (asserts no key sweep), `searchParamsKey` ordering, `cacheHeaders`, `cacheStatus`. |
| `redis.test.js` | Connection management, circuit breaker tripping/reset, cache-over-Redis, Lua fixed + sliding windows reporting `source: 'redis'`. |
| `rateLimiter.test.js` | `getClientIp`, `getRateLimitIdentity`, fixed and sliding memory fallbacks (including exact boundary behaviour and window ageing), headers, the `429` body shape, `enforceRateLimit`, policy definitions (sliding applied to abuse-sensitive endpoints, `BROADCAST < COLLECTION_WRITE`), `rateLimiterStatus`. |
| `queue.test.js` | `runJobInline`, inline fallback with `mode: 'inline'`, distinct queue names, `getQueue`/`queueStatus` returning `null` / `configured: false` without Redis. |
| `queueRedis.test.js` | `enqueueJob` publishing with `mode: 'queued'`, a single `Queue` instance per name, per-queue counts. |
| `jobs.test.js` | Notification create/broadcast/emergency handlers, transaction fan-out, audit write, null-`userId` handling, required-field validation. |
| `enqueue.test.js` | The facade wiring end-to-end with no Redis (real handlers run inline), including IP/user-agent extraction. |
| `dates.test.js` | `startOfDay` / `endOfDay` / `startOfNextDay`, `dayRange`, `parseDateOnly`, `toLocalDateKey` — timezone-independent. |
| `clientRateLimit.test.js` | `formatWait`, `consume`/`peek`/`guard`, `applyServerRateLimit` cooldowns, reset/clearCooldown, and that client limits stay at or below server limits. *(jsdom)* |
| `prismaMockCoverage.test.js` | Parses `prisma/schema.prisma` and asserts the mock covers every model — so a new model cannot silently break the e2e suite. |

**End-to-end / route integration** (`tests/e2e/`) — handlers are imported
directly and driven with real `Request`/`NextResponse` objects. Nothing about
routing, auth, caching, limiting or queueing is stubbed; only the database is.

| File | Covers |
| --- | --- |
| `auth.login.test.js` | Valid login, `401` on wrong password, `403` for a deactivated account, rate-limit headers, blocking on the 11th attempt, no DB hit once blocked, inline audit write, password never returned. |
| `health.test.js` | `/api/health` requires auth, is admin-only, reports `deliveryMode: 'inline'` with no Redis, exposes cache diagnostics, lists policies, ISO timestamp. |
| `healthLive.test.js` | `/api/health/live` returns `200` with `{ status: 'ok' }`, needs no token, no Redis, no DB. |
| `cacheRoutes.test.js` | A second identical `/api/buses` request is served from cache; a write invalidates it; **role-scoped notification cache isolation** (one role never receives another role's feed). |
| `attendance.test.js` | Daily-summary attendance: `0` total and a `0` (not `NaN`) rate with no bookings; `isUsed: true` counts as present; the read query matches the write path's `bookingDate` window; a local-day window covering exactly one day; the report labelled with the **local** date; and the write→read round trip. |
| `auth.register.test.js` | Public sign-up: required fields, email/password shape, the **`ADMIN` privilege-escalation block**, role-specific required fields, duplicate email, hashing, rate-limit headers, the 429 on the 6th attempt, and a 500 on a database error. |
| `auth.me.test.js` | Session probe: no/invalid token → `401`, unknown user → `401`, deactivated account → `403`, and the resolved user for any role (password never returned). |
| `buses.test.js` / `busById.test.js` | Bus CRUD: cache hit/miss + query-string keying, admin-only writes, required/positive-capacity validation, duplicate detection, numeric coercion, audit + cache invalidation, `404`/`500`, and the active-schedule delete guard. |
| `routes.test.js` / `routeById.test.js` | Route CRUD: nested stop creation and ordering, `isActive` filtering, admin-only writes, the **transactional stop replacement**, the `409` when bookings reference those stops, and the soft-delete (`isActive: false`). |
| `stops.test.js` / `stopById.test.js` | Stop CRUD: route filtering, ordered reads, coordinate range validation, route-existence check, auto-incrementing `order`, the delete→deactivate fallback when bookings reference the stop, and a regression guard that `PUT` flushes both `STOPS` and `ROUTES`. |
| `schedules.test.js` / `scheduleById.test.js` | Schedule CRUD: every query filter, time-only→`Date` conversion, enum fallback to `MORNING`, route/bus existence checks, passenger notification, and the soft-delete. |
| `trips.test.js` / `tripById.test.js` | Trip CRUD: single-day date window, schedule-derived route/bus/driver, status transition rules (terminal states, driver ownership), completion timestamps, and the in-progress delete guard. |
| `bookings.test.js` / `bookingById.test.js` | Bookings: passenger rows scoped to the caller, local-day duplicate check, seat allocation inside a `Serializable` transaction, `NO_SEATS`, QR generation, and passenger-only cancel/ownership rules. |
| `users.test.js` / `userById.test.js` | User directory and profiles: admin-only listing with an explicit `select` (no password), the id-vs-email `findUnique` discrimination, bcrypt hashing, profile ownership rules, and the soft-delete. |
| `notifications.test.js` | Full notification CRUD: role-scoped feeds and unread counts, per-role cache isolation, admin-only send, type validation, the 3-role broadcast fan-out, role-scoped mark-read/delete, and cleanup of read rows. |
| `buspass.test.js` | Bus passes: passenger self-scoping, issuance rules (role check, date range, one active pass), QR verification → attendance marking, and admin `PATCH`/`DELETE`. |
| `maintenance.test.js` | Maintenance register: admin-only reads, type/date validation, bus status flip to `MAINTENANCE` on repair/breakdown, completion returning the bus to `ACTIVE`, and deletion. |
| `reports.test.js` | Report types: default overview, `bus-usage`, `fuel-consumption` (incl. the 0-denominator guard), `driver-performance`, per-type cache keys, and admin-only access. |
| `dashboard.test.js` | Dashboard aggregates, active-driver scoping, 30 s caching, and the emergency broadcast (admin-only, message required, 3-role fan-out, `BROADCAST` rate cap, audit entry). |
| `feedback.test.js` | Feedback: passenger self-scoping, rating bounds, trip existence, duplicate-per-trip rejection, average-rating maths (incl. the empty case), and admin notification. |
| `activityLogs.test.js` | Audit trail: admin-only, user/action/date filters, pagination defaults, skip/take derivation, and **pagination sanitization** (negative page, oversized limit, non-numeric input). |
| `assignments.test.js` | Driver assignments: bus/driver/derived stats, status + search filters, and the full assign/unassign guard chain (non-driver, deactivated, already-assigned, already-taken bus). |

---


## Deployment

### Docker

One image serves two roles so the worker and the API always run **identical**
code and job handlers:

```bash
docker build -t bus-scheduling .

# Web server
docker run -p 3000:3000 --env-file .env bus-scheduling

# Worker (same image, different command)
docker run --env-file .env bus-scheduling npm run worker
```

The `Dockerfile` is a three-stage build:

| Stage | Purpose |
| --- | --- |
| `deps` | `node:20-bookworm-slim` + `openssl`/`ca-certificates` (required by the Prisma query engine). Copies only the manifests + `prisma/` so the dependency layer is cached, then `npm ci` (reproducible; its `postinstall` runs `prisma generate` against a dummy `DATABASE_URL`). |
| `builder` | Copies `node_modules` and the source, sets placeholder `DATABASE_URL`/`JWT_SECRET`, runs `npm run build`. |
| `runner` | Non-root user `nextjs` (uid 1001). Copies `.next/standalone`, `.next/static`, `public/`, plus `worker/`, `src/lib/jobs/`, `prisma/` and `package.json`. Layers the pruned-out `bullmq`, `ioredis`, `@prisma` and `.prisma` from `deps`. |

Details worth knowing:

- **No secrets are baked into image layers.** The build-time `DATABASE_URL` and
  `JWT_SECRET` are syntactically valid placeholders used only to satisfy
  `prisma generate` / `next build` (neither connects), and are overridden at
  runtime via `--env-file`.
- **The healthcheck targets `/api/health/live`, not `/api/health`.** The latter is
  admin-only and would return `401` to an unauthenticated probe, marking a healthy
  container permanently unhealthy. `127.0.0.1` is used instead of `localhost` to
  avoid resolving to `::1` where the server binds IPv4 only.
- `output: "standalone"` in `next.config.mjs` is why the container runs
  `node server.js` rather than `next start`, and why the image does not need the
  full dependency tree.
- `@prisma/client`, `bcryptjs`, `ioredis` and `bullmq` are listed under
  `experimental.serverComponentsExternalPackages` — they must be resolved at
  runtime, not bundled (correct native query-engine binary; raw sockets/Lua/worker
  threads for Redis).

### Vercel

`vercel.json` pins the build command, region and function limits:

```json
{
  "framework": "nextjs",
  "buildCommand": "prisma generate && prisma migrate deploy && next build",
  "installCommand": "npm install",
  "regions": ["iad1"],
  "functions": { "src/app/api/**/route.js": { "maxDuration": 10 } }
}
```

Set `DATABASE_URL` and `JWT_SECRET` in the project's environment variables.
`REDIS_URL` is optional — leave it unset for the zero-infrastructure path (the
Vercel Hobby target this repo is written for), or set it *and* deploy
`worker/index.mjs` as a separate long-lived service (Render/Railway/Fly.io) using
the same `REDIS_URL`. A worker cannot run inside a serverless function.

The Prisma `binaryTargets` cover `native`, `debian-openssl-3.0.x` (the Docker
image) and `rhel-openssl-3.0.x` (Vercel / Amazon Linux) so the query engine is
present on every target.

---

## Operations and troubleshooting

### Health checks

```bash
# Liveness (public, no dependencies)
curl -fsS http://localhost:3000/api/health/live

# Full infrastructure report (admin bearer token required)
curl -fsS -H "Authorization: Bearer $TOKEN" http://localhost:3000/api/health
```

### Diagnosing common problems

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| `JWT_SECRET is not set` on the first request in production | Missing env var | Set `JWT_SECRET` in the platform's environment variables. It is resolved lazily on purpose, so the build succeeds and the failure is explicit. |
| `prisma generate` fails during install/build | `DATABASE_URL` absent or malformed | Provide a syntactically valid connection string; no connection is made at build time. |
| Notifications/audit rows never appear | `REDIS_URL` set but no worker running | Run `npm run worker`, or unset `REDIS_URL` to use inline execution. Check `queue.deliveryMode` and `queue.pendingJobs` on `/api/health`. |
| Mutating requests hang, then succeed slowly | Redis reachable but unresponsive | BullMQ requires `maxRetriesPerRequest: null`, so the enqueue timeout (`QUEUE_ENQUEUE_TIMEOUT_MS`) is what protects you. Confirm the circuit breaker is tripping (`REDIS_DEBUG=true` to log it). |
| Attendance shows `0%` right after verifying passes | Stale report cache | Should not occur — `/api/buspass` PUT invalidates `REPORTS` + `DASHBOARD`. If you add a new write path that changes attendance, invalidate `REPORTS`. |
| A new field never appears in a list response | Cached namespace not invalidated | Add the namespace to the `invalidate(...)` call in the mutating handler. |
| A passenger sees an admin's notifications | Role missing from the cache key | The notifications route keys on `${user.role}:${searchParamsKey(req)}` — keep that property when touching the route. |
| Camera scanner does nothing | Insecure context | Camera access requires HTTPS or `localhost`. The component surfaces an explicit message. |
| `401` loop / immediately redirected to `/login` | Expired or invalid token | Expected. The axios response interceptor clears storage and redirects. Sign in again. |
| Docker container reports unhealthy | Healthcheck pointing at `/api/health` | Use `/api/health/live` (already the default). |

### Operational notes

- **Audit-trail growth.** `ActivityLog` grows without bound; `/api/activity-logs`
  clamps `limit` to 100 and is rate-limited separately. Plan retention pruning for
  long-lived deployments.
- **Cache flush semantics.** `invalidate` only bumps a version counter, so
  orphaned Redis entries linger until their TTL expires. This is by design (no
  `SCAN`), but memory is reclaimed lazily, not immediately.
- **In-memory cache bounds.** `CACHE_MEMORY_MAX_ENTRIES` (default 500) caps the
  fallback store with FIFO eviction. Raise it for a single-instance deployment
  where you want a larger hot set.
- **Multiple instances without Redis** each keep independent cache, limiter and
  queue state. Configure `REDIS_URL` for consistent behaviour across replicas.

---

## Coding conventions

### Imports and aliases

`@/*` maps to `./src/*` (`jsconfig.json`, mirrored in `vitest.config.mjs`):

```js
import prisma from '@/lib/prisma';
import { authMiddleware } from '@/middleware/auth';
import { Button } from '@/components/ui';           // barrel export
import { bookingService } from '@/services/bookingService';
import { startOfDay, startOfNextDay } from '@/utils/dates';
```

### Adding an API endpoint

1. Create `src/app/api/<resource>/route.js` (and `[id]/route.js` if needed).
2. Start the file with `export const runtime = 'nodejs';` and
   `export const dynamic = 'force-dynamic';`.
3. Order the handler as: `authMiddleware` → `enforceRateLimit` → `withCache`
   (reads) → Prisma → `invalidate(...)` → side effects (`logActivity`,
   `enqueue*`).
4. Guard the auth result with
   `if (authResult instanceof NextResponse) return authResult;`.
5. Wrap the body in `try/catch`, `console.error` the failure and return a `500`
   with a user-safe `{ error: '…' }`.
6. Return `NextResponse.json(data, { headers: cacheHeaders(result) })` for cached
   reads.
7. Add a matching method to `src/services/<resource>Service.js` so the UI never
   calls `fetch` directly.

### Adding a client page

1. Create `src/app/<path>/page.js` starting with `'use client';`.
2. Wrap content in `<DashboardLayout>` (it handles the auth redirect and the
   loading state) and use `useAuth()` / `useApp()` for state.
3. Build the UI from `@/components/ui` primitives (`Card`, `Button`, `Input`,
   `Select`, `Modal`, `Badge`, `Alert`, `LoadingSpinner`) and Feather icons from
   `react-icons/fi`.
4. Add the route to the appropriate link array in
   `src/components/layout/Sidebar.js` (`adminLinks`, `driverLinks`,
   `passengerLinks`).
5. Style with Tailwind utilities and the dark slate palette; the app is
   dark-mode-only by design.

### Adding a background job

1. Add the job name to `JOB_NAMES` in `src/lib/queue.js` (and to the `*_JOBS` map
   in the handler module).
2. Implement the handler in `src/lib/jobs/<domain>.jobs.mjs` — **no imports**,
   take `{ prisma, data }` as arguments, and validate required fields by throwing.
3. Register it in that module's `default` export map.
4. Add an `enqueue*` helper to `src/lib/enqueue.js` that passes
   `{ handlers, ctx: { prisma } }` so the inline fallback works.
5. Call the helper from the route; never touch the queue directly.

### Style rules used throughout

- 2-space indent, single quotes in most files (a few older routes use double —
  match the surrounding file), semicolons, trailing commas.
- Every non-obvious decision is explained in a comment stating the *why*
  (a failure mode that was hit), not the *what*.
- Module-level singletons (`prisma`, Redis clients, cache maps, rate-limit
  buckets, queue registry) are attached to `globalThis` so hot reloads and
  serverless invocations reuse them instead of leaking one per request.
- Reset hooks are exposed on `globalThis` (`__busCacheReset`,
  `__busRateLimitReset`, `__busRedisReset`) so tests can clear module state
  **without importing** the module (which would pull in `ioredis` before a
  `vi.mock` could apply).
- Dates that mean "a calendar day" go through `src/utils/dates.js`; never mix
  `new Date(dateString)` with `setHours`.
- Errors returned to clients are generic (`'Failed to fetch buses'`); details go
  to `console.error` only.

---

## License

No `LICENSE` file is present in this repository. Add one before distributing or
deploying publicly, and update this section accordingly.
