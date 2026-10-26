# BusMS - University Bus Scheduling Management System

A full-stack **Next.js 14** web application for managing university/campus bus
transportation operations. It provides separate experiences for **Administrators**,
**Drivers** and **Passengers** with role-based access control, live map tracking,
digital QR bus passes, seat bookings, maintenance scheduling and analytics.

The entire app — frontend UI, REST API and authentication — lives in a single
Next.js App Router project under `my-app/`, backed by a PostgreSQL database via
Prisma.

---

## Table of Contents

- [Overview](#overview)
- [Key Features](#key-features)
- [System Architecture](#system-architecture)
- [Tech Stack](#tech-stack)
- [Project Structure](#project-structure)
- [Data Model (Database Schema)](#data-model-database-schema)
- [User Roles & Permissions](#user-roles--permissions)
- [Frontend Documentation](#frontend-documentation)
  - [App Router Pages](#app-router-pages)
  - [Layout & Navigation Components](#layout--navigation-components)
  - [UI Component Library](#ui-component-library)
  - [Map Components](#map-components)
  - [State Management (Contexts)](#state-management-contexts)
  - [API Service Layer](#api-service-layer)
  - [Styling & Design System](#styling--design-system)
  - [Client-Side Authentication Flow](#client-side-authentication-flow)
- [Backend Documentation](#backend-documentation)
  - [API Conventions](#api-conventions)
  - [Authentication & Middleware](#authentication--middleware)
  - [Audit Logging](#audit-logging)
  - [API Endpoint Reference](#api-endpoint-reference)
  - [Backend Business Logic](#backend-business-logic)
- [How Attendance Works](#how-attendance-works)
- [Notifications](#notifications)
- [Security Notes](#security-notes)
- [Redis, BullMQ & Rate Limiting](#redis-bullmq--rate-limiting)
- [Testing](#testing)
- [Docker](#docker)
- [Getting Started](#getting-started)
- [Environment Variables](#environment-variables)
- [Available Scripts](#available-scripts)
- [Deploying to Vercel (Free Tier)](#deploying-to-vercel-free-tier)
- [Troubleshooting](#troubleshooting)
- [License](#license)

---

## Overview

The system models the day-to-day operations of a campus shuttle service:

- Admins define **buses**, **routes**, **stops**, **schedules**, **trips**,
  assign **drivers**, schedule **maintenance** and issue **digital bus passes**.
- Drivers start/complete trips and **verify passenger passes** (which records
  attendance automatically).
- Passengers browse routes/schedules, **book seats**, view their **QR bus pass**,
  track their position against stops and submit **feedback**.

All API routes run on the Node.js runtime, are never cached (`force-dynamic`) and
enforce authorization with a shared JWT middleware.

## Key Features

### User Management
- **Role-based Access Control**: Separate roles for Administrators, Drivers, and Passengers
- **Secure Authentication**: JWT-based login with bcrypt-hashed credentials
- **Self-Registration**: Public sign-up limited to Passengers and Drivers (admins are created by an existing admin)
- **Profile Management**: Update name and phone; view account details
- **Session Validation**: Stored sessions are re-validated against the server on load

### Route, Stop & Schedule Management
- **Route Management**: Create, update, deactivate routes and manage their stops
- **Stop Management**: Add/update/remove stops with map-based location picking, coordinates and ordering
- **Schedule Management**: Morning, noon, evening and special schedules with days-of-week and date ranges
- **Automatic Notifications**: Creating routes/stops/schedules/trips notifies the relevant roles

### Live Tracking
- **Live Map Visualization**: Route polylines and stop markers using React-Leaflet + OpenStreetMap
- **Geolocation**: Uses the browser's current position and distance to each stop
- **Auto-refresh**: The tracking view polls for updated stops every 30 seconds

### Booking & Pass Management
- **Seat Reservation**: Seat availability is checked inside a transaction to prevent overbooking
- **Smart Selection**: Trips are filtered to upcoming/active ones and stops are restricted to the selected trip's route
- **Digital Bus Passes**: QR-code based passes with admin create/update/delete
- **QR Verification**: Scan or type a pass number to validate a pass (Admin/Driver)
- **Attendance on Verify**: When a driver verifies a passenger's pass, that passenger's
  active booking for the day is automatically marked as **attended** — no manual
  admin step required
- **Booking Management**: Filter, confirm, cancel, edit and delete bookings by role

### Administrative Control
- **Dashboard**: Statistics plus recent trips, upcoming schedules and maintenance alerts
- **Driver Assignment**: Assign/unassign drivers to buses (one driver per bus)
- **Maintenance Scheduling**: Track routine/repair/breakdown/inspection work and auto-update bus status
- **Emergency Broadcasting**: Send emergency notifications to all roles from the dashboard
- **User Management**: Create, update and deactivate users

### Reporting & Analytics
- **Daily Summary**: Today's trips plus attendance (total / present / absent / rate)
- **Bus Usage**: Trips and bookings per bus
- **Driver Performance**: Trip counts and availability per driver
- **Fuel Consumption**: Estimated fuel usage and cost per bus

### UI/UX
- **Modern Design System**: Consistent slate/blue palette, rounded surfaces, soft shadows
- **Fast Perceived Navigation**: Route-level loading state, page-enter transitions and a sticky blurred header
- **Accessible**: Keyboard-visible focus rings, ARIA labels, `prefers-reduced-motion` support, Escape-to-close modals, click-outside dropdowns
- **Responsive**: Mobile-first layouts with a slide-in sidebar drawer


### Security & Compliance
- **Activity Logs**: Every mutating action is written to an audit trail with actor, IP and user agent
- **Encrypted Authentication**: Secure JWT-based tokens
- **Input Validation**: All write endpoints validate fields, enums, ranges, dates and references


## System Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│                        Browser (React 18)                        │
│                                                                  │
│  Pages (App Router)  ──►  Contexts (Auth/App)  ──►  Services      │
│        │                      │                      │           │
│        └── DashboardLayout    └── localStorage       └── axios    │
│            (Sidebar/Navbar)       (token+user)          client    │
└───────────────────────────────┬──────────────────────────────────┘
                                │  fetch / axios  (Bearer JWT)
                                ▼
┌──────────────────────────────────────────────────────────────────┐
│              Next.js Route Handlers (Node.js runtime)            │
│                                                                  │
│   /app/api/**/route.js                                           │
│        │                                                         │
│        ├── authMiddleware(req, roles)  ── verifyToken + Prisma   │
│        ├── logActivity({...})          ── audit trail            │
│        └── prisma.<model>.<op>()       ── business logic         │
└───────────────────────────────┬──────────────────────────────────┘
                                │  Prisma Client
                                ▼
┌──────────────────────────────────────────────────────────────────┐
│                   PostgreSQL Database                            │
│   User · Bus · Route · Stop · Schedule · Trip · Booking ·        │
│   BusPass · Maintenance · Notification · Feedback · ActivityLog  │
└──────────────────────────────────────────────────────────────────┘
```

## Tech Stack

### Frontend
- **Next.js 14** — React framework with the App Router.
- **React 18** — UI library.
- **TailwindCSS v4** — utility-first CSS (via `@tailwindcss/postcss`).
- **React Context** — global state management (`AuthContext`, `AppContext`).
- **React-Leaflet / Leaflet** — map integration with OpenStreetMap tiles.
- **React Icons** — icon library (`react-icons/fi`).
- **Axios** — HTTP client with request/response interceptors.
- **html5-qrcode** — in-browser QR scanning.
- **date-fns** — date utilities.

### Backend
- **Next.js Route Handlers** — server-side API endpoints (Node.js runtime).
- **Prisma** — ORM and type-safe query builder.
- **PostgreSQL** — relational database.
- **jsonwebtoken** — JWT signing/verification.
- **bcryptjs** — password hashing.
- **qrcode** — server-side QR data-URL generation.
- **uuid** — unique QR identifiers.

## Project Structure

```
my-app/
├── prisma/
│   ├── schema.prisma             # Data model (models + enums)
│   └── migrations/               # SQL migration history
├── src/
│   ├── app/                      # Next.js App Router
│   │   ├── api/                  # REST route handlers
│   │   │   ├── auth/             #   login, register, me
│   │   │   ├── users/            #   users + [id]
│   │   │   ├── buses/            #   buses + [id]
│   │   │   ├── routes/           #   routes + [id]
│   │   │   ├── stops/            #   stops + [id]
│   │   │   ├── schedules/        #   schedules + [id]
│   │   │   ├── trips/            #   trips + [id]
│   │   │   ├── bookings/         #   bookings + [id]
│   │   │   ├── buspass/          #   bus passes + QR verify
│   │   │   ├── assignments/      #   driver ↔ bus assignment
│   │   │   ├── maintenance/      #   maintenance records
│   │   │   ├── notifications/    #   notifications
│   │   │   ├── feedback/         #   feedback
│   │   │   ├── activity-logs/    #   audit trail
│   │   │   ├── reports/          #   analytics
│   │   │   └── dashboard/        #   stats + emergency broadcast
│   │   ├── activity-logs/        # Audit log page
│   │   ├── assignments/          # Driver assignment page
│   │   ├── bookings/             # Bookings page
│   │   ├── buses/                # Buses page
│   │   ├── buspass/              # Bus passes / verify page
│   │   ├── dashboard/            # Dashboard + error boundary
│   │   ├── feedback/             # Feedback page
│   │   ├── login/                # Login page
│   │   ├── maintenance/          # Maintenance page
│   │   ├── notifications/        # Notifications page
│   │   ├── profile/              # Profile page
│   │   ├── register/             # Registration page
│   │   ├── reports/              # Reports page
│   │   ├── routes/               # Routes page
│   │   ├── schedules/            # Schedules page
│   │   ├── stops/                # Stops page
│   │   ├── tracking/             # Live tracking page
│   │   ├── trips/                # Trips page
│   │   ├── users/                # Users page
│   │   ├── layout.js             # Root layout (fonts, providers)
│   │   ├── providers.js          # AuthProvider + AppProvider
│   │   ├── page.js               # Landing page
│   │   ├── loading.js            # Route loading state
│   │   ├── error.js              # Global error boundary
│   │   ├── not-found.js          # 404 page
│   │   └── globals.css           # Tailwind import + custom styles
│   ├── components/
│   │   ├── ui/                   # Button, Input, Select, Card, Modal, Badge, Alert, LoadingSpinner (+ barrel)
│   │   ├── layout/               # Sidebar, Navbar, DashboardLayout
│   │   ├── map/                  # MapView, LocationPicker (+ barrel)
│   │   └── QRVerifier.js         # Camera QR scanner component
│   ├── context/                  # AuthContext, AppContext
│   ├── hooks/                    # useRateLimit (live countdown UI state)
│   ├── lib/                      # prisma, activityLogger, redis, cache, rateLimiter, queue, enqueue
│   │   └── jobs/                 # BullMQ job handlers (*.jobs.mjs, Prisma injected)
│   ├── middleware/               # authMiddleware, optionalAuth
│   ├── services/                 # axios client + per-resource API services
│   └── utils/                    # jwt helpers, clientRateLimit
├── worker/                       # Standalone BullMQ worker (npm run worker)
├── tests/                        # Vitest unit + end-to-end suites
├── Dockerfile                    # Multi-stage image (web server + worker)
├── .dockerignore
├── .env
├── next.config.mjs
├── postcss.config.mjs
├── vercel.json
└── package.json
```


## Data Model (Database Schema)

PostgreSQL, defined in `prisma/schema.prisma`. IDs are `cuid()` strings; every
model has `createdAt`/`updatedAt` unless noted.

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

### Models

| Model | Key fields | Relations |
| --- | --- | --- |
| **User** | `email` (unique), `password`, `name`, `phone?`, `role`, `passengerId?` (unique), `licenseNumber?`, `isActive` | `bookings`, `feedbacks`, `activityLogs`, `busPass?`, `bus?`, `trips` |
| **Bus** | `busNumber` (unique), `plateNumber` (unique), `capacity`, `model?`, `year?`, `status`, `lastMaintenance?`, `fuelType`, `mileage`, `driverId?` (unique) | `driver? (User)`, `schedules`, `bookings`, `trips`, `maintenance` |
| **Route** | `name`, `description?`, `isActive`, `estimatedDuration` (min), `distance` (km) | `stops`, `schedules`, `trips` |
| **Stop** | `name`, `latitude`, `longitude`, `address?`, `order`, `isActive`, `routeId` | `route`, `bookings` |
| **Schedule** | `routeId`, `busId`, `scheduleType`, `departureTime`, `arrivalTime`, `daysOfWeek` (String[]), `isActive`, `isSpecial`, `specialDate?`, `notes?` | `route`, `bus`, `trips` |
| **Trip** | `scheduleId`, `busId`, `routeId`, `driverId`, `startTime`, `endTime?`, `status` (default `SCHEDULED`), `actualStartTime?`, `actualEndTime?` | `schedule`, `bus`, `route`, `driver`, `bookings`, `feedbacks` |
| **Booking** | `userId`, `busId`, `stopId`, `tripId?`, `bookingDate`, `status`, `seatNumber?`, `qrCode?` (unique), `qrCodeData?`, `isUsed` | `user`, `bus`, `stop`, `trip?` |
| **BusPass** | `passengerId` (unique), `passNumber` (unique), `startDate`, `endDate`, `isActive`, `qrCode?` (unique) | `passenger (User)` |
| **Maintenance** | `busId`, `type`, `status`, `description`, `scheduledDate`, `completedDate?`, `cost?`, `notes?` | `bus` |
| **Notification** | `userRole` (String), `link`, `type`, `title`, `message`, `isRead`, `sentAt` | — (targeted by role, not per-user) |
| **Feedback** | `userId`, `tripId?`, `rating` (1–5), `comment?` | `user`, `trip?` |
| **ActivityLog** | `userId`, `action`, `details?`, `ipAddress?`, `userAgent?` | `user` |

> **Design note:** a driver may be assigned to at most one bus (`Bus.driverId` is
> `@unique`), enforcing a 1:1 driver↔bus relationship at the database level.
> `Notification` rows are targeted by `userRole` rather than by individual user,
> so one row serves every user of that role.

## User Roles & Permissions

### Administrator
- Full system access.
- User management (create, update, deactivate).
- Route, stop and schedule creation; bus management.
- Bus & driver assignment (one driver per bus).
- Maintenance scheduling.
- View all reports and analytics, activity logs.
- Send emergency broadcasts.
- Create/update/delete digital bus passes and verify passes.

### Driver
- View assigned routes, schedules and trips.
- Start / complete / cancel trip status (only for trips assigned to them).
- Verify bus passes (QR scan or pass number) — records attendance.
- View role notifications.

### Passenger
- View routes and schedules; live tracking.
- Make and manage their own bookings (create / cancel).
- View their digital bus pass.
- Provide trip feedback.
- Receive notifications.

## Frontend Documentation

### App Router Pages

All pages are **client components** (`'use client'`) that fetch data through the
service layer and render inside `DashboardLayout` (except auth/landing pages).

| Route | File | Description | Roles |
| --- | --- | --- | --- |
| `/` | `app/page.js` | Landing page; shows Login/Register or a "Go to Dashboard" shortcut if a session exists. | Public |
| `/login` | `app/login/page.js` | Email/password sign-in form. On success routes to `/dashboard`. | Public |
| `/register` | `app/register/page.js` | Self-registration (role-limited to Passenger/Driver). | Public |
| `/dashboard` | `app/dashboard/page.js` | Role-aware dashboard: admin stats, recent trips, schedules, maintenance alerts. | All |
| `/buses` | `app/buses/page.js` | Bus list + create/edit/delete (admin). | All (write: admin) |
| `/routes` | `app/routes/page.js` | Route list with stops + create/edit/deactivate. | All (write: admin) |
| `/stops` | `app/stops/page.js` | Stop management with map location picking. | All (write: admin) |
| `/schedules` | `app/schedules/page.js` | Schedule CRUD with day-of-week & type. | All (write: admin) |
| `/trips` | `app/trips/page.js` | Trip list; start/complete/cancel; create from schedule. | All (write: admin/driver) |
| `/tracking` | `app/tracking/page.js` | Live map of stops + user location; polls every 30 s. | All |
| `/bookings` | `app/bookings/page.js` | Booking management; passengers see only their own. | All |
| `/buspass` | `app/buspass/page.js` | Passenger pass view / admin management / driver QR verify. | All |
| `/assignments` | `app/assignments/page.js` | Assign/unassign drivers to buses. | Admin |
| `/maintenance` | `app/maintenance/page.js` | Maintenance records CRUD + complete. | Admin |
| `/notifications` | `app/notifications/page.js` | Role notifications list; mark read/delete. | All |
| `/feedback` | `app/feedback/page.js` | Submit/view feedback (passenger) with ratings. | All |
| `/reports` | `app/reports/page.js` | Analytics: daily summary, bus usage, driver performance, fuel. | Admin |
| `/activity-logs` | `app/activity-logs/page.js` | Paginated audit trail. | Admin |
| `/users` | `app/users/page.js` | User CRUD + deactivate + search. | Admin |
| `/profile` | `app/profile/page.js` | View/update own name & phone; change password. | All |

**Special app files**
- `app/layout.js` — root layout: loads Inter font, sets metadata/viewport, wraps children in `<Providers>`.
- `app/providers.js` — composes `AuthProvider` (outer) and `AppProvider` (inner).
- `app/loading.js` — global route loading spinner.
- `app/error.js` — global error boundary with a reset button.
- `app/not-found.js` — 404 page.
- `app/dashboard/error.js` — dashboard-scoped error boundary.


### Layout & Navigation Components

**`DashboardLayout`** (`components/layout/DashboardLayout.js`)
- Client component wrapping every authenticated page.
- Redirects unauthenticated users to `/login` (in an effect, never during render).
- Shows a full-screen loader while `loading || !isAuthenticated`.
- Renders `<Sidebar>` + `<Navbar>` and a scrollable `<main>`.
- Keys the content wrapper on `pathname` so a `page-enter` animation replays per route.
- Closes the mobile sidebar whenever the route changes.

**`Sidebar`** (`components/layout/Sidebar.js`)
- Fixed slide-in drawer on mobile, static on `lg`.
- Builds role-specific nav link arrays (`adminLinks`, `driverLinks`, `passengerLinks`).
- Highlights the active link; sets `aria-current="page"`.
- Shows the user avatar, name and role at the bottom.

**`Navbar`** (`components/layout/Navbar.js`)
- Sticky, blurred, `z-30` header.
- Hamburger (`onMenuClick`) to open the mobile sidebar.
- Notification bell dropdown: fetches the latest 5 notifications, shows an unread
  badge, supports per-item "mark as read".
- User dropdown: Profile link + Logout; closes on outside click (`mousedown` listener).

### UI Component Library

Re-exported from `components/ui/index.js`. All are client components.

| Component | Props (highlights) | Notes |
| --- | --- | --- |
| `Button` | `variant` (`primary`/`secondary`/`success`/`danger`/`warning`/`outline`/`ghost`), `size` (`sm`/`md`/`lg`), `loading`, `disabled` | Inline spinner while loading; visible focus ring; `active:scale-[0.98]`. |
| `Input` | `label`, `name`, standard input props, password toggle | Forwards attributes to `<input>`. |
| `Select` | `label`, `options`, `name` | Themed native select with chevron icon. |
| `Card` | `title`, `children`, etc. | Rounded surface with soft shadow. |
| `Modal` | `isOpen`, `onClose`, `title` | Escape-to-close, backdrop click, focus handling. |
| `Badge` | `variant`, `children` | Status pills with color variants. |
| `Alert` | `variant` (`info`/`success`/`warning`/`danger`) | Icon + message banner. |
| `LoadingSpinner` | `size`, `className` | Accessible loading indicator. |

### Map Components

Re-exported from `components/map/index.js`. Both are client components that
**dynamically import** `react-leaflet` with `ssr: false` (Leaflet needs `window`).

**`MapView`** (`components/map/MapView.js`)
- Props: `stops`, `center`, `zoom`, `height`, `onMapClick`.
- Watches the user position with `getCurrentPosition` + `watchPosition`.
- Draws a dashed polyline from the user to each stop, a user marker and stop markers.
- Popups show stop name, address, order, route and **Haversine distance** to the user.
- Uses OpenStreetMap tiles; shows a "Loading Map…" placeholder until geolocation resolves.

**`LocationPicker`** (`components/map/LocationPicker.js`)
- Used where admins pick stop coordinates.
- Dynamically loads Leaflet + react-leaflet and patches default marker icons from CDN.
- `useMapEvents` handles clicks; `onChange([lat, lng])` reports the selection.
- Renders the user marker, selected marker and connecting polylines with distances.

**`QRVerifier`** (`components/QRVerifier.js`)
- Props: `onVerify(text)`, `verifyResult`, `onReset()`.
- Uses `html5-qrcode` to scan QR codes (environment-facing camera).
- Guards against double-start (StrictMode), releases the camera on unmount, and maps
  common camera errors (permission denied, not available, already in use) to friendly messages.
- Renders a green success card (pass number, passenger name/ID, valid-until) or a
  red failure card.


### State Management (Contexts)

**`AuthContext`** (`context/AuthContext.js`)
- Holds `user`, `loading`, `error`.
- On mount, **re-validates** the stored session: optimistically restores the cached
  user, then calls `authService.getSession()`; clears the session if invalid.
- Exposes `login`, `register`, `logout` and derived flags:
  `isAuthenticated`, `isAdmin`, `isDriver`, `isPassenger`.
- `useAuth()` throws if used outside the provider.

**`AppContext`** (`context/AppContext.js`)
- Holds shared collections: `notifications`, `unreadCount`, `dashboardStats`,
  `buses`, `routes`, `schedules`, `trips`, plus per-collection `loading` flags.
- Provides `fetchNotifications`, `markNotificationsAsRead`, `fetchDashboardStats`,
  `fetchBuses`, `fetchRoutes`, `fetchSchedules`, `fetchTrips`.
- `useApp()` throws if used outside the provider.

### API Service Layer

`services/client.js` creates a single axios instance:

- `baseURL = process.env.NEXT_PUBLIC_API_URL || ''` (same-origin on Vercel).
- **Request interceptor** attaches `Authorization: Bearer <token>` from `localStorage`.
- **Response interceptor** clears the session and redirects to `/login` on `401`.

Per-resource services export a namespaced object that wraps the endpoints. `authService`
also manages token/user persistence in `localStorage`.

| Service | Methods |
| --- | --- |
| `authService` | `login`, `register`, `logout`, `getCurrentUser`, `getToken`, `getSession` |
| `userService` | `getAll`, `getById`, `create`, `update`, `delete` |
| `busService` | `getAll`, `getById`, `create`, `update`, `delete` |
| `routeService` | `getAll`, `getById`, `create`, `update`, `delete` |
| `stopService` | `getAll`, `getById`, `create`, `update`, `delete` |
| `scheduleService` | `getAll`, `getById`, `create`, `update`, `delete` |
| `tripService` | `getAll`, `getById`, `create`, `update`, `delete` |
| `bookingService` | `getAll`, `getById`, `create`, `cancel`, `confirm`, `update`, `delete` |
| `busPassService` | `getAll`, `create`, `update`, `delete`, `verify` |
| `assignmentService` | `getAll`, `assign`, `unassign` |
| `maintenanceService` | `getAll`, `create`, `update`, `delete` |
| `notificationService` | `getAll`, `create`, `markAsRead`, `delete`, `deleteById`, `deleteAllRead` |
| `feedbackService` | `getAll`, `create` |
| `activityLogService` | `getAll` |
| `dashboardService` | `getStats`, `sendEmergencyBroadcast` |
| `reportService` | `getDashboard`, `getDailySummary`, `getBusUsage`, `getDriverPerformance`, `getFuelConsumption` |

All list methods accept a `params` object forwarded as query string.

### Styling & Design System

- **TailwindCSS v4** imported in `app/globals.css` via `@import "tailwindcss";` and
  compiled through PostCSS (`postcss.config.mjs` with `@tailwindcss/postcss`).
- **Palette**: slate backgrounds (`bg-slate-950`/`900`), blue primary accents,
  emerald/amber/red for status. Rounded surfaces, soft shadows, blurred sticky header.
- **Font**: Inter via `next/font/google`, exposed as `--font-inter`.
- **Custom utilities/animations** in `globals.css`: `page-enter`, `animate-slide-up`,
  `animate-scale-in`.
- **Accessibility**: `focus-visible` rings, ARIA labels (`aria-current`, `aria-label`),
  Escape-to-close modals, click-outside dropdowns, `prefers-reduced-motion` support.

### Client-Side Authentication Flow

1. `AuthProvider` mounts → reads cached `user` from `localStorage` → optimistically sets it.
2. Calls `authService.getSession()` → `GET /api/auth/me` with the bearer token.
3. Valid → fresh user stored; invalid/expired → `logout()` clears storage and `user`.
4. `DashboardLayout` redirects to `/login` if `!isAuthenticated` after loading.
5. Any `401` from the API interceptor also clears storage and redirects to `/login`.


## Backend Documentation

### API Conventions

- Every handler module sets `export const runtime = 'nodejs'` and
  `export const dynamic = 'force-dynamic'`.
- All endpoints require `Authorization: Bearer <token>` **except**
  `POST /api/auth/login` and `POST /api/auth/register`.
- Handlers begin with `const authResult = await authMiddleware(req, [roles])` and
  short-circuit with `if (authResult instanceof NextResponse) return authResult;`.
- Success responses use `NextResponse.json({...})`; errors use
  `NextResponse.json({ error }, { status })` with meaningful status codes
  (`400`, `401`, `403`, `404`, `409`, `500`).
- Writes validate required fields, enums, numeric ranges, dates and foreign-key
  existence before touching the database.

### Authentication & Middleware

`middleware/auth.js` exports:

**`authMiddleware(req, roles = [])`**
1. Reads the `Authorization` header; requires the `Bearer ` prefix (else `401`).
2. Verifies the token via `verifyToken` (else `401`).
3. Loads the user by `decoded.userId` (else `401`); checks `isActive` (else `403`).
4. If `roles` is non-empty and the user's role isn't included → `403`.
5. Returns `{ user }` on success or a `NextResponse` error otherwise.

**`optionalAuth(req)`** — returns `{ user: null }` instead of erroring when the
token is missing/invalid.

`utils/jwt.js`:
- `generateToken(payload)` signs with `JWT_SECRET`, expiry `JWT_EXPIRES_IN` (default `7d`).
- `verifyToken(token)` returns the decoded payload or `null`.
- `decodeToken(token)` — non-verifying decode.
- The secret is resolved lazily: in **production** a missing `JWT_SECRET` throws;
  in development a fallback secret is used so builds succeed.

### Audit Logging

`lib/activityLogger.js` exports `logActivity({ userId, action, details, req })`:
- Extracts `ipAddress` from `x-forwarded-for` / `x-real-ip` and `userAgent` from headers.
- Writes an `ActivityLog` row.
- **Never throws** — a logging failure must not break the primary request.

Actions recorded include: `LOGIN`, `REGISTER`, `CREATE_USER`, `CREATE_BUS`,
`CREATE_ROUTE`, `CREATE_SCHEDULE`, `CREATE_STOP`, `CREATE_BUS_PASS`,
`UPDATE_BUS_PASS`, `DELETE_BUS_PASS`, `VERIFY_BUS_PASS`, `UPDATE_TRIP`,
`DELETE_TRIP`, `UPDATE_BOOKING`, `DELETE_BOOKING`, `ASSIGN_DRIVER`,
`UNASSIGN_DRIVER`, `CREATE_MAINTENANCE`, `UPDATE_MAINTENANCE`,
`DELETE_MAINTENANCE`, `SUBMIT_FEEDBACK`, `EMERGENCY_BROADCAST`.

`lib/prisma.js` exports a singleton `PrismaClient` (stored on `global` in
non-production to survive hot reloads), logging errors only.

### API Endpoint Reference

All paths are relative to `/api`. The **Auth** column lists permitted roles.

#### Authentication
| Method | Path | Auth | Description |
| --- | --- | --- | --- |
| POST | `/auth/login` | Public | Validate credentials, return `token` + `user`. |
| POST | `/auth/register` | Public | Register as `PASSENGER`/`DRIVER` only; returns `token` + `user`. |
| GET | `/auth/me` | All | Validate bearer token, return current `user`. |

#### Users
| Method | Path | Auth | Description |
| --- | --- | --- | --- |
| GET | `/users` | Admin | List users (filters: `role`, `isActive`). |
| POST | `/users` | Admin | Create user (any role). |
| GET | `/users/[id]` | All | Get user details. |
| PUT | `/users/[id]` | All/Admin | Update user (self or admin). |
| DELETE | `/users/[id]` | Admin | Deactivate user. |

#### Buses
| Method | Path | Auth | Description |
| --- | --- | --- | --- |
| GET | `/buses` | All | List buses (filter `?status=`), incl. driver + schedules. |
| POST | `/buses` | Admin | Create bus (validates capacity, unique number/plate). |
| GET | `/buses/[id]` | All | Get bus details. |
| PUT | `/buses/[id]` | Admin | Update bus. |
| DELETE | `/buses/[id]` | Admin | Delete bus. |

#### Routes
| Method | Path | Auth | Description |
| --- | --- | --- | --- |
| GET | `/routes` | All | List routes incl. stops, counts (filter `?isActive=`). |
| POST | `/routes` | Admin | Create route (optionally with nested stops). |
| GET | `/routes/[id]` | All | Get route details. |
| PUT | `/routes/[id]` | Admin | Update route (cannot replace stops with existing bookings). |
| DELETE | `/routes/[id]` | Admin | Deactivate route. |

#### Stops
| Method | Path | Auth | Description |
| --- | --- | --- | --- |
| GET | `/stops` | All | List stops (optionally `?routeId=`). |
| POST | `/stops` | Admin | Create stop (validates lat/lng range, route exists; auto-order). |
| GET | `/stops/[id]` | All | Get stop details. |
| PUT | `/stops/[id]` | Admin | Update stop. |
| DELETE | `/stops/[id]` | Admin | Delete / deactivate stop. |

#### Schedules
| Method | Path | Auth | Description |
| --- | --- | --- | --- |
| GET | `/schedules` | All | List schedules (filters: `routeId`, `busId`, `scheduleType`, `isActive`, `isSpecial`). |
| POST | `/schedules` | Admin | Create schedule (validates route/bus; supports `HH:mm` times; notifies passengers). |
| GET | `/schedules/[id]` | All | Get schedule details. |
| PUT | `/schedules/[id]` | Admin | Update schedule. |
| DELETE | `/schedules/[id]` | Admin | Deactivate schedule. |

#### Trips
| Method | Path | Auth | Description |
| --- | --- | --- | --- |
| GET | `/trips` | All | List trips (filters: `routeId`, `busId`, `date`). |
| POST | `/trips` | Admin/Driver | Start (create) a trip from a `scheduleId`; notifies passengers. |
| GET | `/trips/[id]` | All | Get trip details. |
| PUT | `/trips/[id]` | Admin/Owning Driver | Update status (`IN_PROGRESS`/`COMPLETED`/`CANCELLED`); terminal states enforced. |
| DELETE | `/trips/[id]` | Admin | Delete trip (not if in progress). |

#### Bookings
| Method | Path | Auth | Description |
| --- | --- | --- | --- |
| GET | `/bookings` | All | List bookings (passengers see only their own; filters available). |
| POST | `/bookings` | Admin/Passenger | Create booking; atomic seat allocation; QR generated. |
| GET | `/bookings/[id]` | All | Get booking (passengers only their own). |
| PUT | `/bookings/[id]` | Admin/Owning Passenger | Update/cancel (passengers can only cancel). |
| DELETE | `/bookings/[id]` | Admin | Delete booking. |

#### Bus Pass
| Method | Path | Auth | Description |
| --- | --- | --- | --- |
| GET | `/buspass` | Admin/Passenger | List passes (passengers see their own; `?passengerId=` for admin). |
| POST | `/buspass` | Admin | Create pass (validates role/date range; one active pass per passenger). |
| PUT | `/buspass` | Admin/Driver | **Verify** a QR/pass number; marks today's bookings attended. |
| PATCH | `/buspass` | Admin | Update pass dates/active flag. |
| DELETE | `/buspass?id=` | Admin | Delete a pass. |

#### Driver Assignments
| Method | Path | Auth | Description |
| --- | --- | --- | --- |
| GET | `/assignments` | Admin | List buses with drivers + pool of unassigned drivers + stats. |
| POST | `/assignments` | Admin | Assign a driver to a bus (both must be free). |
| DELETE | `/assignments?busId=` | Admin | Unassign a driver from a bus. |

#### Maintenance
| Method | Path | Auth | Description |
| --- | --- | --- | --- |
| GET | `/maintenance` | Admin | List records (filters: `busId`, `status`, `type`). |
| POST | `/maintenance` | Admin | Create record; sets bus to `MAINTENANCE` for repair/breakdown. |
| PUT | `/maintenance` | Admin | Update status; on `COMPLETED` reactivates bus & stamps `lastMaintenance`. |
| DELETE | `/maintenance?id=` | Admin | Delete a record. |

#### Notifications
| Method | Path | Auth | Description |
| --- | --- | --- | --- |
| GET | `/notifications` | All | List notifications for the caller's role (admin sees all) + `unreadCount`. |
| POST | `/notifications` | Admin | Send a notification (by `userRole`, or to all roles). |
| PUT | `/notifications` | All | Mark specific/all-read, or delete by ids (scoped by role). |
| DELETE | `/notifications?id=` | Admin | Delete one, or all read when no `id`. |

#### Feedback
| Method | Path | Auth | Description |
| --- | --- | --- | --- |
| GET | `/feedback` | All | List feedback (admin sees all, others their own) + `averageRating`. |
| POST | `/feedback` | Admin/Passenger | Submit feedback (rating 1–5; one per trip per user). |

#### Activity Logs
| Method | Path | Auth | Description |
| --- | --- | --- | --- |
| GET | `/activity-logs` | Admin | Paginated audit trail (`?page=&limit=`). |

#### Reports
| Method | Path | Auth | Description |
| --- | --- | --- | --- |
| GET | `/reports?type=…` | Admin | `daily-summary` \| `bus-usage` \| `driver-performance` \| `fuel-consumption` (default: overview). |

#### Dashboard
| Method | Path | Auth | Description |
| --- | --- | --- | --- |
| GET | `/dashboard` | Admin | Aggregate stats + recent trips + upcoming schedules + maintenance alerts. |
| POST | `/dashboard` | Admin | Send an emergency broadcast to all roles. |

#### Infrastructure

| Method | Path | Auth | Description |
| --- | --- | --- | --- |
| GET | `/health/live` | Public | Liveness probe. Returns `{ status: 'ok' }`. No DB/Redis/auth work, so it cannot fail during a dependency outage. Used by the Docker `HEALTHCHECK`. |
| GET | `/health` | Admin | Redis status, cache diagnostics, active rate-limit policies and queue depth (incl. `deliveryMode`). |

### Backend Business Logic

**Booking creation (overbooking protection)** — `POST /api/bookings`
- Validates the trip exists and the selected stop belongs to the trip's route.
- Rejects duplicate active bookings for the same user/trip/day (`409`).
- Runs a `Serializable` transaction: counts confirmed bookings for the trip/day,
  throws `NO_SEATS` if capacity is reached, otherwise generates a seat number
  (`1A`–`nD`) and a UUID QR data-URL, then inserts the booking as `CONFIRMED`.
- Notifies drivers of the new booking.

**Pass verification + attendance** — `PUT /api/buspass`
- Finds an active, non-expired pass by `passNumber` (or scanned value).
- `updateMany` marks today's `CONFIRMED`/`COMPLETED` bookings for that passenger
  with `isUsed: false` → `isUsed: true`.
- Returns `valid`, pass summary and `attendance.marked` count. Logs `VERIFY_BUS_PASS`.

**Trip lifecycle** — `PUT /api/trips/[id]`
- Drivers may only update trips assigned to them.
- Statuses limited to `SCHEDULED`/`IN_PROGRESS`/`COMPLETED`/`CANCELLED`.
- `COMPLETED`/`CANCELLED` are terminal; setting `IN_PROGRESS` stamps
  `actualStartTime`, `COMPLETED` stamps `endTime`/`actualEndTime`.

**Maintenance ↔ bus status**
- Creating a `REPAIR`/`BREAKDOWN` record sets the bus to `MAINTENANCE`.
- Completing a record sets the bus back to `ACTIVE` and stamps `lastMaintenance`.

**Notifications** are stored per role. Creation sites include: routes, stops,
schedules, trips, bookings (driver), bus passes, maintenance, feedback (admin),
driver assignment and broadcasts.

## How Attendance Works

Attendance is driven entirely by **driver pass verification** (no manual marking):

1. A passenger books a trip — the booking is created with attendance unmarked.
2. When boarding, the driver opens **Bus Passes → Verify Pass** and scans the
   passenger's QR code (or types the pass number).
3. `PUT /api/buspass` validates the pass and marks the passenger's **active
   booking for the current day** as attended (`Booking.isUsed = true`).
4. The driver sees a confirmation ("Attendance recorded for N booking(s) today.").
5. **Reports → Daily Summary → Attendance Summary** displays Total / Present /
   Absent / Attendance Rate from that data.

### The read and write paths must agree

`Present` is only non-zero when the query used to *count* attendance matches the
one used to *record* it. Three things have to line up:

| | Write (`PUT /api/buspass`) | Read (`GET /api/reports?type=daily-summary`) |
| --- | --- | --- |
| Date field | `bookingDate` | `bookingDate` |
| Window | `gte: startOfDay()`, `lt: startOfNextDay()` | `gte`/`lte` of `dayRange()` |
| Status | `CONFIRMED`, `COMPLETED` | `CONFIRMED`, `COMPLETED` |
| `isUsed` | filtered to `false`, then set `true` | counted where `true` |

Two failure modes worth knowing about, both of which make attendance read as
`0%` even though it was recorded:

- **Filtering the report by `tripId`.** `Booking.tripId` is **optional** in the
  schema, so a booking created without a trip is invisible to a
  `tripId IN (…)` filter. The report now filters on `bookingDate` instead.
- **A stale cache.** Recording attendance must call
  `invalidate(CACHE_NAMESPACES.REPORTS)`, otherwise the 60s reports TTL keeps
  serving the pre-verification numbers.

### Date handling

All day windows go through `src/utils/dates.js` rather than ad-hoc `Date`
arithmetic, because two very common mistakes silently shift a window by a day:

- `new Date('2026-02-16')` parses as **UTC** midnight, while `setHours(0,0,0,0)`
  is **local**. Use `parseDateOnly()` to get local midnight for a date-only
  string.
- `date.toISOString().split('T')[0]` returns the **UTC** calendar date, which is
  the previous day for local times earlier than the UTC offset. Use
  `toLocalDateKey()`.

Helpers available: `startOfDay`, `endOfDay`, `startOfNextDay`, `dayRange`,
`toLocalDateKey`, `parseDateOnly`. Prefer an exclusive upper bound
(`lt: startOfNextDay()`) over `lte: endOfDay()` so the final millisecond of a day
is never excluded.


## Notifications

- Notifications are **role-targeted** (`Notification.userRole`), not per-user.
- `GET /api/notifications` returns the caller's role's notifications; admins see all.
- Each response includes an `unreadCount`; the Navbar badge and bell dropdown use it.
- `PUT /api/notifications` marks items read or deletes them, always scoped to the
  caller's role (admins may act on any).
- Types are validated against the `NotificationType` enum on `POST`.

## Security Notes

- **Admin provisioning**: public `/api/auth/register` is restricted server-side to
  `PASSENGER` and `DRIVER`. Admin accounts are created by an existing admin through
  `POST /api/users`.
- **Password hashing**: bcrypt with a cost factor of 12.
- **JWT**: `JWT_SECRET` is **required in production** — the app refuses to sign or
  verify tokens without it. Sessions are re-validated on load via `GET /api/auth/me`,
  so expired/deactivated sessions are cleared automatically.
- **Authorization**: every API route enforces role checks through `authMiddleware`;
  passengers can only read/modify their own bookings, feedback and bus passes.
- **Booking integrity**: seat allocation runs inside a `Serializable` transaction to
  prevent overbooking under concurrency.
- **Audit trail**: every mutating action is written to `ActivityLog` with actor, IP
  address and user agent.
- **Input validation**: all write endpoints validate required fields, enums, numeric
  ranges, dates and foreign-key existence before touching the database.
- **Rate limiting**: every endpoint is protected by a manual, Redis-backed
  limiter (see [Redis, BullMQ & Rate Limiting](#redis-bullmq--rate-limiting)).
  Credential endpoints are capped per IP **and** per email.

---

## Redis, BullMQ & Rate Limiting

Three optional, independent capabilities. **All three work without Redis** — the
app degrades to per-process memory and inline execution, so nothing breaks if
`REDIS_URL` is unset. This is deliberate: the target deployment is Vercel
Hobby, which cannot host a long-lived worker process.

| Concern | Redis present | Redis absent |
| --- | --- | --- |
| **Cache** (`src/lib/cache.js`) | Shared across instances, invalidated via version keys | Bounded in-process `Map` (500 entries) |
| **Rate limiting** (`src/lib/rateLimiter.js`) | Distributed counters, shared across instances | Per-process counters |
| **Jobs** (`src/lib/queue.js`) | Published to BullMQ; consumed by `worker/index.mjs` | Executed inline inside the request |

### 1. Caching (`src/lib/cache.js`)

Cache-aside reads for the heavy, read-mostly collections. Every entry lives at
`bus:cache:<namespace>:<version>:<suffix>`.

Invalidation uses a **per-namespace version counter**, not a key sweep: flushing
a namespace is one atomic `INCR` on `bus:cachever:<namespace>`. Stale entries
become unreachable instantly and expire on their own TTL, so there is never a
`KEYS`/`SCAN` (which blocks Redis) and never an O(n) delete.

```js
import { withCache, CACHE_NAMESPACES, cacheHeaders, searchParamsKey } from '@/lib/cache';

const result = await withCache(CACHE_NAMESPACES.BUSES, searchParamsKey(req), async () => {
  return { buses: await prisma.bus.findMany() };
});

return NextResponse.json(result.data, { headers: cacheHeaders(result) });
// -> X-Cache: HIT | MISS, X-Cache-Source: redis | memory
```

Namespaces and TTLs:

| Namespace | TTL | Cached by |
| --- | --- | --- |
| `routes`, `stops`, `reports`, `maintenance` | 60s | query string |
| `buses`, `schedules`, `dashboard`, `assignments` | 30s | query string / `admin` |
| `trips` | 15s | query string |
| `notifications` | 10s | **`<role>:<query>`** |

> `notifications` **must** include the role in the key — the feed is
> role-scoped, so omitting it would leak an admin's notifications to a
> passenger. `trips`/`notifications` use short TTLs because the UI polls them.

Every mutating handler calls `invalidate(...)` for the namespaces it affects
(e.g. creating a schedule flushes `SCHEDULES`, `BUSES`, `DASHBOARD`).

### 2. BullMQ message broker (`src/lib/queue.js` + `worker/index.mjs`)

Two queues:

| Queue | Jobs | Notes |
| --- | --- | --- |
| `notifications` | `notification.create`, `notification.broadcast`, `notification.emergency` | 5 attempts, exponential backoff |
| `audit` | `audit.log` | 10-way concurrency |

Route handlers call the `src/lib/enqueue.js` facade rather than touching queues:

```js
await enqueueNotification({ userRole: 'PASSENGER', type: 'ROUTE_CREATED', title, message, link });
await enqueueBroadcast({ roles: ['ADMIN','DRIVER','PASSENGER'], type, title, message });
await enqueueEmergencyBroadcast({ message, userId });
```

These never reject: a failed enqueue falls back to inline execution, because a
notification is a side effect that must not fail the user's booking.

**Start the worker** (required only when `REDIS_URL` is set):

```bash
npm run worker
```

Job handlers live in `src/lib/jobs/*.jobs.mjs` as plain ESM with **no imports** —
Prisma is injected as `{ prisma }`. That lets the *same file* load in both the
Next.js bundle (where `@/lib/prisma` resolves) and the standalone worker (plain
Node, no bundler, no path aliases).

> ⚠️ If `REDIS_URL` is set but no worker is running, jobs queue up and are never
> written. `GET /api/health` reports `queue.deliveryMode` and
> `queue.pendingJobs` so this misconfiguration is visible.

### 3. Manual rate limiting

No third-party limiter library — two algorithms are implemented directly with
Redis Lua scripts, each mirrored by an in-process fallback.

| Algorithm | Redis implementation | Trade-off |
| --- | --- | --- |
| `fixed` (default) | `INCR` + `PEXPIRE` in one Lua script | One round trip; a burst at a window boundary can reach 2x |
| `sliding` | Sorted set trimmed by score, in one Lua script | Exact; stores one member per request |

Lua is used rather than `MULTI`/`EXEC` because check-and-increment must be
atomic — reading the counter in Node and writing it back is a TOCTOU race that
lets concurrent requests overshoot the limit.

**Identity** (`getRateLimitIdentity`): authenticated callers are keyed by user
id, anonymous callers by IP (left-most `x-forwarded-for` hop). Keying logged-in
users by id prevents one noisy user from exhausting the allowance of everyone
behind the same campus NAT.

**Policies** (`RATE_LIMITS`):

| Policy | Limit | Window | Algorithm | Applied to |
| --- | --- | --- | --- | --- |
| `LOGIN` | 10 | 60s | sliding | per IP **and** per email |
| `REGISTER` | 5 | 60s | sliding | per IP **and** per email |
| `QR_VERIFY` | 60 | 60s | sliding | bus pass verification |
| `BROADCAST` | 5 | 60s | fixed | emergency broadcast |
| `REPORTS` | 30 | 60s | fixed | `/api/reports` |
| `BOOKING_WRITE` | 20 | 60s | fixed | booking creation |
| `BULK_WRITE` | 15 | 60s | fixed | bus passes |
| `COLLECTION_WRITE` | 40 | 60s | fixed | generic CRUD writes |
| `DASHBOARD` / `ACTIVITY_LOGS` | 60 | 60s | fixed | dashboard, audit trail |
| `COLLECTION_READ` | 120 | 60s | fixed | generic CRUD reads |
| `DEFAULT` | 100 | 60s | fixed | anything unlisted |

Applying a limit in a handler:

```js
const limited = await enforceRateLimit(req, 'COLLECTION_READ', { user });
if (limited) return limited;   // ready-made 429, or null when allowed
```

Rejections return `429` with `Retry-After`, `RateLimit-*` and `X-RateLimit-*`
headers plus a JSON body `{ error, code: 'RATE_LIMITED', retryAfter, limit }`.

**Failure policy is fail-open.** Rate limiting is a protection layer, not an
authorization check — refusing all traffic because Redis blipped would turn a
cache outage into a full outage. On Redis trouble the limiter degrades to
in-process counters. A circuit breaker (`src/lib/redis.js`) skips Redis entirely
for 30s after 3 consecutive failures so an outage never costs a connection
timeout per request.

### 4. Frontend rate limiting

The server is always authoritative; the client layer exists to avoid *making* a
doomed request. Two mechanisms, deliberately layered:

1. **Local buckets** (`src/utils/clientRateLimit.js`) — a manual
   sliding-window counter in `sessionStorage`, mirroring the server policies
   (slightly tighter, so the client defers first). Stops double-clicks,
   Enter-key spam and tight polling loops.
2. **Server-signalled cooldown** (`applyServerRateLimit`) — when the API does
   answer `429`, `Retry-After` is trusted and a hard cooldown is installed.
   This is what actually keeps client and server in agreement, since the local
   bucket cannot know about other tabs, devices, or clients behind the same IP.

`services/client.js` wires both in: the request interceptor short-circuits
known-limited actions, the response interceptor folds `429`s back into the
cooldown.

For live countdown UI use the hook:

```jsx
import { useRateLimit } from '@/hooks/useRateLimit';

const limiter = useRateLimit('login');

const onSubmit = async (e) => {
  e.preventDefault();
  const verdict = limiter.guard();          // consumes a local token
  if (!verdict.allowed) return setError(verdict.message);

  try {
    await login(email, password);
    limiter.reset();                        // clear on success
  } catch (err) {
    if (limiter.handleError(err)) return;   // installs cooldown from Retry-After
    throw err;
  }
};

// <Button disabled={limiter.isLimited}>
//   {limiter.isLimited ? `Try again in ${limiter.waitLabel}` : 'Sign In'}
// </Button>
```

The hook ticks once per second **only while blocked**, so idle pages run no
timers. Implemented in the login and register pages; `CLIENT_LIMITS` covers
`login`, `register`, `booking-create`, `feedback-submit`, `notification-send`,
`broadcast`, `qr-verify`, `api-read`, `api-write`.

### 5. Observability

`GET /api/health` (admin only) reports Redis status, cache entry counts and
namespace versions, active policies, and queue depth:

```json
{
  "status": "ok",
  "redis": { "configured": true, "status": "ready", "usable": true, "circuitOpenUntil": null },
  "cache": { "entries": 12, "versions": { "buses": 3 } },
  "rateLimiter": { "policies": ["LOGIN", "..."], "buckets": 4, "redisBacked": true },
  "queue": { "configured": true, "deliveryMode": "brokered", "pendingJobs": 0, "workerRequired": true },
  "audit": { "mode": "brokered" }
}
```

### Running Redis locally

```bash
docker run -d --name bus-redis -p 6379:6379 redis:7-alpine
# then, in two terminals:
npm run dev
npm run worker
```

To run entirely without Redis, leave `REDIS_URL` empty — the app is fully
functional, just without shared caching, distributed limits or the queue.

---

## Testing

Vitest, chosen over Jest because the queue layer and the worker are native ESM
(`.mjs`); Vitest runs ESM natively, so those files are imported directly with no
transform shims.

```bash
npm test              # run everything once
npm run test:watch    # watch mode
npm run test:unit     # tests/unit only
npm run test:e2e      # tests/e2e only
npm run test:coverage # v8 coverage -> ./coverage
```

**No infrastructure is required.** There is no Redis server, no database and no
network access: the suites deliberately run against the documented degraded
paths, and a test can opt into the Redis-backed paths via an in-memory double.

### Layout

```
tests/
├── setup.js                    # env defaults + per-test state isolation
├── helpers/
│   ├── fakeRedis.js            # in-memory Redis double (implements both Lua scripts)
│   └── prismaMock.js           # Prisma double + user fixtures
├── unit/
│   ├── cache.test.js           # hit/miss, TTL, version-key invalidation
│   ├── rateLimiter.test.js     # both algorithms, headers, fail-open
│   ├── redis.test.js           # circuit breaker, Lua paths, Redis fallbacks
│   ├── queue.test.js           # inline fallback (no Redis)
│   ├── queueRedis.test.js      # enqueue timeout, queued mode, breaker pre-check
│   ├── enqueue.test.js         # facade wiring end-to-end
│   ├── jobs.test.js            # job handlers against an injected Prisma stub
│   ├── dates.test.js           # local-day helpers + attendance arithmetic
│   ├── prismaMockCoverage.test.js # the Prisma double covers every route usage
│   └── clientRateLimit.test.js # browser limiter + cooldown (jsdom)
└── e2e/
    ├── auth.login.test.js      # real login handler: auth, per-IP + per-email 429
    ├── cacheRoutes.test.js     # X-Cache MISS->HIT, invalidation, role isolation
    ├── attendance.test.js      # attendance read/write path agreement
    ├── health.test.js          # /api/health reporting (admin-only)
    └── healthLive.test.js      # /api/health/live liveness probe
```

### Unit vs end-to-end

The **unit** suites call the modules directly. The **e2e** suites drive the real
route handlers over real `Request`/`NextResponse` objects, mocking *only*
`@/lib/prisma`. That means routing, JWT verification, role checks, caching,
rate limiting and queue dispatch all execute for real — only the database is
stubbed, which keeps the tests fast and dependency-free.

### Notable test design decisions

- **The Redis double implements the Lua scripts**, rather than stubbing
  `eval`. A stub returning canned values would let a broken script pass; this
  double reproduces real counter/sorted-set semantics, so the assertions are
  meaningful.
- **`vi.hoisted` is required** in any file with a `vi.mock` factory. Factories
  are hoisted above the file's imports, so a factory closing over a plain
  module-scope `const` throws `Cannot access 'x' before initialization`. Where
  the helper itself must be loaded, the factory uses
  `await import('../helpers/...')` instead.
- **`setup.js` never imports application modules.** It resets state through
  hooks the modules register on `globalThis` (`__busCacheReset`,
  `__busRateLimitReset`, `__busRedisReset`). Importing `@/lib/cache` there would
  load `ioredis` before a test file's `vi.mock('ioredis')` could apply, so the
  fake would be ignored. This is the reason those hooks exist.
- **Process-global singletons are read through `globalThis`, not captured in
  module-level `const`s.** The Redis circuit breaker originally kept a `const`
  reference to the object it stored on `globalThis`; once tripped it could never
  be reset, so a single failure silently disabled Redis for the whole process —
  and leaked across tests. `resetRedisState()` is the supported reset.
- **The Prisma double's surface is verified against the schema.** A
  hand-maintained mock surface drifts silently: `busPass.findFirst` was once
  omitted, so a test died with `Cannot read properties of undefined` — the
  *double* was wrong, not the application. `prismaMockCoverage.test.js` now
  asserts that every `model` in `prisma/schema.prisma` exists on the mock, that
  each model exposes the full delegate API, and that every
  `prisma.<model>.<method>` (and `tx.<model>.<method>`) actually used in a route
  handler is present. Adding a model or a new call without extending the double
  fails there, with a clear message, instead of surfacing as a confusing
  TypeError in an unrelated test.
- **`restoreMocks` is intentionally off** in `vitest.config.mjs`: it resets mocks
  to their original implementation, which would wipe the Prisma double's default
  behaviour. Isolation is handled explicitly instead.

### Coverage focus

The suite targets the failure modes that actually matter in production:
behaviour when Redis is **absent**, when it **fails mid-request**, and when it is
**configured but unreachable** (the enqueue-timeout case, which would otherwise
hang every write). Cache **invalidation** and **role-scoped key isolation** are
covered end-to-end because getting either wrong is a correctness or a security
bug, not a performance one.

---

## Docker

A single `Dockerfile` produces one image with two roles:

| Role | Command |
| --- | --- |
| Web server | *(default)* `node server.js` |
| BullMQ worker | `npm run worker` |

Running the worker from the **same image** guarantees the API and the worker
execute identical code and identical job handlers — which would not hold if they
were built separately.

### Build and run

```bash
docker build -t bus-scheduling .

# Web server (env comes from .env, which is never baked into the image)
docker run -p 3000:3000 --env-file .env bus-scheduling

# Worker (second container, same image)
docker run --env-file .env bus-scheduling npm run worker
```

With a Redis instance on the host, point the container at it:

```bash
docker run -p 3000:3000 --env-file .env \
  -e REDIS_URL=redis://host.docker.internal:6379 bus-scheduling
```

### What the image does

- **Multi-stage** (`deps` → `builder` → `runner`) so the slow dependency layer is
  cached and not invalidated by source edits.
- Uses Next.js `output: "standalone"`, so the runtime ships a minimal server plus
  only the `node_modules` it needs, instead of the whole dependency tree.
- Copies `bullmq`, `ioredis`, `@prisma` and `.prisma` on top of the standalone
  bundle, because the standalone output prunes packages it thinks are unused and
  the **worker needs them**.
- Runs as a **non-root** user (`nextjs`, uid 1001).
- Ships a `HEALTHCHECK` against the public `/api/health/live` endpoint (not
  `/api/health`, which is admin-only and would return 401 to an unauthenticated
  probe), using `127.0.0.1` rather than `localhost` to avoid resolving to `::1`
  where the server binds IPv4 only.
- `openssl` is installed in every stage because the Prisma query engine links
  against it.

### Prisma binary targets

`prisma/schema.prisma` declares three targets:

| Target | Needed by |
| --- | --- |
| `native` | local development |
| `debian-openssl-3.0.x` | `node:20-bookworm-slim` (this Docker image) |
| `rhel-openssl-3.0.x` | Vercel / Amazon Linux |

Omitting the debian target produces a container that starts and then fails at the
first query with "Query engine binary not found".

### Secrets

`.env` is listed in `.dockerignore`, so it is **never** copied into a layer.
`DATABASE_URL` and `JWT_SECRET` are set to throwaway placeholders during the
build only — `next build` needs a syntactically valid value to construct the
Prisma client but never connects, and the real values are injected at runtime.

> ⚠️ `NEXT_PUBLIC_API_URL` is inlined into the **client** bundle at build time.
> Leave it empty (the default) so the browser calls the same origin; a runtime
> `-e` override cannot change a value that was already compiled in.
## Getting Started

### Prerequisites
- Node.js 18.18+ (see `engines` in `package.json`)
- PostgreSQL database
- npm (or yarn/pnpm)

> **Important:** the app lives in the `my-app/` subfolder — run all commands from there.

### Installation

1. Install dependencies:
```bash
cd my-app
npm install
```

2. Configure environment variables. The repo ships a working `.env`; edit the
   values for your setup (`DATABASE_URL`, `JWT_SECRET`, optionally `REDIS_URL`):
```bash
# .env is already present and gitignored — no copy step needed.
# For production, set the same keys in your host's environment.
```

3. Set up the database:
```bash
npx prisma generate
npx prisma db push        # or: npx prisma migrate deploy
```

4. Run the development server:
```bash
npm run dev
```

5. Open [http://localhost:3000](http://localhost:3000)

6. *(Optional)* Enable Redis, caching and the job queue:
```bash
docker run -d --name bus-redis -p 6379:6379 redis:7-alpine
# set REDIS_URL="redis://localhost:6379" in .env, then in a second terminal:
npm run worker
```

## Environment Variables

| Key | Required | Description |
| --- | --- | --- |
| `DATABASE_URL` | Yes | PostgreSQL connection string. Use a hosted DB on Vercel; append `?pgbouncer=true&connection_limit=1` for pooled serverless connections. |
| `JWT_SECRET` | Yes (prod) | Long random string (`openssl rand -base64 32`). The app throws in production without it. |
| `JWT_EXPIRES_IN` | No | Token lifetime, e.g. `7d` (default `7d`). |
| `NEXT_PUBLIC_API_URL` | No | Leave **empty** so browser requests use the same origin. Set only for an external API host. |
| `REDIS_URL` | No | Redis connection string, e.g. `redis://localhost:6379`. **Leave empty to disable Redis entirely** — caching and rate limiting fall back to per-process memory and jobs run inline. Set it to enable the shared cache, distributed rate limits and the BullMQ worker. |
| `CACHE_TTL_SECONDS` | No | Default cache TTL when a namespace has no specific TTL (default `60`). |
| `CACHE_MEMORY_MAX_ENTRIES` | No | Max entries in the in-process cache fallback before eviction (default `500`). |
| `REDIS_DEBUG` | No | `"true"` logs Redis connection/command failures to the console (default `false`). |
| `RATE_LIMIT_LOG` | No | Reserved for rate-limit logging verbosity (default `warn`). |

## Available Scripts

| Script | Description |
| --- | --- |
| `npm run dev` | Start the development server |
| `npm run worker` | Start the BullMQ worker (`node worker/index.mjs`) — requires `REDIS_URL` |
| `npm test` | Run the full Vitest suite (unit + e2e) |
| `npm run test:watch` | Vitest in watch mode |
| `npm run test:unit` | Unit suites only (`tests/unit`) |
| `npm run test:e2e` | End-to-end route suites only (`tests/e2e`) |
| `npm run test:coverage` | Vitest with v8 coverage → `./coverage` |
| `npm run build` | `prisma generate && next build` |
| `npm run start` | Start the production server |
| `npm run lint` | Run ESLint (`next lint`) |
| `npm run vercel-build` | Build with `prisma migrate deploy` (used by `vercel.json`) |
| `npm run prisma:generate` | Generate the Prisma client |
| `npm run prisma:push` | Push the schema to the database (no migration history) |
| `npm run prisma:migrate` | Apply pending migrations (`prisma migrate deploy`) |
| `npm run prisma:studio` | Open Prisma Studio |

## Deploying to Vercel (Free Tier)

This project is preconfigured to run on the Vercel Hobby (free) plan.

### 1. Push to a Git repository
Commit the project (including `prisma/migrations/`) to GitHub/GitLab/Bitbucket.

### 2. Import the project in Vercel
Import the repository and set the **Root Directory** to `my-app` (the app lives in a subfolder). Vercel auto-detects the Next.js framework; `vercel.json` sets the build command to:

```
prisma generate && prisma migrate deploy && next build
```

### 3. Add environment variables
In **Project → Settings → Environment Variables**, add (for Production, Preview and Development):

| Key | Value |
| --- | --- |
| `DATABASE_URL` | A **hosted** Postgres URL (Neon, Supabase, Vercel Postgres, etc.). For pooled connections append `?pgbouncer=true&connection_limit=1`. |
| `JWT_SECRET` | A long random string, e.g. output of `openssl rand -base64 32`. **Required** — the app refuses to sign tokens in production without it. |
| `JWT_EXPIRES_IN` | Optional, e.g. `7d`. |
| `NEXT_PUBLIC_API_URL` | Leave **empty** so the browser calls the same origin. |
| `REDIS_URL` | Optional. Leave **unset** to run without Redis (in-memory cache/limits, inline jobs). Set it to enable the shared cache and distributed rate limits — but see the worker note below. |

> ⚠️ The default `DATABASE_URL` in `.env` points at `localhost` and will **not** work on Vercel. Always use a hosted database in production.

> ⚠️ **If you set `REDIS_URL` on Vercel, run the worker too.** Serverless
> functions cannot host a long-lived BullMQ worker, so notifications and audit
> logs would queue up and never be written. Either deploy `worker/index.mjs` as a
> separate long-lived service (Render/Railway/Fly.io — the `Dockerfile` in this
> repo works as-is) or leave `REDIS_URL` unset, in which case jobs execute inline
> and everything still works. Check `GET /api/health` for
> `queue.deliveryMode` and `queue.pendingJobs`.

### 4. Deploy
Vercel runs `prisma generate`, applies pending migrations (`prisma migrate deploy`) and builds. The build is statically lint-checked with `.eslintrc.json` (non-interactive).

### Free-tier notes
- All API routes use `runtime = 'nodejs'` and `dynamic = 'force-dynamic'`, so no response is cached and the Node runtime (required by Prisma/bcrypt/jsonwebtoken) is always used.
- Function `maxDuration` is capped at 10s in `vercel.json` to stay within Hobby limits.
- Prisma client generation happens automatically via the `postinstall` script and the build command.
- `socket.io` server usage is not supported on serverless functions and has been removed; real-time behaviour is achieved via polling (`/tracking` auto-refreshes every 30s).

## Troubleshooting

- **`JWT_SECRET is not set` in production** — add `JWT_SECRET` to your host's
  environment variables.
- **Styles are missing / the page looks unstyled** — Tailwind v4 is compiled
  through PostCSS via `postcss.config.mjs`. Ensure that file exists and that
  `@tailwindcss/postcss` is installed; the stylesheet is imported in
  `src/app/globals.css` with `@import "tailwindcss";`.
- **`Query engine not found` / Prisma errors on deploy** — ensure the build runs
  `prisma generate` (the `postinstall` and `build` scripts handle this) and that
  `binaryTargets` includes your host's target (already set to
  `["native", "rhel-openssl-3.0.x"]` for Vercel).
- **Requests fail with 401 after a while** — the JWT expired; the client clears
  the stale session and redirects to `/login`.
- **`Cannot modify stops that have existing bookings`** — a route's stops cannot
  be replaced once bookings reference them; deactivate the route instead.
- **`No seats available for this trip`** — capacity was reached; seat allocation
  is transactional, so concurrent bookings cannot overbook.
- **QR scanner shows "Camera is not available"** — the browser blocks camera
  access on insecure origins. Use `https://` (e.g. on Vercel) or `http://localhost`;
  plain `http://` on a LAN IP will not work. The scanner also needs permission
  granted and no other app holding the camera.

## License

MIT License
