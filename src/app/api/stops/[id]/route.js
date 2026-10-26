import { NextResponse } from 'next/server';
import prisma from '@/lib/prisma';
import { authMiddleware } from '@/middleware/auth';
import { enforceRateLimit } from '@/lib/rateLimiter';
import {
  cacheHeaders,
  CACHE_NAMESPACES,
  invalidate,
  withCache,
} from '@/lib/cache';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// GET single stop by ID
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

    const result = await withCache(CACHE_NAMESPACES.STOPS, `id:${id}`, async () => {
      const stop = await prisma.stop.findUnique({
        where: { id },
        include: {
          route: {
            select: {
              id: true,
              name: true,
            },
          },
        },
      });

      return stop ? { stop } : null;
    });

    if (!result.data) {
      return NextResponse.json(
        { error: 'Stop not found' },
        { status: 404 }
      );
    }

    return NextResponse.json(result.data, { headers: cacheHeaders(result) });
  } catch (error) {
    console.error('Get stop error:', error);
    return NextResponse.json(
      { error: 'Failed to fetch stop' },
      { status: 500 }
    );
  }
}

// UPDATE stop
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
    const data = await req.json();

    const existingStop = await prisma.stop.findUnique({
      where: { id },
    });

    if (!existingStop) {
      return NextResponse.json(
        { error: 'Stop not found' },
        { status: 404 }
      );
    }

    // Build update data
    const updateData = {};
    
    if (data.name) updateData.name = data.name;
    if (data.latitude !== undefined) updateData.latitude = parseFloat(data.latitude);
    if (data.longitude !== undefined) updateData.longitude = parseFloat(data.longitude);
    if (data.address !== undefined) updateData.address = data.address;
    if (data.order !== undefined) {
      const parsedOrder = parseInt(data.order, 10);
      if (Number.isFinite(parsedOrder)) updateData.order = parsedOrder;
    }
    if (data.isActive !== undefined) updateData.isActive = data.isActive;

    const stop = await prisma.stop.update({
      where: { id },
      data: updateData,
      include: {
        route: {
          select: {
            id: true,
            name: true,
          },
        },
      },
    });

    return NextResponse.json({
      message: 'Stop updated successfully',
      stop,
    });
  } catch (error) {
    console.error('Update stop error:', error);
    return NextResponse.json(
      { error: 'Failed to update stop' },
      { status: 500 }
    );
  }
}

// DELETE stop (admin only)
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

    const existingStop = await prisma.stop.findUnique({
      where: { id },
    });

    if (!existingStop) {
      return NextResponse.json(
        { error: 'Stop not found' },
        { status: 404 }
      );
    }

    // Check if stop has related bookings
    const relatedBookings = await prisma.booking.findMany({
      where: { stopId: id },
      select: { id: true },
    });

    if (relatedBookings.length > 0) {
      // Instead of deleting, mark as inactive
      await prisma.stop.update({
        where: { id },
        data: { isActive: false },
      });

      await invalidate(CACHE_NAMESPACES.STOPS, CACHE_NAMESPACES.ROUTES);

      return NextResponse.json({
        message: 'Stop has related bookings, so it has been marked as inactive instead of deleted',
      });
    }

    await prisma.stop.delete({
      where: { id },
    });

    await invalidate(CACHE_NAMESPACES.STOPS, CACHE_NAMESPACES.ROUTES);

    return NextResponse.json({
      message: 'Stop deleted successfully',
    });

  } catch (error) {
    console.error('Delete stop error:', error);
    return NextResponse.json(
      { error: 'Failed to delete stop' },
      { status: 500 }
    );
  }
}
