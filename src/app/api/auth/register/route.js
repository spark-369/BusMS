import { NextResponse } from 'next/server';
import bcrypt from 'bcryptjs';
import prisma from '@/lib/prisma';
import { generateToken } from '@/utils/jwt';
import { logActivity } from '@/lib/activityLogger';
import {
  checkRateLimit,
  getRateLimitIdentity,
  rateLimitHeaders,
  rateLimitResponse,
} from '@/lib/rateLimiter';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Public self-registration must never be able to create ADMIN accounts.
// Admin accounts are created by an existing admin through POST /api/users.
// Keeping this allow-list server-side closes the privilege escalation hole
// regardless of what the client sends.
const PUBLIC_REGISTER_ROLES = ['PASSENGER', 'DRIVER'];

export async function POST(req) {
  try {
    const { email, password, name, phone, role, passengerId, licenseNumber } = await req.json();

    // ---------------------------------------------------------------------
    // Rate limiting. Registration is expensive (bcrypt cost 12) and creates
    // rows, so it is capped per IP *and* per email to prevent both mass
    // account creation and mail-bomb style enumeration.
    // ---------------------------------------------------------------------
    const ipLimit = await checkRateLimit('REGISTER', getRateLimitIdentity(req));
    if (!ipLimit.allowed) {
      return rateLimitResponse(ipLimit);
    }

    if (typeof email === 'string' && email) {
      const emailLimit = await checkRateLimit(
        'REGISTER',
        `email:${email.toLowerCase()}`,
      );
      if (!emailLimit.allowed) {
        return rateLimitResponse(emailLimit);
      }
    }

    if (!email || !password || !name) {
      return NextResponse.json(
        { error: 'Email, password, and name are required' },
        { status: 400 }
      );
    }

    // Basic shape validation
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return NextResponse.json(
        { error: 'Please provide a valid email address' },
        { status: 400 }
      );
    }

    if (typeof password !== 'string' || password.length < 6) {
      return NextResponse.json(
        { error: 'Password must be at least 6 characters' },
        { status: 400 }
      );
    }

    // Reject any role that is not explicitly allowed for public sign-up.
    const requestedRole = role || 'PASSENGER';
    if (!PUBLIC_REGISTER_ROLES.includes(requestedRole)) {
      return NextResponse.json(
        { error: 'Invalid role. Public registration is limited to passengers and drivers.' },
        { status: 403 }
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

    // Role-specific required fields
    if (requestedRole === 'PASSENGER' && !passengerId) {
      return NextResponse.json(
        { error: 'Passenger ID is required for passenger registration' },
        { status: 400 }
      );
    }

    if (requestedRole === 'DRIVER' && !licenseNumber) {
      return NextResponse.json(
        { error: 'License number is required for driver registration' },
        { status: 400 }
      );
    }

    // Hash password
    const hashedPassword = await bcrypt.hash(password, 12);

    // Create user based on role
    const user = await prisma.user.create({
      data: {
        email,
        password: hashedPassword,
        name,
        phone: phone || null,
        role: requestedRole,
        passengerId: requestedRole === 'PASSENGER' ? passengerId : null,
        licenseNumber: requestedRole === 'DRIVER' ? licenseNumber : null,
      },
    });

    // Generate token
    const token = generateToken({
      userId: user.id,
      email: user.email,
      role: user.role,
    });

    // Log activity
    await logActivity({
      userId: user.id,
      action: 'REGISTER',
      details: `User registered as ${requestedRole}`,
      req,
    });

    const { password: _, ...userWithoutPassword } = user;

    return NextResponse.json(
      {
        message: 'Registration successful',
        token,
        user: userWithoutPassword,
      },
      { status: 201, headers: rateLimitHeaders(ipLimit) },
    );

  } catch (error) {
    console.error('Registration error:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}
