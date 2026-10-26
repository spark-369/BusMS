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

// GET driver assignments overview (Admin only)
// Returns every bus with its assigned driver plus the pool of unassigned drivers.
export async function GET(req) {
  const authResult = await authMiddleware(req, ["ADMIN"]);

  if (authResult instanceof NextResponse) {
    return authResult;
  }

  const limited = await enforceRateLimit(req, "COLLECTION_READ", {
    user: authResult.user,
  });
  if (limited) return limited;

  try {
    const result = await withCache(
      CACHE_NAMESPACES.ASSIGNMENTS,
      searchParamsKey(req),
      async () => {
    const { searchParams } = new URL(req.url);
    const status = searchParams.get("status");
    const search = searchParams.get("search");

    const where = {};
    if (status) where.status = status;
    if (search) {
      where.OR = [
        { busNumber: { contains: search, mode: "insensitive" } },
        { plateNumber: { contains: search, mode: "insensitive" } },
        { driver: { name: { contains: search, mode: "insensitive" } } },
      ];
    }

    const [buses, drivers] = await Promise.all([
      prisma.bus.findMany({
        where,
        include: {
          driver: {
            select: {
              id: true,
              name: true,
              email: true,
              phone: true,
              licenseNumber: true,
              isActive: true,
            },
          },
        },
        orderBy: { busNumber: "asc" },
      }),
      // Active drivers not yet assigned to any bus
      prisma.user.findMany({
        where: {
          role: "DRIVER",
          isActive: true,
          bus: null,
        },
        select: {
          id: true,
          name: true,
          email: true,
          phone: true,
          licenseNumber: true,
        },
        orderBy: { name: "asc" },
      }),
    ]);

    const assignedCount = buses.filter((bus) => bus.driver).length;

    return {
      buses,
      availableDrivers: drivers,
      stats: {
        totalBuses: buses.length,
        assignedBuses: assignedCount,
        unassignedBuses: buses.length - assignedCount,
        availableDrivers: drivers.length,
      },
    };
      },
    );

    return NextResponse.json(result.data, { headers: cacheHeaders(result) });
  } catch (error) {
    console.error("Get assignments error:", error);
    return NextResponse.json(
      { error: "Failed to fetch driver assignments" },
      { status: 500 },
    );
  }
}

// ASSIGN a driver to a bus (Admin only)
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
    const { busId, driverId } = await req.json();

    if (!busId || !driverId) {
      return NextResponse.json(
        { error: "Bus and driver are required" },
        { status: 400 },
      );
    }

    const bus = await prisma.bus.findUnique({
      where: { id: busId },
      include: {
        driver: { select: { id: true, name: true } },
      },
    });

    if (!bus) {
      return NextResponse.json({ error: "Bus not found" }, { status: 404 });
    }

    if (bus.driver) {
      return NextResponse.json(
        {
          error: `Bus ${bus.busNumber} is already assigned to ${bus.driver.name}. Unassign first.`,
        },
        { status: 400 },
      );
    }

    const driver = await prisma.user.findUnique({
      where: { id: driverId },
      select: {
        id: true,
        name: true,
        role: true,
        isActive: true,
        bus: { select: { id: true, busNumber: true } },
      },
    });

    if (!driver) {
      return NextResponse.json({ error: "Driver not found" }, { status: 404 });
    }

    if (driver.role !== "DRIVER") {
      return NextResponse.json(
        { error: "Selected user is not a driver" },
        { status: 400 },
      );
    }

    if (!driver.isActive) {
      return NextResponse.json(
        { error: "Cannot assign a deactivated driver" },
        { status: 400 },
      );
    }

    if (driver.bus) {
      return NextResponse.json(
        {
          error: `Driver ${driver.name} is already assigned to bus ${driver.bus.busNumber}`,
        },
        { status: 400 },
      );
    }

    const updatedBus = await prisma.bus.update({
      where: { id: busId },
      data: { driverId },
      include: {
        driver: {
          select: {
            id: true,
            name: true,
            email: true,
            phone: true,
            licenseNumber: true,
          },
        },
      },
    });

    // Notify drivers about the assignment
    await enqueueNotification({
      userRole: "DRIVER",
      type: "SCHEDULE_CHANGE",
      title: "Bus Assignment",
      message: `You have been assigned to bus ${bus.busNumber} (${bus.plateNumber}).`,
      link: "/assignments",
    });

    // Audit trail
    await prisma.activityLog.create({
      data: {
        userId: user.id,
        action: "ASSIGN_DRIVER",
        details: `Driver ${driver.name} assigned to bus ${bus.busNumber} by admin ${user.email}`,
      },
    });

    // Assignments change the bus list, the assignment overview and the
    // dashboard's driver counts.
    await invalidate(
      CACHE_NAMESPACES.ASSIGNMENTS,
      CACHE_NAMESPACES.BUSES,
      CACHE_NAMESPACES.DASHBOARD,
    );

    return NextResponse.json(
      {
        message: "Driver assigned successfully",
        bus: updatedBus,
      },
      { status: 201 },
    );
  } catch (error) {
    console.error("Assign driver error:", error);
    return NextResponse.json(
      { error: "Failed to assign driver" },
      { status: 500 },
    );
  }
}

// UNASSIGN a driver from a bus (Admin only)
export async function DELETE(req) {
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
    const { searchParams } = new URL(req.url);
    const busId = searchParams.get("busId");

    if (!busId) {
      return NextResponse.json(
        { error: "Bus id is required" },
        { status: 400 },
      );
    }

    const bus = await prisma.bus.findUnique({
      where: { id: busId },
      include: {
        driver: { select: { id: true, name: true } },
      },
    });

    if (!bus) {
      return NextResponse.json({ error: "Bus not found" }, { status: 404 });
    }

    if (!bus.driver) {
      return NextResponse.json(
        { error: "This bus has no assigned driver" },
        { status: 400 },
      );
    }

    const updatedBus = await prisma.bus.update({
      where: { id: busId },
      data: { driverId: null },
    });

    // Audit trail
    await prisma.activityLog.create({
      data: {
        userId: user.id,
        action: "UNASSIGN_DRIVER",
        details: `Driver ${bus.driver.name} unassigned from bus ${bus.busNumber} by admin ${user.email}`,
      },
    });

    await invalidate(
      CACHE_NAMESPACES.ASSIGNMENTS,
      CACHE_NAMESPACES.BUSES,
      CACHE_NAMESPACES.DASHBOARD,
    );

    return NextResponse.json({
      message: "Driver unassigned successfully",
      bus: updatedBus,
    });

  } catch (error) {
    console.error("Unassign driver error:", error);
    return NextResponse.json(
      { error: "Failed to unassign driver" },
      { status: 500 },
    );
  }
}
