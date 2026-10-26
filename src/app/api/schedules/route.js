import { NextResponse } from 'next/server';
import prisma from '@/lib/prisma';
import { authMiddleware } from '@/middleware/auth';
import { logActivity } from '@/lib/activityLogger';
import { enforceRateLimit } from '@/lib/rateLimiter';
import { enqueueNotification } from '@/lib/enqueue';
import {
  cacheHeaders,
  CACHE_NAMESPACES,
  invalidate,
  searchParamsKey,
  withCache,
} from '@/lib/cache';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// GET all schedules
export async function GET(req) {
  const authResult = await authMiddleware(req, ['ADMIN', 'DRIVER', 'PASSENGER']);
  
  if (authResult instanceof NextResponse) {
    return authResult;
  }

  const limited = await enforceRateLimit(req, 'COLLECTION_READ', {
    user: authResult.user,
  });
  if (limited) return limited;

  try {
    const result = await withCache(
      CACHE_NAMESPACES.SCHEDULES,
      searchParamsKey(req),
      async () => {
        const { searchParams } = new URL(req.url);
        const routeId = searchParams.get('routeId');
        const busId = searchParams.get('busId');
        const scheduleType = searchParams.get('scheduleType');
        const isActive = searchParams.get('isActive');
        const isSpecial = searchParams.get('isSpecial');

        const where = {};
        if (routeId) where.routeId = routeId;
        if (busId) where.busId = busId;
        if (scheduleType) where.scheduleType = scheduleType;
        if (isActive !== null) where.isActive = isActive === 'true';
        if (isSpecial !== null) where.isSpecial = isSpecial === 'true';

        const schedules = await prisma.schedule.findMany({
          where,
          include: {
            route: {
              select: {
                id: true,
                name: true,
              },
            },
            bus: {
              select: {
                id: true,
                busNumber: true,
                plateNumber: true,
              },
            },
          },
          orderBy: {
            departureTime: 'asc',
          },
        });

        return { schedules };
      },
    );

    return NextResponse.json(result.data, { headers: cacheHeaders(result) });
  } catch (error) {
    console.error('Get schedules error:', error);
    return NextResponse.json(
      { error: 'Failed to fetch schedules' },
      { status: 500 }
    );
  }
}

// CREATE schedule (Admin only)
export async function POST(req) {
  const authResult = await authMiddleware(req, ['ADMIN']);
  
  if (authResult instanceof NextResponse) {
    return authResult;
  }

  const limited = await enforceRateLimit(req, 'COLLECTION_WRITE', {
    user: authResult.user,
  });
  if (limited) return limited;

  try {

    const { routeId, busId, scheduleType, departureTime, arrivalTime, daysOfWeek, isSpecial, specialDate, notes, stopTimes } = await req.json();

    // Map frontend schedule type to Prisma enum
    const validScheduleTypes = ['MORNING', 'NOON', 'EVENING', 'SPECIAL'];
    const mappedScheduleType = validScheduleTypes.includes(scheduleType) 
      ? scheduleType 
      : 'MORNING'; // Default to MORNING if invalid type like 'REGULAR'

    if (!routeId || !busId || !scheduleType || !departureTime || !arrivalTime || !daysOfWeek) {
      return NextResponse.json(
        { error: 'Route, bus, schedule type, departure time, arrival time, and days of week are required' },
        { status: 400 }
      );
    }

    // Validate and parse dates
    // Handle time-only format (HH:mm) from input type="time"
    let parsedDepartureTime = new Date(departureTime);
    let parsedArrivalTime = new Date(arrivalTime);

    // If time-only format (e.g., "14:30"), combine with today's date
    if (departureTime && !departureTime.includes('T') && departureTime.includes(':')) {
      const today = new Date().toISOString().split('T')[0];
      parsedDepartureTime = new Date(`${today}T${departureTime}:00`);
    }

    if (arrivalTime && !arrivalTime.includes('T') && arrivalTime.includes(':')) {
      const today = new Date().toISOString().split('T')[0];
      parsedArrivalTime = new Date(`${today}T${arrivalTime}:00`);
    }

    if (isNaN(parsedDepartureTime.getTime()) || isNaN(parsedArrivalTime.getTime())) {
      return NextResponse.json(
        { error: 'Invalid departure time or arrival time format' },
        { status: 400 }
      );
    }

    // Verify route and bus exist
    const [route, bus] = await Promise.all([
      prisma.route.findUnique({ where: { id: routeId } }),
      prisma.bus.findUnique({ where: { id: busId } }),
    ]);

    if (!route) {
      return NextResponse.json(
        { error: 'Route not found' },
        { status: 404 }
      );
    }

    if (!bus) {
      return NextResponse.json(
        { error: 'Bus not found' },
        { status: 404 }
      );
    }

    const schedule = await prisma.schedule.create({
      data: {
        routeId,
        busId,
        scheduleType: mappedScheduleType,
        departureTime: parsedDepartureTime,
        arrivalTime: parsedArrivalTime,
        daysOfWeek,
        isSpecial: isSpecial || false,
        specialDate: specialDate ? new Date(specialDate) : null,
        notes,
      },
      include: {
        route: true,
        bus: true,
      },
    });

    // Notify passengers about new schedule
    await enqueueNotification({
      userRole: "PASSENGER",
      type: "SCHEDULE_CHANGE",
      title: "New Schedule Available",
      message: `New ${scheduleType} schedule for route "${route.name}" - Departure: ${departureTime}`,
      link: "/schedules",
    });

    await logActivity({
      userId: authResult.user.id,
      action: 'CREATE_SCHEDULE',
      details: `Schedule (${schedule.scheduleType}) created for route "${route.name}"`,
      req,
    });

    // Schedules are embedded in the bus list/detail and counted on the dashboard.
    await invalidate(
      CACHE_NAMESPACES.SCHEDULES,
      CACHE_NAMESPACES.BUSES,
      CACHE_NAMESPACES.DASHBOARD,
    );

    return NextResponse.json({

      message: 'Schedule created successfully',
      schedule,
    }, { status: 201 });
  } catch (error) {
    console.error('Create schedule error:', error);
    return NextResponse.json(
      { error: 'Failed to create schedule' },
      { status: 500 }
    );
  }
}
