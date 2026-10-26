import { NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { authMiddleware } from "@/middleware/auth";
import { logActivity } from "@/lib/activityLogger";
import { enforceRateLimit } from "@/lib/rateLimiter";
import { enqueueNotification } from "@/lib/enqueue";
import { CACHE_NAMESPACES, invalidate } from "@/lib/cache";
import { startOfDay, startOfNextDay } from "@/utils/dates";
import QRCode from "qrcode";
import { v4 as uuidv4 } from "uuid";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET bus passes
export async function GET(req) {
  const authResult = await authMiddleware(req, ["ADMIN", "PASSENGER"]);

  if (authResult instanceof NextResponse) {
    return authResult;
  }

  const limited = await enforceRateLimit(req, "COLLECTION_READ", {
    user: authResult.user,
  });
  if (limited) return limited;

  try {

    const { user } = authResult;
    const { searchParams } = new URL(req.url);
    const passengerId = searchParams.get("passengerId");

    const where = {};

    if (user.role === "PASSENGER") {
      // For passengers, get their bus pass directly using user ID
      where.passengerId = user.id;
    } else if (passengerId) {
      where.passengerId = passengerId;
    }

    const busPasses = await prisma.busPass.findMany({
      where,
      include: {
        passenger: true,
      },
      orderBy: {
        endDate: "desc",
      },
    });

    return NextResponse.json({ busPasses });
  } catch (error) {
    console.error("Get bus passes error:", error);
    return NextResponse.json(
      { error: "Failed to fetch bus passes" },
      { status: 500 },
    );
  }
}

// CREATE bus pass (Admin only)
export async function POST(req) {
  const authResult = await authMiddleware(req, ["ADMIN"]);

  if (authResult instanceof NextResponse) {
    return authResult;
  }

  const limited = await enforceRateLimit(req, "BULK_WRITE", {
    user: authResult.user,
  });
  if (limited) return limited;

  try {
    const { passengerId, startDate, endDate } = await req.json();

    if (!passengerId || !startDate || !endDate) {
      return NextResponse.json(
        { error: "Passenger ID, start date, and end date are required" },
        { status: 400 },
      );
    }

    // Check if passenger exists
    const passenger = await prisma.user.findUnique({
      where: { id: passengerId },
    });

    if (!passenger) {
      return NextResponse.json({ error: "Passenger not found" }, { status: 404 });
    }

    if (passenger.role !== "PASSENGER") {
      return NextResponse.json(
        { error: "Bus passes can only be issued to passengers" },
        { status: 400 },
      );
    }

    // Validate the date range.
    const parsedStartDate = new Date(startDate);
    const parsedEndDate = new Date(endDate);

    if (isNaN(parsedStartDate.getTime()) || isNaN(parsedEndDate.getTime())) {
      return NextResponse.json(
        { error: "Invalid start date or end date" },
        { status: 400 },
      );
    }

    if (parsedEndDate <= parsedStartDate) {
      return NextResponse.json(
        { error: "End date must be after the start date" },
        { status: 400 },
      );
    }

    // Check if bus pass already exists
    const existingPass = await prisma.busPass.findFirst({
      where: {
        passengerId: passenger.id,
        isActive: true,
        endDate: { gte: new Date() },
      },
    });

    if (existingPass) {
      return NextResponse.json(
        { error: "Active bus pass already exists for this passenger" },
        { status: 400 },
      );
    }

    // Generate pass number and QR code
    const passNumber = `BP-${Date.now()}-${Math.random().toString(36).substr(2, 9).toUpperCase()}`;
    const qrCode = await QRCode.toDataURL(passNumber);

    const busPass = await prisma.busPass.create({
      data: {
        passengerId: passenger.id,
        passNumber,
        startDate: parsedStartDate,
        endDate: parsedEndDate,
        qrCode,
        isActive: true,
      },
      include: {
        passenger: {
          select: {
            id: true,
            name: true,
            email: true,
            passengerId: true,
          },
        },
      },
    });

    // Create notification for the passenger
    await enqueueNotification({
      userRole: "PASSENGER",
      type: "BUS_PASS_CREATED",
      title: "Bus Pass Created",
      message: `Your bus pass (${passNumber}) has been created successfully. Valid until ${new Date(endDate).toLocaleDateString()}`,
      link: "/buspass",
    });

    await logActivity({
      userId: authResult.user.id,
      action: "CREATE_BUS_PASS",
      details: `Bus pass ${passNumber} created for passenger ${passenger.email}`,
      req,
    });

    return NextResponse.json(
      {
        message: "Bus pass created successfully",
        busPass,
      },
      { status: 201 },
    );
  } catch (error) {
    console.error("Create bus pass error:", error);
    return NextResponse.json(
      { error: "Failed to create bus pass" },
      { status: 500 },
    );
  }
}

// Verify QR code (for bus entry)
export async function PUT(req) {
  const authResult = await authMiddleware(req, ["ADMIN", "DRIVER"]);

  if (authResult instanceof NextResponse) {
    return authResult;
  }

  // QR verification is called once per boarding passenger and writes an
  // attendance record, so it gets its own sliding-window policy.
  const limited = await enforceRateLimit(req, "QR_VERIFY", {
    user: authResult.user,
  });
  if (limited) return limited;

  try {
    const { user } = authResult;
    const { qrCode, passNumber } = await req.json();

    // First try to find by passNumber (most reliable)
    let busPass = await prisma.busPass.findFirst({
      where: {
        passNumber: qrCode || passNumber,
        isActive: true,
        endDate: { gte: new Date() },
      },
      include: {
        passenger: true,
      },
    });

    if (!busPass) {
      return NextResponse.json(
        { error: "Invalid or expired bus pass" },
        { status: 404 },
      );
    }

    // Attendance is recorded when a driver verifies a pass: mark today's
    // confirmed bookings for this passenger as used (attended).
    //
    // This window must match the one the reports read path uses, or recorded
    // attendance will not be counted. An exclusive upper bound
    // (`lt: startOfNextDay()`) is used rather than `lte: endOfToday` because the
    // latter silently excludes anything in the final millisecond of the day
    // (e.g. exactly 23:59:59.9995, or a value truncated on write).
    const attendanceResult = await prisma.booking.updateMany({
      where: {
        userId: busPass.passengerId,
        bookingDate: { gte: startOfDay(), lt: startOfNextDay() },
        status: { in: ["CONFIRMED", "COMPLETED"] },
        isUsed: false,
      },
      data: {
        isUsed: true,
      },
    });

    await logActivity({
      userId: user.id,
      action: "VERIFY_BUS_PASS",
      details: `Bus pass ${busPass.passNumber} verified; ${attendanceResult.count} booking(s) marked attended`,
      req,
    });

    // Recording attendance changes what the attendance report shows, but the
    // reports namespace was not being flushed here. Combined with the 60s
    // reports TTL, a driver verifying a pass would still see "0 present" on the
    // Reports page until the cache expired — which is exactly the symptom of the
    // Attendance Summary appearing stuck at 0%.
    await invalidate(CACHE_NAMESPACES.REPORTS, CACHE_NAMESPACES.DASHBOARD);

    return NextResponse.json({
      valid: true,
      busPass: {
        passNumber: busPass.passNumber,
        passengerName: busPass.passenger.name,
        passengerId: busPass.passenger.passengerId,
        endDate: busPass.endDate,
      },
      attendance: {
        marked: attendanceResult.count,
      },
    });
  } catch (error) {
    console.error("Verify QR code error:", error);
    return NextResponse.json(
      { error: "Failed to verify QR code" },
      { status: 500 },
    );
  }
}

// UPDATE bus pass (Admin only)
export async function PATCH(req) {
  const authResult = await authMiddleware(req, ["ADMIN"]);

  if (authResult instanceof NextResponse) {
    return authResult;
  }

  try {
    const { id, startDate, endDate, isActive } = await req.json();

    if (!id) {
      return NextResponse.json(
        { error: "Bus pass ID is required" },
        { status: 400 },
      );
    }

    // Check if bus pass exists
    const existingPass = await prisma.busPass.findUnique({
      where: { id },
    });

    if (!existingPass) {
      return NextResponse.json(
        { error: "Bus pass not found" },
        { status: 404 },
      );
    }

    const updateData = {};

    if (startDate) {
      updateData.startDate = new Date(startDate);
    }
    if (endDate) {
      updateData.endDate = new Date(endDate);
    }
    if (isActive !== undefined) {
      updateData.isActive = isActive;
    }

    const busPass = await prisma.busPass.update({
      where: { id },
      data: updateData,
      include: {
        passenger: {
          select: {
            id: true,
            name: true,
            email: true,
            passengerId: true,
          },
        },
      },
    });

    await logActivity({
      userId: authResult.user.id,
      action: "UPDATE_BUS_PASS",
      details: `Bus pass ${id} updated`,
      req,
    });

    return NextResponse.json({
      message: "Bus pass updated successfully",
      busPass,
    });
  } catch (error) {
    console.error("Update bus pass error:", error);
    return NextResponse.json(
      { error: "Failed to update bus pass" },
      { status: 500 },
    );
  }
}

// DELETE bus pass (Admin only)
export async function DELETE(req) {
  const authResult = await authMiddleware(req, ["ADMIN"]);

  if (authResult instanceof NextResponse) {
    return authResult;
  }

  const limited = await enforceRateLimit(req, "BULK_WRITE", {
    user: authResult.user,
  });
  if (limited) return limited;

  try {
    const { searchParams } = new URL(req.url);
    const id = searchParams.get("id");

    if (!id) {
      return NextResponse.json(
        { error: "Bus pass ID is required" },
        { status: 400 },
      );
    }

    // Check if bus pass exists
    const existingPass = await prisma.busPass.findUnique({
      where: { id },
    });

    if (!existingPass) {
      return NextResponse.json(
        { error: "Bus pass not found" },
        { status: 404 },
      );
    }

    await prisma.busPass.delete({
      where: { id },
    });

    await logActivity({
      userId: authResult.user.id,
      action: "DELETE_BUS_PASS",
      details: `Bus pass ${id} deleted`,
      req,
    });

    return NextResponse.json({
      message: "Bus pass deleted successfully",
    });
  } catch (error) {
    console.error("Delete bus pass error:", error);
    return NextResponse.json(
      { error: "Failed to delete bus pass" },
      { status: 500 },
    );
  }
}
