import { NextResponse } from 'next/server';
import prisma from '@/lib/prisma';
import { authMiddleware } from '@/middleware/auth';
import { logActivity } from '@/lib/activityLogger';
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

// GET all maintenance records
export async function GET(req) {
  const authResult = await authMiddleware(req, ['ADMIN']);
  
  if (authResult instanceof NextResponse) {
    return authResult;
  }

  const limited = await enforceRateLimit(req, 'COLLECTION_READ', {
    user: authResult.user,
  });
  if (limited) return limited;

  try {
    const result = await withCache(
      CACHE_NAMESPACES.MAINTENANCE,
      searchParamsKey(req),
      async () => {
    const { searchParams } = new URL(req.url);
    const busId = searchParams.get('busId');
    const status = searchParams.get('status');

    const type = searchParams.get('type');

    const where = {};
    if (busId) where.busId = busId;
    if (status) where.status = status;
    if (type) where.type = type;

    const maintenance = await prisma.maintenance.findMany({
      where,
      include: {
        bus: {
          select: {
            id: true,
            busNumber: true,
            plateNumber: true,
          },
        },
      },
      orderBy: {
        scheduledDate: 'desc',
      },
    });

    return { maintenance };
      },
    );

    return NextResponse.json(result.data, { headers: cacheHeaders(result) });
  } catch (error) {
    console.error('Get maintenance error:', error);
    return NextResponse.json(
      { error: 'Failed to fetch maintenance records' },
      { status: 500 }
    );
  }
}

// CREATE maintenance record
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
    const { user } = authResult;
    const { busId, type, description, scheduledDate, cost, notes } = await req.json();

    if (!busId || !type || !description || !scheduledDate) {
      return NextResponse.json(
        { error: 'Bus, type, description, and scheduled date are required' },
        { status: 400 }
      );
    }

    const validTypes = ['ROUTINE', 'REPAIR', 'BREAKDOWN', 'INSPECTION'];
    if (!validTypes.includes(type)) {
      return NextResponse.json(
        { error: 'Invalid maintenance type' },
        { status: 400 }
      );
    }

    const parsedScheduledDate = new Date(scheduledDate);
    if (isNaN(parsedScheduledDate.getTime())) {
      return NextResponse.json(
        { error: 'Invalid scheduled date' },
        { status: 400 }
      );
    }

    // Check if bus exists
    const bus = await prisma.bus.findUnique({
      where: { id: busId },
    });

    if (!bus) {
      return NextResponse.json(
        { error: 'Bus not found' },
        { status: 404 }
      );
    }

    const maintenance = await prisma.maintenance.create({
      data: {
        busId,
        type,
        description,
        scheduledDate: parsedScheduledDate,
        cost: cost !== undefined && cost !== '' ? parseFloat(cost) : null,
        notes,
        status: 'SCHEDULED',
      },
      include: {
        bus: true,
      },
    });

    // Update bus status if it's a repair or breakdown
    if (type === 'REPAIR' || type === 'BREAKDOWN') {
      await prisma.bus.update({
        where: { id: busId },
        data: { status: 'MAINTENANCE' },
      });
    }

    // Notify drivers about maintenance
    await enqueueNotification({
      userRole: 'DRIVER',
      type: 'MAINTENANCE_CREATED',
      title: 'Bus Maintenance Scheduled',
      message: `Maintenance scheduled for bus ${bus.busNumber} (${type}) on ${parsedScheduledDate.toLocaleDateString()}`,
      link: '/maintenance',
    });

    await logActivity({
      userId: user.id,
      action: 'CREATE_MAINTENANCE',
      details: `Maintenance (${type}) scheduled for bus ${bus.busNumber}`,
      req,
    });

    // Maintenance records surface on the dashboard and in the bus detail view,
    // and a REPAIR/BREAKDOWN also flips the bus status.
    await invalidate(
      CACHE_NAMESPACES.MAINTENANCE,
      CACHE_NAMESPACES.BUSES,
      CACHE_NAMESPACES.DASHBOARD,
    );

    return NextResponse.json({
      message: 'Maintenance record created successfully',
      maintenance,
    }, { status: 201 });
  } catch (error) {
    console.error('Create maintenance error:', error);
    return NextResponse.json(
      { error: 'Failed to create maintenance record' },
      { status: 500 }
    );
  }
}

