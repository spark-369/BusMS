import { NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { authMiddleware } from "@/middleware/auth";
import { enforceRateLimit } from "@/lib/rateLimiter";
import { enqueueNotification } from "@/lib/enqueue";
import {
  cacheHeaders,
  CACHE_NAMESPACES,
  invalidate,
  searchParamsKey,
  withCache,
} from "@/lib/cache";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET all trips
export async function GET(req) {
  const authResult = await authMiddleware(req, ["ADMIN", "DRIVER", "PASSENGER"]);

  if (authResult instanceof NextResponse) {
    return authResult;
  }

  const limited = await enforceRateLimit(req, "COLLECTION_READ", {
    user: authResult.user,
  });
  if (limited) return limited;

  try {
    // Short TTL (15s): trips are the one collection that changes during the day
    // as drivers start/complete them, and the UI polls this list.
    const result = await withCache(
      CACHE_NAMESPACES.TRIPS,
      searchParamsKey(req),
      async () => {
        const { searchParams } = new URL(req.url);
        const routeId = searchParams.get("routeId");
        const busId = searchParams.get("busId");
        const date = searchParams.get("date");

        const where = {};
        if (routeId) where.routeId = routeId;
        if (busId) where.busId = busId;
        if (date) {
          where.startTime = {
            gte: new Date(date),
            lt: new Date(new Date(date).setDate(new Date(date).getDate() + 1)),
          };
        }

        const trips = await prisma.trip.findMany({
          where,
          include: {
            route: {
              select: {
                id: true,
                name: true,
                estimatedDuration: true,
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
            driver: {
              select: {
                id: true,
                name: true,
                licenseNumber: true,
              },
            },
          },
          orderBy: {
            startTime: "asc",
          },
        });

        return { trips };
      },
    );

    return NextResponse.json(result.data, { headers: cacheHeaders(result) });
  } catch (error) {
    console.error("Get trips error:", error);
    return NextResponse.json(
      { error: "Failed to fetch trips" },
      { status: 500 },
    );
  }
}

// CREATE trip (Admin or Driver)
export async function POST(req) {
  const authResult = await authMiddleware(req, ["ADMIN", "DRIVER"]);

  if (authResult instanceof NextResponse) {
    return authResult;
  }

  const limited = await enforceRateLimit(req, "COLLECTION_WRITE", {
    user: authResult.user,
  });
  if (limited) return limited;

  try {

    const body = await req.json();
    const { scheduleId } = body;

    // Validate scheduleId is provided
    if (!scheduleId) {
      return NextResponse.json(
        { error: "Schedule ID is required" },
        { status: 400 },
      );
    }

    // Get route and bus from schedule
    const schedule = await prisma.schedule.findUnique({
      where: { id: scheduleId },
      include: {
        route: true,
        bus: true,
      },
    });

    if (!schedule) {
      return NextResponse.json(
        { error: "Schedule not found" },
        { status: 404 },
      );
    }

    console.log(schedule);

    const selectedRoute = schedule.route;
    const selectedBus = schedule.bus;
    const routeId = selectedRoute.id;
    const busId = selectedBus.id;
    
    // Use current time as start time
    const departureTime = new Date().toISOString();
    
    // Calculate end time based on schedule's arrival time difference
    const scheduleDeparture = new Date(schedule.departureTime);
    const scheduleArrival = new Date(schedule.arrivalTime);
    const duration = scheduleArrival.getTime() - scheduleDeparture.getTime();
    const arrivalTime = new Date(new Date().getTime() + duration).toISOString();

    // Verify that the bus exists
    if (!selectedBus) {
      return NextResponse.json({ error: "Bus not found" }, { status: 404 });
    }

    // Verify that the route exists
    if (!selectedRoute) {
      return NextResponse.json({ error: "Route not found" }, { status: 404 });
    }

    // Get current user as driver
    let driver = null;
    const currentUserId = authResult.user?.id;

    // Use current logged in user as driver
    if (currentUserId) {
      driver = await prisma.user.findFirst({
        where: {
          id: currentUserId,
          role: "DRIVER",
          isActive: true,
        },
      });
    }

    const trip = await prisma.trip.create({
      data: {
        scheduleId,
        routeId,
        busId,
        driverId: driver?.id || null,
        startTime: new Date(departureTime),
        endTime: new Date(arrivalTime),
        status: "SCHEDULED",
      },
    });

    // Notify passengers about new trip
    await enqueueNotification({
      userRole: "PASSENGER",
      type: "TRIP_SCHEDULED",
      title: "New Trip Scheduled",
      message: `New trip scheduled for route "${selectedRoute?.name || "Unknown"}" at ${new Date(departureTime).toLocaleTimeString()}`,
      link: "/trips",
    });

    // A new trip shifts the trip list and the dashboard/report counters.
    await invalidate(
      CACHE_NAMESPACES.TRIPS,
      CACHE_NAMESPACES.DASHBOARD,
      CACHE_NAMESPACES.REPORTS,
    );

    return NextResponse.json(
      {
        message: "Trip created successfully",
        trip: {
          ...trip,
          route: {
            id: selectedRoute.id,
            name: selectedRoute.name,
          },
          bus: {
            id: selectedBus.id,
            busNumber: selectedBus.busNumber,
          },
          driver: driver
            ? {
                id: driver.id,
                name: driver.name,
              }
            : null,
        },
      },
      { status: 201 },
    );
  } catch (error) {
    console.error("Create trip error:", error);
    return NextResponse.json(
      { error: "Failed to create trip" },
      { status: 500 },
    );
  }
}
