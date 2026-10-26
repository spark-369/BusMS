import { NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { authMiddleware } from "@/middleware/auth";
import { logActivity } from "@/lib/activityLogger";
import { enforceRateLimit } from "@/lib/rateLimiter";
import {
  cacheHeaders,
  CACHE_NAMESPACES,
  invalidate,
  searchParamsKey,
  withCache,
} from "@/lib/cache";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET all buses
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
    // Cache-aside: the query is shared by every role (no role-dependent
    // filtering), so the cache key only needs the query string.
    const result = await withCache(
      CACHE_NAMESPACES.BUSES,
      searchParamsKey(req),
      async () => {
        const { searchParams } = new URL(req.url);
        const status = searchParams.get("status");

        const where = {};
        if (status) where.status = status;

        const buses = await prisma.bus.findMany({
          where,
          include: {
            driver: {
              select: {
                name: true,
                phone: true,
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
              take: 5,
            },
          },
          orderBy: {
            busNumber: "asc",
          },
        });

        return { buses };
      },
    );

    return NextResponse.json(result.data, { headers: cacheHeaders(result) });
  } catch (error) {
    console.error("Get buses error:", error);
    return NextResponse.json(
      { error: "Failed to fetch buses" },
      { status: 500 },
    );
  }
}

// CREATE bus (Admin only)
export async function POST(req) {
  const authResult = await authMiddleware(req, ["ADMIN"]);

  if (authResult instanceof NextResponse) {
    return authResult;
  }

  const limited = await enforceRateLimit(req, "COLLECTION_WRITE", {
    user: authResult.user,
  });
  if (limited) return limited;

  try {

    const { user } = authResult;
    const { busNumber, plateNumber, capacity, model, year, fuelType, mileage } =
      await req.json();

    if (!busNumber || !plateNumber || !capacity) {
      return NextResponse.json(
        { error: "Bus number, plate number, and capacity are required" },
        { status: 400 },
      );
    }

    const parsedCapacity = parseInt(capacity, 10);
    if (!Number.isFinite(parsedCapacity) || parsedCapacity <= 0) {
      return NextResponse.json(
        { error: "Capacity must be a positive number" },
        { status: 400 },
      );
    }

    // Check if bus number or plate number already exists
    const existingBus = await prisma.bus.findFirst({
      where: {
        OR: [{ busNumber }, { plateNumber }],
      },
    });

    if (existingBus) {
      return NextResponse.json(
        { error: "Bus number or plate number already exists" },
        { status: 400 },
      );
    }

    const bus = await prisma.bus.create({
      data: {
        busNumber,
        plateNumber,
        capacity: parsedCapacity,
        model,
        year: year ? parseInt(year, 10) : null,
        fuelType: fuelType || "DIESEL",
        mileage: mileage ? parseInt(mileage, 10) : 0,
      },
    });

    await logActivity({
      userId: user.id,
      action: "CREATE_BUS",
      details: `Bus ${bus.busNumber} (${bus.plateNumber}) created`,
      req,
    });

    // Buses feed the bus list, the driver-assignment view and the dashboard
    // counters, so all three namespaces are flushed.
    await invalidate(
      CACHE_NAMESPACES.BUSES,
      CACHE_NAMESPACES.ASSIGNMENTS,
      CACHE_NAMESPACES.DASHBOARD,
    );

    return NextResponse.json(
      {
        message: "Bus created successfully",
        bus,
      },
      { status: 201 },
    );
  } catch (error) {
    console.error("Create bus error:", error);
    return NextResponse.json(
      { error: "Failed to create bus" },
      { status: 500 },
    );
  }
}