// UPDATE maintenance status
export async function PUT(req) {
  const authResult = await authMiddleware(req, ['ADMIN']);
  
  if (authResult instanceof NextResponse) {
    return authResult;
  }

  const limited = await enforceRateLimit(req, 'COLLECTION_WRITE', {
    user: authResult.user,
  });
  if (limited) return limited;

  try {
    const { id, status, cost, notes } = await req.json();

    if (!id || !status) {
      return NextResponse.json(
        { error: 'ID and status are required' },
        { status: 400 }
      );
    }

    const validStatuses = ['SCHEDULED', 'IN_PROGRESS', 'COMPLETED'];
    if (!validStatuses.includes(status)) {
      return NextResponse.json(
        { error: 'Invalid status' },
        { status: 400 }
      );
    }

    // Verify the record exists so we return a clean 404 instead of a 500.
    const existing = await prisma.maintenance.findUnique({
      where: { id },
    });

    if (!existing) {
      return NextResponse.json(
        { error: 'Maintenance record not found' },
        { status: 404 }
      );
    }

    const updateData = {
      status,
    };

    if (status === 'COMPLETED') {
      updateData.completedDate = new Date();
    }
    if (cost !== undefined) updateData.cost = cost;
    if (notes) updateData.notes = notes;

    const maintenance = await prisma.maintenance.update({
      where: { id },
      data: updateData,
      include: {
        bus: true,
      },
    });

    // Update bus status if maintenance is completed
    if (status === 'COMPLETED') {
      await prisma.bus.update({
        where: { id: maintenance.busId },
        data: { 
          status: 'ACTIVE',
          lastMaintenance: new Date(),
        },
      });
    }

    await logActivity({
      userId: authResult.user.id,
      action: 'UPDATE_MAINTENANCE',
      details: `Maintenance ${id} status set to ${status}`,
      req,
    });

    await invalidate(
      CACHE_NAMESPACES.MAINTENANCE,
      CACHE_NAMESPACES.BUSES,
      CACHE_NAMESPACES.DASHBOARD,
    );

    return NextResponse.json({
      message: 'Maintenance updated successfully',
      maintenance,
    });

  } catch (error) {
    console.error('Update maintenance error:', error);
    return NextResponse.json(
      { error: 'Failed to update maintenance' },
      { status: 500 }
    );
  }
}

// DELETE maintenance record (Admin only)
export async function DELETE(req) {
  const authResult = await authMiddleware(req, ['ADMIN']);

  if (authResult instanceof NextResponse) {
    return authResult;
  }

  const limited = await enforceRateLimit(req, 'COLLECTION_WRITE', {
    user: authResult.user,
  });
  if (limited) return limited;

  try {
    const { searchParams } = new URL(req.url);
    const id = searchParams.get('id');

    if (!id) {
      return NextResponse.json(
        { error: 'Maintenance record ID is required' },
        { status: 400 }
      );
    }

    const existing = await prisma.maintenance.findUnique({
      where: { id },
    });

    if (!existing) {
      return NextResponse.json(
        { error: 'Maintenance record not found' },
        { status: 404 }
      );
    }

    await prisma.maintenance.delete({
      where: { id },
    });

    await logActivity({
      userId: authResult.user.id,
      action: 'DELETE_MAINTENANCE',
      details: `Maintenance record ${id} deleted`,
      req,
    });

    await invalidate(
      CACHE_NAMESPACES.MAINTENANCE,
      CACHE_NAMESPACES.BUSES,
      CACHE_NAMESPACES.DASHBOARD,
    );

    return NextResponse.json({
      message: 'Maintenance record deleted successfully',
    });

  } catch (error) {
    console.error('Delete maintenance error:', error);
    return NextResponse.json(
      { error: 'Failed to delete maintenance record' },
      { status: 500 }
    );
  }
}
