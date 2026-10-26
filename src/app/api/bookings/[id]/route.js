import { NextResponse } from 'next/server';
import prisma from '@/lib/prisma';
import { authMiddleware } from '@/middleware/auth';
import { logActivity } from '@/lib/activityLogger';
import { enforceRateLimit } from '@/lib/rateLimiter';
import { CACHE_NAMESPACES, invalidate } from '@/lib/cache';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// GET single booking by ID
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

    const { user } = authResult;
    const { id } = params;

    const booking = await prisma.booking.findUnique({
      where: { id },
      include: {
        user: {
          select: {
            id: true,
            name: true,
            email: true,
            passengerId: true,
          },
        },
        bus: {
          select: {
            id: true,
            busNumber: true,
            plateNumber: true,
            capacity: true,
          },
        },
        stop: true,
        trip: true,
      },
    });

    if (!booking) {
      return NextResponse.json(
        { error: 'Booking not found' },
        { status: 404 }
      );
    }

    // Passengers can only view their own bookings
    if (user.role === 'PASSENGER' && booking.userId !== user.id) {
      return NextResponse.json(
        { error: 'Unauthorized' },
        { status: 403 }
      );
    }

    return NextResponse.json({ booking });
  } catch (error) {
    console.error('Get booking error:', error);
    return NextResponse.json(
      { error: 'Failed to fetch booking' },
      { status: 500 }
    );
  }
}

// UPDATE booking
export async function PUT(req, { params }) {
  const authResult = await authMiddleware(req, ['ADMIN', 'PASSENGER']);
  
  if (authResult instanceof NextResponse) {
    return authResult;
  }

  const limited = await enforceRateLimit(req, 'COLLECTION_WRITE', {
    user: authResult.user,
  });
  if (limited) return limited;

  try {

    const { user } = authResult;
    const { id } = params;
    const data = await req.json();

    const existingBooking = await prisma.booking.findUnique({
      where: { id },
    });

    if (!existingBooking) {
      return NextResponse.json(
        { error: 'Booking not found' },
        { status: 404 }
      );
    }

    // Passengers can only update their own bookings (for cancelling)
    if (user.role === 'PASSENGER') {
      if (existingBooking.userId !== user.id) {
        return NextResponse.json(
          { error: 'Unauthorized' },
          { status: 403 }
        );
      }
      // Passengers can only cancel their bookings
      if (data.status && data.status !== 'CANCELLED') {
        return NextResponse.json(
          { error: 'Passengers can only cancel bookings' },
          { status: 403 }
        );
      }
    }

    // Build update data
    const updateData = {};
    
    if (data.status) {
      updateData.status = data.status;
    }
    if (data.stopId) {
      updateData.stopId = data.stopId;
    }
    if (data.bookingDate) {
      updateData.bookingDate = new Date(data.bookingDate);
    }

    const booking = await prisma.booking.update({
      where: { id },
      data: updateData,
      include: {
        user: {
          select: {
            id: true,
            name: true,
            email: true,
          },
        },
        bus: true,
        stop: true,
      },
    });

    await logActivity({
      userId: user.id,
      action: 'UPDATE_BOOKING',
      details: `Booking ${id} status set to ${booking.status}`,
      req,
    });

    // A status change (e.g. cancelling) alters the attendance figures.
    await invalidate(CACHE_NAMESPACES.REPORTS, CACHE_NAMESPACES.DASHBOARD);

    return NextResponse.json({
      message: 'Booking updated successfully',
      booking,
    });
  } catch (error) {
    console.error('Update booking error:', error);
    return NextResponse.json(
      { error: 'Failed to update booking' },
      { status: 500 }
    );
  }
}

// DELETE booking (admin only)
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

    const existingBooking = await prisma.booking.findUnique({
      where: { id },
    });

    if (!existingBooking) {
      return NextResponse.json(
        { error: 'Booking not found' },
        { status: 404 }
      );
    }

    await prisma.booking.delete({
      where: { id },
    });

    await logActivity({
      userId: authResult.user.id,
      action: 'DELETE_BOOKING',
      details: `Booking ${id} deleted`,
      req,
    });

    await invalidate(CACHE_NAMESPACES.REPORTS, CACHE_NAMESPACES.DASHBOARD);

    return NextResponse.json({
      message: 'Booking deleted successfully',
    });
  } catch (error) {
    console.error('Delete booking error:', error);
    return NextResponse.json(
      { error: 'Failed to delete booking' },
      { status: 500 }
    );
  }
}
