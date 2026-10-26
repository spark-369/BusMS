import { NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { authMiddleware } from "@/middleware/auth";
import { enforceRateLimit } from "@/lib/rateLimiter";
import { enqueueNotification } from "@/lib/enqueue";
import { dayRange, parseDateOnly, startOfDay, startOfNextDay } from "@/utils/dates";
import { CACHE_NAMESPACES, invalidate } from "@/lib/cache";
import QRCode from "qrcode";
import { v4 as uuidv4 } from "uuid";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET all bookings
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

    const { user } = authResult;
    const { searchParams } = new URL(req.url);
    const status = searchParams.get("status");
    const bookingDate = searchParams.get("bookingDate");
    const userId = searchParams.get("userId");
    const busId = searchParams.get("busId");
    const isUsed = searchParams.get("isUsed");

    const where = {};

    // Passengers can only see their own bookings
    if (user.role === "PASSENGER") {
      where.userId = user.id;
    } else if (userId) {
      where.userId = userId;
    }

    if (status) where.status = status;
    if (busId) where.busId = busId;
    if (isUsed !== null && isUsed !== undefined) {
      where.isUsed = isUsed === "true";
    }
    if (bookingDate) {
      // Local-day window with an exclusive upper bound. `parseDateOnly` keeps a
      // date-only input from being interpreted as UTC midnight (which would
      // shift the window by a day for non-UTC timezones).
      where.bookingDate = {
        gte: startOfDay(parseDateOnly(bookingDate)),
        lt: startOfNextDay(parseDateOnly(bookingDate)),
      };
    }

    const bookings = await prisma.booking.findMany({
      where,
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
      orderBy: {
        bookingDate: "desc",
      },
    });

    return NextResponse.json({ bookings });
  } catch (error) {
    console.error("Get bookings error:", error);
    return NextResponse.json(
      { error: "Failed to fetch bookings" },
      { status: 500 },
    );
  }
}

// CREATE booking
export async function POST(req) {
  const authResult = await authMiddleware(req, ["ADMIN", "PASSENGER"]);

  if (authResult instanceof NextResponse) {
    return authResult;
  }

  // Bookings are the highest-value write in the app (they consume seat
  // inventory), so they get their own tighter policy than generic writes.
  const limited = await enforceRateLimit(req, "BOOKING_WRITE", {
    user: authResult.user,
  });
  if (limited) return limited;

  try {

    const { user } = authResult;
    const { tripId, stopId, bookingDate } = await req.json();

    if (!tripId || !stopId || !bookingDate) {
      return NextResponse.json(
        { error: "Trip, stop, and booking date are required" },
        { status: 400 },
      );
    }

    // Parsed as LOCAL midnight. A bare `new Date(bookingDate)` would parse a
    // date-only string as UTC midnight, so the day window below would be offset
    // for any non-zero UTC timezone and the duplicate check could miss an
    // existing booking on the same local day.
    const parsedBookingDate = parseDateOnly(bookingDate);
    if (isNaN(parsedBookingDate.getTime())) {
      return NextResponse.json(
        { error: "Invalid booking date" },
        { status: 400 },
      );
    }

    // Get the trip to find the bus
    const trip = await prisma.trip.findUnique({
      where: { id: tripId },
      include: {
        bus: true,
        route: true,
      },
    });

    if (!trip) {
      return NextResponse.json(
        { error: "Trip not found" },
        { status: 404 },
      );
    }

    // Local-day bounds for the duplicate check. Named distinctly from the
    // imported helpers to avoid shadowing them.
    const bookingDayStart = dayRange(parsedBookingDate).gte;
    const bookingDayEnd = dayRange(parsedBookingDate).lte;

    // Check if stop exists and belongs to the trip's route
    const stop = await prisma.stop.findUnique({
      where: { id: stopId },
    });

    if (!stop) {
      return NextResponse.json(
        { error: "Stop not found" },
        { status: 404 },
      );
    }

    if (stop.routeId !== trip.routeId) {
      return NextResponse.json(
        { error: "Selected stop does not belong to this trip's route" },
        { status: 400 },
      );
    }

    // Prevent duplicate bookings by the same user for the same trip/day.
    const existingBooking = await prisma.booking.findFirst({
      where: {
        userId: user.id,
        tripId,
        bookingDate: { gte: bookingDayStart, lte: bookingDayEnd },
        status: { in: ["PENDING", "CONFIRMED"] },
      },
    });

    if (existingBooking) {
      return NextResponse.json(
        { error: "You already have an active booking for this trip" },
        { status: 409 },
      );
    }

    function generateSeatNumber(index, seatsPerRow = 4) {
      const row = Math.floor(index / seatsPerRow) + 1;
      const seatLetters = ["A", "B", "C", "D"];
      const column = seatLetters[index % seatsPerRow];
      return `${row}${column}`;
    }

    // Seat allocation + insert must be atomic to avoid overbooking when two
    // requests race for the last seat. Serializable isolation makes the
    // count-then-insert sequence safe.
    const booking = await prisma.$transaction(
      async (tx) => {
        const bookingCount = await tx.booking.count({
          where: {
            tripId,
            bookingDate: { gte: bookingDayStart, lte: bookingDayEnd },
            status: "CONFIRMED",
          },
        });

        if (bookingCount >= trip.bus.capacity) {
          throw new Error("NO_SEATS");
        }

        const seatNumber = generateSeatNumber(bookingCount);
        const qrCodeData = uuidv4();
        const qrCode = await QRCode.toDataURL(qrCodeData);

        return tx.booking.create({
          data: {
            userId: user.id,
            busId: trip.bus.id,
            stopId,
            tripId,
            bookingDate: parsedBookingDate,
            seatNumber,
            status: "CONFIRMED",
            qrCode,
            qrCodeData,
          },
        });
      },
      { isolationLevel: "Serializable" },
    );

    await enqueueNotification({
      userRole: "DRIVER",
      type: "BOOKING_CONFIRMATION",
      title: "New Booking Confirmed",
      message: `New booking for trip on route "${trip.route.name}" - Seat ${booking.seatNumber}`,
      link: "/bookings",
    });

    // A new booking changes the attendance denominators in the daily report.
    await invalidate(CACHE_NAMESPACES.REPORTS, CACHE_NAMESPACES.DASHBOARD);

    return NextResponse.json(
      {
        message: "Booking created successfully",
        booking,
      },
      { status: 201 },
    );
  } catch (error) {
    if (error?.message === "NO_SEATS") {
      return NextResponse.json(
        { error: "No seats available for this trip" },
        { status: 400 },
      );
    }
    console.error("Create booking error:", error);
    return NextResponse.json(
      { error: "Failed to create booking" },
      { status: 500 },
    );
  }
}
