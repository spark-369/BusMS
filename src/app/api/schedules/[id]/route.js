import { NextResponse } from 'next/server';
import prisma from '@/lib/prisma';
import { authMiddleware } from '@/middleware/auth';
import { logActivity } from '@/lib/activityLogger';
import { enforceRateLimit } from '@/lib/rateLimiter';
import {
  cacheHeaders,
  CACHE_NAMESPACES,
  invalidate,
  withCache,
} from '@/lib/cache';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// GET schedule by ID
export async function GET(req, { params }) {
  const authResult = await authMiddleware(req, ['ADMIN', 'DRIVER', 'PASSENGER']);
  
  if (authResult instanceof NextResponse) {
    return authResult;
  }

  const limited = await enforceRateLimit(req, 'COLLECTION_READ', {
    user: authResult.user,
  });
  if (limited) return limited;

  try {
    const { id } = params;

    const result = await withCache(
      CACHE_NAMESPACES.SCHEDULES,
      `id:${id}`,
      async () => {
        const schedule = await prisma.schedule.findUnique({
          where: { id },
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
        });

        return schedule ? { schedule } : null;
      },
    );

    if (!result.data) {
      return NextResponse.json(
        { error: 'Schedule not found' },
        { status: 404 }
      );
    }

    return NextResponse.json(result.data, { headers: cacheHeaders(result) });
  } catch (error) {
    console.error('Get schedule error:', error);
    return NextResponse.json(
      { error: 'Failed to fetch schedule' },
      { status: 500 }
    );
  }
}

// UPDATE schedule
export async function PUT(req, { params }) {
  const authResult = await authMiddleware(req, ['ADMIN']);
  
  if (authResult instanceof NextResponse) {
    return authResult;
  }

  const limited = await enforceRateLimit(req, 'COLLECTION_WRITE', {
    user: authResult.user,
  });
  if (limited) return limited;

  try {

    const { id } = params;
    const { routeId, busId, scheduleType, departureTime, arrivalTime, daysOfWeek, isActive, isSpecial, specialDate, notes } = await req.json();

    const schedule = await prisma.schedule.findUnique({
      where: { id },
    });

    if (!schedule) {
      return NextResponse.json(
        { error: 'Schedule not found' },
        { status: 404 }
      );
    }

    // Handle time-only format for departureTime and arrivalTime
    let parsedDepartureTime = departureTime ? new Date(departureTime) : undefined;
    let parsedArrivalTime = arrivalTime ? new Date(arrivalTime) : undefined;

    if (departureTime && !departureTime.includes('T') && departureTime.includes(':')) {
      const today = new Date().toISOString().split('T')[0];
      parsedDepartureTime = new Date(`${today}T${departureTime}:00`);
    }

    if (arrivalTime && !arrivalTime.includes('T') && arrivalTime.includes(':')) {
      const today = new Date().toISOString().split('T')[0];
      parsedArrivalTime = new Date(`${today}T${arrivalTime}:00`);
    }

    // Validate dates if provided
    if (parsedDepartureTime && isNaN(parsedDepartureTime.getTime())) {
      return NextResponse.json(
        { error: 'Invalid departure time format' },
        { status: 400 }
      );
    }

    if (parsedArrivalTime && isNaN(parsedArrivalTime.getTime())) {
      return NextResponse.json(
        { error: 'Invalid arrival time format' },
        { status: 400 }
      );
    }

    // Map frontend schedule type to Prisma enum
    const validScheduleTypes = ['MORNING', 'NOON', 'EVENING', 'SPECIAL'];
    const mappedScheduleType = scheduleType && validScheduleTypes.includes(scheduleType) 
      ? scheduleType 
      : undefined;

    // Update schedule
    const updateData = {};
    if (routeId) updateData.routeId = routeId;
    if (busId) updateData.busId = busId;
    if (mappedScheduleType) updateData.scheduleType = mappedScheduleType;
    if (parsedDepartureTime) updateData.departureTime = parsedDepartureTime;
    if (parsedArrivalTime) updateData.arrivalTime = parsedArrivalTime;
    if (daysOfWeek) updateData.daysOfWeek = daysOfWeek;
    if (isActive !== undefined) updateData.isActive = isActive;
    if (isSpecial !== undefined) updateData.isSpecial = isSpecial;
    if (specialDate) updateData.specialDate = new Date(specialDate);
    if (notes !== undefined) updateData.notes = notes;

    const updatedSchedule = await prisma.schedule.update({
      where: { id },
      data: updateData,
    });

    const scheduleWithRelations = await prisma.schedule.findUnique({
      where: { id },
      include: {
        route: true,
        bus: true,
      },
    });

    await logActivity({
      userId: authResult.user.id,
      action: 'UPDATE_SCHEDULE',
      details: `Schedule ${id} updated`,
      req,
    });

    await invalidate(
      CACHE_NAMESPACES.SCHEDULES,
      CACHE_NAMESPACES.BUSES,
      CACHE_NAMESPACES.DASHBOARD,
    );

    return NextResponse.json({
      message: 'Schedule updated successfully',
      schedule: scheduleWithRelations,
    });

  } catch (error) {
    console.error('Update schedule error:', error);
    return NextResponse.json(
      { error: 'Failed to update schedule' },
      { status: 500 }
    );
  }
}

// DELETE schedule (Admin only)
export async function DELETE(req, { params }) {
  const authResult = await authMiddleware(req, ['ADMIN']);
  
  if (authResult instanceof NextResponse) {
    return authResult;
  }

  const limited = await enforceRateLimit(req, 'COLLECTION_WRITE', {
    user: authResult.user,
  });
  if (limited) return limited;

  try {

    const { id } = params;

    const schedule = await prisma.schedule.findUnique({
      where: { id },
    });

    if (!schedule) {
      return NextResponse.json(
        { error: 'Schedule not found' },
        { status: 404 }
      );
    }

    // Soft delete - deactivate schedule
    await prisma.schedule.update({
      where: { id },
      data: { isActive: false },
    });

    await logActivity({
      userId: authResult.user.id,
      action: 'DEACTIVATE_SCHEDULE',
      details: `Schedule ${id} deactivated`,
      req,
    });

    await invalidate(CACHE_NAMESPACES.SCHEDULES, CACHE_NAMESPACES.DASHBOARD);

    return NextResponse.json({
      message: 'Schedule deactivated successfully',
    });

  } catch (error) {
    console.error('Delete schedule error:', error);
    return NextResponse.json(
      { error: 'Failed to deactivate schedule' },
      { status: 500 }
    );
  }
}
