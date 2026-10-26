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

// GET route by ID
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

    const result = await withCache(CACHE_NAMESPACES.ROUTES, `id:${id}`, async () => {
      const route = await prisma.route.findUnique({
        where: { id },
        include: {
          stops: {
            orderBy: {
              order: 'asc',
            },
          },
          schedules: true,
          trips: true,
        },
      });

      return route ? { route } : null;
    });

    if (!result.data) {
      return NextResponse.json(
        { error: 'Route not found' },
        { status: 404 }
      );
    }

    return NextResponse.json(result.data, { headers: cacheHeaders(result) });
  } catch (error) {
    console.error('Get route error:', error);
    return NextResponse.json(
      { error: 'Failed to fetch route' },
      { status: 500 }
    );
  }
}

// UPDATE route
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
    const { name, description, estimatedDuration, distance, isActive, stops } = await req.json();

    const route = await prisma.route.findUnique({
      where: { id },
    });

    if (!route) {
      return NextResponse.json(
        { error: 'Route not found' },
        { status: 404 }
      );
    }

    // Update route
    const updateData = {};
    if (name) updateData.name = name;
    if (description !== undefined) updateData.description = description;
    if (estimatedDuration !== undefined && estimatedDuration !== '') {
      const parsed = parseInt(estimatedDuration, 10);
      if (!isNaN(parsed)) updateData.estimatedDuration = parsed;
    }
    if (distance !== undefined && distance !== '') {
      const parsed = parseFloat(distance);
      if (!isNaN(parsed)) updateData.distance = parsed;
    }
    if (isActive !== undefined) updateData.isActive = isActive;

    // Update route + stops atomically. Replacing stops is destructive to the
    // Stop rows (and any bookings referencing them), so it is only allowed
    // when none of the route's stops are referenced by a booking.
    const routeWithStops = await prisma.$transaction(async (tx) => {
      await tx.route.update({
        where: { id },
        data: updateData,
      });

      if (stops && Array.isArray(stops)) {
        const routeStops = await tx.stop.findMany({
          where: { routeId: id },
          select: { id: true },
        });
        const stopIds = routeStops.map((s) => s.id);

        if (stopIds.length > 0) {
          const referencingBookings = await tx.booking.count({
            where: { stopId: { in: stopIds } },
          });

          if (referencingBookings > 0) {
            throw new Error("STOPS_IN_USE");
          }
        }

        await tx.stop.deleteMany({ where: { routeId: id } });

        if (stops.length > 0) {
          await tx.stop.createMany({
            data: stops.map((stop, index) => ({
              name: stop.name,
              latitude: parseFloat(stop.latitude) || 0,
              longitude: parseFloat(stop.longitude) || 0,
              address: stop.address,
              order: stop.order || index + 1,
              routeId: id,
            })),
          });
        }
      }

      return tx.route.findUnique({
        where: { id },
        include: {
          stops: {
            orderBy: {
              order: 'asc',
            },
          },
        },
      });
    });

    await logActivity({
      userId: authResult.user.id,
      action: 'UPDATE_ROUTE',
      details: `Route "${routeWithStops?.name || id}" updated`,
      req,
    });

    await invalidate(
      CACHE_NAMESPACES.ROUTES,
      CACHE_NAMESPACES.STOPS,
      CACHE_NAMESPACES.DASHBOARD,
    );

    return NextResponse.json({
      message: 'Route updated successfully',
      route: routeWithStops,
    });

  } catch (error) {
    if (error?.message === "STOPS_IN_USE") {
      return NextResponse.json(
        { error: 'Cannot modify stops that have existing bookings. Deactivate the route instead.' },
        { status: 409 }
      );
    }
    console.error('Update route error:', error);
    return NextResponse.json(
      { error: 'Failed to update route' },
      { status: 500 }
    );
  }
}

// DELETE route (Admin only)
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

    const route = await prisma.route.findUnique({
      where: { id },
    });

    if (!route) {
      return NextResponse.json(
        { error: 'Route not found' },
        { status: 404 }
      );
    }

    // Soft delete - deactivate route
    await prisma.route.update({
      where: { id },
      data: { isActive: false },
    });

    await logActivity({
      userId: authResult.user.id,
      action: 'DEACTIVATE_ROUTE',
      details: `Route "${route.name}" deactivated`,
      req,
    });

    await invalidate(CACHE_NAMESPACES.ROUTES, CACHE_NAMESPACES.DASHBOARD);

    return NextResponse.json({
      message: 'Route deactivated successfully',
    });

  } catch (error) {
    console.error('Delete route error:', error);
    return NextResponse.json(
      { error: 'Failed to deactivate route' },
      { status: 500 }
    );
  }
}
