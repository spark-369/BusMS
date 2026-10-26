import { NextResponse } from 'next/server';
import bcrypt from 'bcryptjs';
import prisma from '@/lib/prisma';
import { authMiddleware } from '@/middleware/auth';
import { enforceRateLimit } from '@/lib/rateLimiter';
import { logActivity } from '@/lib/activityLogger';
import { CACHE_NAMESPACES, invalidate } from '@/lib/cache';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// GET user by ID
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

    const { user } = authResult;
    const { id } = params;

    // Users can only view their own profile unless they are admin
    if (user.role !== 'ADMIN' && user.id !== id) {
      return NextResponse.json(
        { error: 'Access denied' },
        { status: 403 }
      );
    }

    const userData = await prisma.user.findUnique({
      where: { id },
      select: {
        id: true,
        email: true,
        name: true,
        phone: true,
        role: true,
        passengerId: true,
        licenseNumber: true,
        isActive: true,
        createdAt: true,
        updatedAt: true,
        busPass: true,
      },
    });

    if (!userData) {
      return NextResponse.json(
        { error: 'User not found' },
        { status: 404 }
      );
    }

    return NextResponse.json({ user: userData });
  } catch (error) {
    console.error('Get user error:', error);
    return NextResponse.json(
      { error: 'Failed to fetch user' },
      { status: 500 }
    );
  }
}

// UPDATE user
export async function PUT(req, { params }) {
  const authResult = await authMiddleware(req, ['ADMIN', 'DRIVER', 'PASSENGER']);
  
  if (authResult instanceof NextResponse) {
    return authResult;
  }

  const limited = await enforceRateLimit(req, 'COLLECTION_WRITE', {
    user: authResult.user,
  });
  if (limited) return limited;

  try {

    const { user } = authResult;
    const { id } = params;
    const { name, phone, password, passengerId, licenseNumber, department, year } = await req.json();

    // Users can only update their own profile unless they are admin
    if (user.role !== 'ADMIN' && user.id !== id) {
      return NextResponse.json(
        { error: 'Access denied' },
        { status: 403 }
      );
    }

    const updateData = {};
    
    if (name) updateData.name = name;
    if (phone) updateData.phone = phone;
    if (password) updateData.password = await bcrypt.hash(password, 12);
    if (passengerId) updateData.passengerId = passengerId;
    if (licenseNumber) updateData.licenseNumber = licenseNumber;

    const updatedUser = await prisma.user.update({
      where: { id },
      data: updateData,
    });

    // Passenger and Driver details are now stored directly in User model
    // No separate records to update

    // Log activity
    await logActivity({
      userId: user.id,
      action: 'UPDATE_USER',
      details: `User profile updated: ${updatedUser.email}`,
      req,
    });

    const { password: _, ...userWithoutPassword } = updatedUser;


    return NextResponse.json({
      message: 'User updated successfully',
      user: userWithoutPassword,
    });
  } catch (error) {
    console.error('Update user error:', error);
    return NextResponse.json(
      { error: 'Failed to update user' },
      { status: 500 }
    );
  }
}

// DELETE user (Admin only)
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

    const user = await prisma.user.findUnique({
      where: { id },
    });

    if (!user) {
      return NextResponse.json(
        { error: 'User not found' },
        { status: 404 }
      );
    }

    // Soft delete - deactivate user instead of deleting
    await prisma.user.update({
      where: { id },
      data: { isActive: false },
    });

    // Log activity
    await logActivity({
      userId: authResult.user.id,
      action: 'DEACTIVATE_USER',
      details: `User deactivated by admin: ${user.email}`,
      req,
    });

    // Deactivating a driver frees them from the assignment pool and changes
    // the dashboard's active-driver count.
    await invalidate(CACHE_NAMESPACES.DASHBOARD, CACHE_NAMESPACES.ASSIGNMENTS);

    return NextResponse.json({
      message: 'User deactivated successfully',
    });

  } catch (error) {
    console.error('Delete user error:', error);
    return NextResponse.json(
      { error: 'Failed to deactivate user' },
      { status: 500 }
    );
  }
}
