import { NextResponse } from 'next/server';
import prisma from '@/lib/prisma';
import { authMiddleware } from '@/middleware/auth';
import { enforceRateLimit } from '@/lib/rateLimiter';
import { enqueueEmergencyBroadcast } from '@/lib/enqueue';
import {
  cacheHeaders,
  CACHE_NAMESPACES,
  invalidate,
  withCache,
} from '@/lib/cache';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// GET dashboard data
export async function GET(req) {
  const authResult = await authMiddleware(req, ['ADMIN']);
  
  if (authResult instanceof NextResponse) {
    return authResult;
  }

  const limited = await enforceRateLimit(req, 'DASHBOARD', {
    user: authResult.user,
  });
  if (limited) return limited;

  try {
    // The dashboard runs ~13 aggregate queries. It is admin-only and shared
    // across admins, so a short 30s cache removes almost all of that load
    // without the numbers feeling stale.
    const result = await withCache(CACHE_NAMESPACES.DASHBOARD, 'admin', async () => {
      // Get various counts and statistics
      const [
        totalUsers,
        totalBuses,
        totalRoutes,
        totalSchedules,
        totalTrips,
        activeBuses,
        availableDrivers,
        todayTrips,
        pendingBookings,
        unreadNotifications,
      ] = await Promise.all([
        prisma.user.count(),
        prisma.bus.count(),
        prisma.route.count(),
        prisma.schedule.count(),
        prisma.trip.count(),
        prisma.bus.count({ where: { status: 'ACTIVE' } }),
        prisma.user.count({ where: { role: 'DRIVER', isActive: true } }),
        prisma.trip.count({
          where: {
            startTime: {
              gte: new Date(new Date().setHours(0, 0, 0, 0)),
              lt: new Date(new Date().setHours(23, 59, 59, 999)),
            },
          },
        }),
        prisma.booking.count({ where: { status: 'PENDING' } }),
        prisma.notification.count({ where: { isRead: false } }),
      ]);

      // Get recent trips
      const recentTrips = await prisma.trip.findMany({
        take: 5,
        orderBy: { startTime: 'desc' },
        include: {
          route: { select: { name: true } },
          bus: { select: { busNumber: true } },
          driver: { select: { id: true, name: true, phone: true } },
        },
      });

      // Get upcoming schedules for today
      const today = new Date();
      const dayOfWeek = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'][today.getDay()];
      
      const upcomingSchedules = await prisma.schedule.findMany({
        where: {
          isActive: true,
          daysOfWeek: { has: dayOfWeek },
          departureTime: { gte: today },
        },
        take: 5,
        orderBy: { departureTime: 'asc' },
        include: {
          route: { select: { name: true } },
          bus: { select: { busNumber: true } },
        },
      });

      // Get maintenance alerts
      const maintenanceAlerts = await prisma.maintenance.findMany({
        where: {
          status: { in: ['SCHEDULED', 'IN_PROGRESS'] },
        },
        take: 5,
        orderBy: { scheduledDate: 'asc' },
        include: {
          bus: { select: { busNumber: true, plateNumber: true } },
        },
      });

      return {
        stats: {
          totalUsers,
          totalBuses,
          totalRoutes,
          totalSchedules,
          totalTrips,
          activeBuses,
          availableDrivers,
          todayTrips,
          pendingBookings,
          unreadNotifications,
        },
        recentTrips,
        upcomingSchedules,
        maintenanceAlerts,
      };
    });

    return NextResponse.json(result.data, { headers: cacheHeaders(result) });
  } catch (error) {
    console.error('Get dashboard error:', error);
    return NextResponse.json(
      { error: 'Failed to fetch dashboard data' },
      { status: 500 }
    );
  }
}

// Emergency broadcast (Admin only)
export async function POST(req) {
  const authResult = await authMiddleware(req, ['ADMIN']);
  
  if (authResult instanceof NextResponse) {
    return authResult;
  }

  // A broadcast fans out to every role and is user-visible to the whole
  // organisation, so it is capped far more tightly than a normal write.
  const limited = await enforceRateLimit(req, 'BROADCAST', {
    user: authResult.user,
  });
  if (limited) return limited;

  try {
    const { message, routeId } = await req.json();

    if (!message) {
      return NextResponse.json(
        { error: 'Message is required' },
        { status: 400 }
      );
    }

    // Fan-out + audit trail are handled by the queued job (or inline when Redis
    // is unavailable). `userId` is optional so the audit row is skipped when
    // there is no authenticated user, which is what the original guard did.
    await enqueueEmergencyBroadcast({
      message,
      userId: authResult.user?.id || null,
    });

    // An emergency must appear immediately, so drop the cached dashboard and
    // notification feeds rather than waiting for their TTLs.
    await invalidate(
      CACHE_NAMESPACES.NOTIFICATIONS,
      CACHE_NAMESPACES.DASHBOARD,
    );

    return NextResponse.json({
      message: 'Emergency broadcast sent successfully',
    }, { status: 201 });
  } catch (error) {
    console.error('Emergency broadcast error:', error);
    return NextResponse.json(
      { error: 'Failed to send emergency broadcast' },
      { status: 500 }
    );
  }
}

