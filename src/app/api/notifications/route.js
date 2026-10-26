import { NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { authMiddleware } from "@/middleware/auth";
import { enforceRateLimit } from "@/lib/rateLimiter";
import { enqueueBroadcast, enqueueNotification } from "@/lib/enqueue";
import {
  cacheHeaders,
  CACHE_NAMESPACES,
  invalidate,
  searchParamsKey,
  withCache,
} from "@/lib/cache";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET notifications - filtered by user's role
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

    // Notifications are role-scoped, so the role MUST be part of the cache key —
    // otherwise a passenger could be served an admin's cached feed. The TTL is
    // short (10s) because the navbar polls this and users mark items read.
    const result = await withCache(
      CACHE_NAMESPACES.NOTIFICATIONS,
      `${user.role}:${searchParamsKey(req)}`,
      async () => {
        const { searchParams } = new URL(req.url);
        const isRead = searchParams.get("isRead");
        const type = searchParams.get("type");

        // Filter by user's role - notifications are targeted by role
        // Admin sees all notifications, others see only their role's notifications
        let where;
        if (user.role === 'ADMIN') {
          where = {}; // Admin sees all
        } else {
          where = {
            userRole: user.role,
          };
        }

        if (isRead !== null) where.isRead = isRead === "true";
        if (type) where.type = type;

        const notifications = await prisma.notification.findMany({
          where,
          orderBy: {
            sentAt: "desc",
          },
          take: 50,
        });

        // Get unread count
        let unreadWhere;
        if (user.role === 'ADMIN') {
          unreadWhere = { isRead: false };
        } else {
          unreadWhere = { userRole: user.role, isRead: false };
        }
        const unreadCount = await prisma.notification.count({
          where: unreadWhere,
        });

        return { notifications, unreadCount };
      },
    );

    return NextResponse.json(result.data, { headers: cacheHeaders(result) });
  } catch (error) {
    console.error("Get notifications error:", error);
    return NextResponse.json(
      { error: "Failed to fetch notifications" },
      { status: 500 },
    );
  }
}

// CREATE notification (Admin sends by userRole)
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

    const { type, title, message, userRole, link } = await req.json();

    if (!type || !title || !message) {
      return NextResponse.json(
        { error: "Type, title, and message are required" },
        { status: 400 },
      );
    }

    // Validate notification type
    const validTypes = [
      "SCHEDULE_CHANGE",
      "DELAY",
      "EMERGENCY",
      "BUS_ARRIVING",
      "BOOKING_CONFIRMATION",
      "BUS_PASS_CREATED",
      "MAINTENANCE_CREATED",
      "ROUTE_CREATED",
      "TRIP_STARTED",
      "FEEDBACK_RECEIVED",
      "STOP_CREATED",
      "TRIP_SCHEDULED",
    ];
    if (!validTypes.includes(type)) {
      return NextResponse.json(
        { error: "Invalid notification type" },
        { status: 400 },
      );
    }

    // If userRole is provided, send to users with that role
    if (userRole) {
      // Create a single notification targeted by role (not per-user)
      await enqueueNotification({ userRole, type, title, message, link });
    } else {
      // Create a general notification (sent to all roles). The fan-out is a
      // single transaction inside the job handler rather than three sequential
      // awaited inserts.
      await enqueueBroadcast({
        roles: ["ADMIN", "DRIVER", "PASSENGER"],
        type,
        title,
        message,
        link,
      });
    }

    // The feed is cached per role; a new notification must not be masked by a
    // still-warm cache entry.
    await invalidate(CACHE_NAMESPACES.NOTIFICATIONS);

    return NextResponse.json(
      {
        message: "Notification sent successfully",
      },
      { status: 201 },
    );

  } catch (error) {
    console.error("Create notification error:", error);
    return NextResponse.json(
      { error: "Failed to send notification" },
      { status: 500 },
    );
  }
}

// Mark notifications as read or delete
export async function PUT(req) {
  const authResult = await authMiddleware(req, ["ADMIN", "DRIVER", "PASSENGER"]);

  if (authResult instanceof NextResponse) {
    return authResult;
  }

  const limited = await enforceRateLimit(req, "COLLECTION_WRITE", {
    user: authResult.user,
  });
  if (limited) return limited;

  try {

    const { user } = authResult;
    const { notificationIds, markAllRead, deleteNotificationIds } =
      await req.json();

    // Handle mark as read - filter by user's role
    if (markAllRead) {
      if (user.role === 'ADMIN') {
        await prisma.notification.updateMany({
          where: {
            isRead: false,
          },
          data: {
            isRead: true,
          },
        });
      } else {
        await prisma.notification.updateMany({
          where: {
            userRole: user.role,
            isRead: false,
          },
          data: {
            isRead: true,
          },
        });
      }
    } else if (notificationIds && Array.isArray(notificationIds)) {
      if (user.role === 'ADMIN') {
        await prisma.notification.updateMany({
          where: {
            id: { in: notificationIds },
          },
          data: {
            isRead: true,
          },
        });
      } else {
        await prisma.notification.updateMany({
          where: {
            id: { in: notificationIds },
            userRole: user.role,
          },
          data: {
            isRead: true,
          },
        });
      }
    }

    // Handle delete (admin can delete any, users can delete their own)
    if (deleteNotificationIds && Array.isArray(deleteNotificationIds)) {
      if (user.role === "ADMIN") {
        // Admin can delete any notification
        await prisma.notification.deleteMany({
          where: {
            id: { in: deleteNotificationIds },
          },
        });
      } else {
        // Users can only delete notifications for their role
        await prisma.notification.deleteMany({
          where: {
            id: { in: deleteNotificationIds },
            userRole: user.role,
          },
        });
      }
    }

    // Both branches above change read/unread state or delete rows, which the
    // cached per-role feed reflects.
    await invalidate(CACHE_NAMESPACES.NOTIFICATIONS);

    return NextResponse.json({
      message: "Operation completed successfully",
    });

  } catch (error) {
    console.error("Mark read/delete error:", error);
    return NextResponse.json(
      { error: "Failed to process request" },
      { status: 500 },
    );
  }
}

// DELETE notifications (admin only)
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

    const { searchParams } = new URL(req.url);
    const notificationId = searchParams.get("id");

    if (notificationId) {
      await prisma.notification.delete({
        where: { id: notificationId },
      });
    } else {
      // Delete all read notifications (cleanup)
      await prisma.notification.deleteMany({
        where: {
          isRead: true,
        },
      });
    }

    await invalidate(CACHE_NAMESPACES.NOTIFICATIONS);

    return NextResponse.json({
      message: "Notification deleted successfully",
    });

  } catch (error) {
    console.error("Delete notification error:", error);
    return NextResponse.json(
      { error: "Failed to delete notification" },
      { status: 500 },
    );
  }
}
