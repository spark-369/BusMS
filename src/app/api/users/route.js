import { NextResponse } from 'next/server';
import bcrypt from 'bcryptjs';
import prisma from '@/lib/prisma';
import { authMiddleware } from '@/middleware/auth';
import { enforceRateLimit } from '@/lib/rateLimiter';
import { logActivity } from '@/lib/activityLogger';
import { CACHE_NAMESPACES, invalidate } from '@/lib/cache';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// GET all users (Admin only)
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

    const { user } = authResult;
    const { searchParams } = new URL(req.url);
    const role = searchParams.get('role');
    const isActive = searchParams.get('isActive');

    const where = {};
    
    if (role) {
      where.role = role;
    }
    
    if (isActive !== null) {
      where.isActive = isActive === 'true';
    }

    const users = await prisma.user.findMany({
      where,
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
      },
      orderBy: {
        createdAt: 'desc',
      },
    });

    return NextResponse.json({ users });
  } catch (error) {
    console.error('Get users error:', error);
    return NextResponse.json(
      { error: 'Failed to fetch users' },
      { status: 500 }
    );
  }
}

// Create new user (Admin only)
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

    const { email, password, name, phone, role, passengerId, licenseNumber } = await req.json();

    if (!email || !password || !name) {
      return NextResponse.json(
        { error: 'Email, password, and name are required' },
        { status: 400 }
      );
    }

    // Check if user already exists
    const existingUser = await prisma.user.findUnique({
      where: { email },
    });

    if (existingUser) {
      return NextResponse.json(
        { error: 'Email already registered' },
        { status: 400 }
      );
    }

    // Hash password
    const hashedPassword = await bcrypt.hash(password, 12);

    // Create user
    const user = await prisma.user.create({
      data: {
        email,
        password: hashedPassword,
        name,
        phone,
        role: role || 'PASSENGER',
        passengerId: role === 'PASSENGER' ? passengerId : null,
        licenseNumber: role === 'DRIVER' ? licenseNumber : null,
      },
    });

    // Create user - Driver and Passenger are now handled by role in User model
    // No separate records needed

    // Log activity (brokered through the audit queue when Redis is available).
    await logActivity({
      userId: user.id,
      action: 'CREATE_USER',
      details: `User created by admin: ${user.email}`,
      req,
    });

    // A new driver/passenger changes the user totals on the dashboard.
    await invalidate(CACHE_NAMESPACES.DASHBOARD);

    const { password: _, ...userWithoutPassword } = user;


    return NextResponse.json({
      message: 'User created successfully',
      user: userWithoutPassword,
    }, { status: 201 });
  } catch (error) {
    console.error('Create user error:', error);
    return NextResponse.json(
      { error: 'Failed to create user' },
      { status: 500 }
    );
  }
}
