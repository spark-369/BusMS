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

export async function POST(req) {
  try {
    const { email, password } = await req.json();

    // ---------------------------------------------------------------------
    // Rate limiting (before any hashing/lookup work).
    //
    // Login is brute-force sensitive, so two independent sliding windows are
    // enforced and BOTH must pass:
    //   - per IP    : stops one host spraying many accounts
    //   - per email : stops a distributed attack against one account
    // The email bucket is only applied when an email was supplied, so a
    // malformed request cannot be used to probe the limiter.
    // ---------------------------------------------------------------------
    const ipIdentity = getRateLimitIdentity(req);

    const ipLimit = await checkRateLimit('LOGIN', ipIdentity);
    if (!ipLimit.allowed) {
      return rateLimitResponse(ipLimit);
    }

    if (typeof email === 'string' && email) {
      const emailLimit = await checkRateLimit(
        'LOGIN',
        `email:${email.toLowerCase()}`,
      );
      if (!emailLimit.allowed) {
        return rateLimitResponse(emailLimit);
      }
    }

    if (!email || !password) {
      return NextResponse.json(
        { error: 'Email and password are required' },
        { status: 400 },
      );
    }


    const user = await prisma.user.findUnique({
      where: { email },
    });

    if (!user) {
      return NextResponse.json(
        { error: 'Invalid credentials' },
        { status: 401 }
      );
    }

    if (!user.isActive) {
      return NextResponse.json(
        { error: 'Account is deactivated' },
        { status: 403 }
      );
    }

    const isPasswordValid = await bcrypt.compare(password, user.password);

    if (!isPasswordValid) {
      return NextResponse.json(
        { error: 'Invalid credentials' },
        { status: 401 }
      );
    }

    const token = generateToken({
      userId: user.id,
      email: user.email,
      role: user.role,
    });

    // Log activity
    await logActivity({
      userId: user.id,
      action: 'LOGIN',
      details: 'User logged in successfully',
      req,
    });

    const { password: _, ...userWithoutPassword } = user;

    return NextResponse.json(
      {
        message: 'Login successful',
        token,
        user: userWithoutPassword,
      },
      { headers: rateLimitHeaders(ipLimit) },
    );
  } catch (error) {
    console.error('Login error:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}

