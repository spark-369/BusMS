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

// GET bus by ID
export async function GET(req, { params }) {
  const { id } = params;
  
  const authResult = await authMiddleware(req, ['ADMIN', 'DRIVER', 'PASSENGER']);
  
  if (authResult instanceof NextResponse) {
    return authResult;
  }

  const limited = await enforceRateLimit(req, 'COLLECTION_READ', {
    user: authResult.user,
  });
  if (limited) return limited;

  try {
    const result = await withCache(CACHE_NAMESPACES.BUSES, `id:${id}`, async () => {
      const bus = await prisma.bus.findUnique({
        where: { id },
        include: {
          driver: {
            select: {
              name: true,
              phone: true,
              email: true,
            },
          },
          schedules: {
            include: {
              route: {
                select: {
                  id: true,
                  name: true,
                },
              },
            },
          },
          bookings: {
            take: 10,
            orderBy: {
              bookingDate: 'desc',
            },
          },
          trips: {
            take: 10,
            orderBy: {
              startTime: 'desc',
            },
          },
          maintenance: {
            take: 10,
            orderBy: {
              scheduledDate: 'desc',
            },
          },
        },
      });

      return bus ? { bus } : null;
    });

    if (!result.data) {
      return NextResponse.json(
        { error: 'Bus not found' },
        { status: 404 }
      );
    }

    return NextResponse.json(result.data, { headers: cacheHeaders(result) });
  } catch (error) {
    console.error('Get bus error:', error);
    return NextResponse.json(
      { error: 'Failed to fetch bus' },
      { status: 500 }
    );
  }
}


// UPDATE bus (Admin only)
export async function PUT(req, { params }) {
  const { id } = params;
  
  const authResult = await authMiddleware(req, ['ADMIN']);
  
  if (authResult instanceof NextResponse) {
    return authResult;
  }

  const limited = await enforceRateLimit(req, 'COLLECTION_WRITE', {
    user: authResult.user,
  });
  if (limited) return limited;

  try {

    const { busNumber, plateNumber, capacity, model, year, fuelType, mileage, status, driverId } = await req.json();

    // Check if bus exists
    const existingBus = await prisma.bus.findUnique({
      where: { id },
    });

    if (!existingBus) {
      return NextResponse.json(
        { error: 'Bus not found' },
        { status: 404 }
      );
    }

    // Check if busNumber or plateNumber already exists for other buses
    if (busNumber || plateNumber) {
      const duplicateBus = await prisma.bus.findFirst({
        where: {
          AND: [
            { id: { not: id } },
            {
              OR: [
                ...(busNumber ? [{ busNumber }] : []),
                ...(plateNumber ? [{ plateNumber }] : []),
              ],
            },
          ],
        },
      });

      if (duplicateBus) {
        return NextResponse.json(
          { error: 'Bus number or plate number already exists' },
          { status: 400 }
        );
      }
    }

    const bus = await prisma.bus.update({
      where: { id },
      data: {
        ...(busNumber && { busNumber }),
        ...(plateNumber && { plateNumber }),
        ...(capacity && { capacity: parseInt(capacity, 10) }),
        ...(model && { model }),
        ...(year && { year: parseInt(year, 10) }),
        ...(fuelType && { fuelType }),
        ...(mileage !== undefined && { mileage: parseInt(mileage, 10) }),
        ...(status && { status }),
        ...(driverId !== undefined && { driverId }),
      },
    });

    await logActivity({
      userId: authResult.user.id,
      action: 'UPDATE_BUS',
      details: `Bus ${bus.busNumber} updated`,
      req,
    });

    await invalidate(CACHE_NAMESPACES.BUSES, CACHE_NAMESPACES.DASHBOARD);

    return NextResponse.json({
      message: 'Bus updated successfully',
      bus,
    });

  } catch (error) {
    console.error('Update bus error:', error);
    return NextResponse.json(
      { error: 'Failed to update bus' },
      { status: 500 }
    );
  }
}

// DELETE bus (Admin only)
export async function DELETE(req, { params }) {
  const { id } = params;
  
  const authResult = await authMiddleware(req, ['ADMIN']);
  
  if (authResult instanceof NextResponse) {
    return authResult;
  }

  const limited = await enforceRateLimit(req, 'COLLECTION_WRITE', {
    user: authResult.user,
  });
  if (limited) return limited;

  try {

    // Check if bus exists
    const existingBus = await prisma.bus.findUnique({
      where: { id },
    });

    if (!existingBus) {
      return NextResponse.json(
        { error: 'Bus not found' },
        { status: 404 }
      );
    }

    // Check if bus has active schedules or trips
    const activeSchedules = await prisma.schedule.count({
      where: { busId: id, isActive: true },
    });

    if (activeSchedules > 0) {
      return NextResponse.json(
        { error: 'Cannot delete bus with active schedules' },
        { status: 400 }
      );
    }

    await prisma.bus.delete({
      where: { id },
    });

    await logActivity({
      userId: authResult.user.id,
      action: 'DELETE_BUS',
      details: `Bus ${existingBus.busNumber} deleted`,
      req,
    });

    await invalidate(
      CACHE_NAMESPACES.BUSES,
      CACHE_NAMESPACES.ASSIGNMENTS,
      CACHE_NAMESPACES.DASHBOARD,
    );

    return NextResponse.json({
      message: 'Bus deleted successfully',
    });

  } catch (error) {
    console.error('Delete bus error:', error);
    return NextResponse.json(
      { error: 'Failed to delete bus' },
      { status: 500 }
    );
  }
}
