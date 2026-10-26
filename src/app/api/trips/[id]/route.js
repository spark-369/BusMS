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

// GET trip by ID
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
    const result = await withCache(CACHE_NAMESPACES.TRIPS, `id:${id}`, async () => {
      const trip = await prisma.trip.findUnique({
        where: { id },
        include: {
          route: true,
          bus: true,
          driver: {
            select: {
              name: true,
              phone: true,
            },
          },
          schedule: true,
        },
      });

      return trip ? { trip } : null;
    });

    if (!result.data) {
      return NextResponse.json(
        { error: 'Trip not found' },
        { status: 404 }
      );
    }

    return NextResponse.json(result.data, { headers: cacheHeaders(result) });
  } catch (error) {
    console.error('Get trip error:', error);
    return NextResponse.json(
      { error: 'Failed to fetch trip' },
      { status: 500 }
    );
  }
}

// UPDATE trip (complete/cancel)
export async function PUT(req, { params }) {
  const { id } = params;
  
  const authResult = await authMiddleware(req, ['ADMIN', 'DRIVER']);
  
  if (authResult instanceof NextResponse) {
    return authResult;
  }

  const limited = await enforceRateLimit(req, 'COLLECTION_WRITE', {
    user: authResult.user,
  });
  if (limited) return limited;

  try {

    const { user } = authResult;
    const { status } = await req.json();

    // Check if trip exists
    const trip = await prisma.trip.findUnique({
      where: { id },
    });

    if (!trip) {
      return NextResponse.json(
        { error: 'Trip not found' },
        { status: 404 }
      );
    }

    // If driver, verify they are assigned to this trip
    if (user.role === 'DRIVER') {
      if (trip.driverId !== user.id) {
        return NextResponse.json(
          { error: 'You are not assigned to this trip' },
          { status: 403 }
        );
      }
    }

    const VALID_TRIP_STATUSES = ['SCHEDULED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED'];
    if (status && !VALID_TRIP_STATUSES.includes(status)) {
      return NextResponse.json(
        { error: 'Invalid trip status' },
        { status: 400 }
      );
    }

    // Enforce sane status transitions so completed/cancelled trips are terminal.
    const TERMINAL_STATUSES = ['COMPLETED', 'CANCELLED'];
    if (status && TERMINAL_STATUSES.includes(trip.status) && trip.status !== status) {
      return NextResponse.json(
        { error: `Trip is already ${trip.status.toLowerCase()} and cannot be changed` },
        { status: 400 }
      );
    }

    // Update trip
    const updateData = {};
    
    if (status) {
      updateData.status = status;
      
      if (status === 'COMPLETED') {
        updateData.endTime = new Date();
        updateData.actualEndTime = new Date();
      }

      if (status === 'IN_PROGRESS' && !trip.actualStartTime) {
        updateData.actualStartTime = new Date();
      }
    }

    const updatedTrip = await prisma.trip.update({
      where: { id },
      data: updateData,
      include: {
        route: true,
        bus: true,
        driver: {
          select: {
            id: true,
            name: true,
            phone: true,
          },
        },
      },
    });

    await logActivity({
      userId: user.id,
      action: 'UPDATE_TRIP',
      details: `Trip ${updatedTrip.id} status set to ${updatedTrip.status}`,
      req,
    });

    // Trip status drives the dashboard, reports and the trips list.
    await invalidate(
      CACHE_NAMESPACES.TRIPS,
      CACHE_NAMESPACES.DASHBOARD,
      CACHE_NAMESPACES.REPORTS,
    );

    return NextResponse.json({
      message: `Trip ${status?.toLowerCase() || 'updated'} successfully`,
      trip: updatedTrip,
    });

  } catch (error) {
    console.error('Update trip error:', error);
    return NextResponse.json(
      { error: 'Failed to update trip' },
      { status: 500 }
    );
  }
}

// DELETE trip (Admin only)
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

    // Check if trip exists
    const trip = await prisma.trip.findUnique({
      where: { id },
    });

    if (!trip) {
      return NextResponse.json(
        { error: 'Trip not found' },
        { status: 404 }
      );
    }

    // Don't allow deletion of in-progress trips
    if (trip.status === 'IN_PROGRESS') {
      return NextResponse.json(
        { error: 'Cannot delete an in-progress trip' },
        { status: 400 }
      );
    }

    await prisma.trip.delete({
      where: { id },
    });

    await logActivity({
      userId: authResult.user.id,
      action: 'DELETE_TRIP',
      details: `Trip ${id} deleted`,
      req,
    });

    await invalidate(
      CACHE_NAMESPACES.TRIPS,
      CACHE_NAMESPACES.DASHBOARD,
      CACHE_NAMESPACES.REPORTS,
    );

    return NextResponse.json({
      message: 'Trip deleted successfully',
    });

  } catch (error) {
    console.error('Delete trip error:', error);
    return NextResponse.json(
      { error: 'Failed to delete trip' },
      { status: 500 }
    );
  }
}
