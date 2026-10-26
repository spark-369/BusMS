import { NextResponse } from 'next/server';
import prisma from '@/lib/prisma';
import { authMiddleware } from '@/middleware/auth';
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

// GET all stops
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
      CACHE_NAMESPACES.STOPS,
      searchParamsKey(req),
      async () => {
        const { searchParams } = new URL(req.url);
        const routeId = searchParams.get('routeId');

        const where = {};
        if (routeId) where.routeId = routeId;

        const stops = await prisma.stop.findMany({
          where,
          include: {
            route: {
              select: {
                id: true,
                name: true,
              },
            },
          },
          orderBy: [
            { routeId: 'asc' },
            { order: 'asc' },
          ],
        });

        return { stops };
      },
    );

    return NextResponse.json(result.data, { headers: cacheHeaders(result) });
  } catch (error) {
    console.error('Get stops error:', error);
    return NextResponse.json(
      { error: 'Failed to fetch stops' },
      { status: 500 }
    );
  }
}

// CREATE stop (Admin only)
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

    const { name, latitude, longitude, address, order, routeId } = await req.json();

    if (!name || latitude === undefined || longitude === undefined || !routeId) {
      return NextResponse.json(
        { error: 'Name, latitude, longitude, and routeId are required' },
        { status: 400 }
      );
    }

    const parsedLatitude = parseFloat(latitude);
    const parsedLongitude = parseFloat(longitude);

    if (isNaN(parsedLatitude) || isNaN(parsedLongitude)) {
      return NextResponse.json(
        { error: 'Latitude and longitude must be valid numbers' },
        { status: 400 }
      );
    }

    if (parsedLatitude < -90 || parsedLatitude > 90 || parsedLongitude < -180 || parsedLongitude > 180) {
      return NextResponse.json(
        { error: 'Latitude must be between -90 and 90 and longitude between -180 and 180' },
        { status: 400 }
      );
    }

    // Verify the route exists before creating a stop for it.
    const routeExists = await prisma.route.findUnique({
      where: { id: routeId },
      select: { id: true },
    });

    if (!routeExists) {
      return NextResponse.json(
        { error: 'Route not found' },
        { status: 404 }
      );
    }

    // Get the current max order for this route
    const maxOrderStop = await prisma.stop.findFirst({
      where: { routeId },
      orderBy: { order: 'desc' },
    });

    // Get route info for notification
    const route = await prisma.route.findUnique({
      where: { id: routeId },
    });

    const stop = await prisma.stop.create({
      data: {
        name,
        latitude: parsedLatitude,
        longitude: parsedLongitude,
        address,
        order: order ? parseInt(order, 10) : (maxOrderStop ? maxOrderStop.order + 1 : 1),
        routeId,
      },
    });

    // Notify passengers about new stop
    await enqueueNotification({
      userRole: "PASSENGER",
      type: "SCHEDULE_CHANGE",
      title: "New Stop Added",
      message: `New stop "${name}" added to route "${route?.name || 'Unknown'}"`,
      link: "/stops",
    });

    // A new stop changes the stop list and the route detail (which embeds stops).
    await invalidate(CACHE_NAMESPACES.STOPS, CACHE_NAMESPACES.ROUTES);

    return NextResponse.json({
      message: 'Stop created successfully',
      stop,
    }, { status: 201 });

  } catch (error) {
    console.error('Create stop error:', error);
    return NextResponse.json(
      { error: 'Failed to create stop' },
      { status: 500 }
    );
  }
}
