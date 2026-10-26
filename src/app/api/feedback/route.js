import { NextResponse } from 'next/server';
import prisma from '@/lib/prisma';
import { authMiddleware } from '@/middleware/auth';
import { logActivity } from '@/lib/activityLogger';
import { enforceRateLimit } from '@/lib/rateLimiter';
import { enqueueNotification } from '@/lib/enqueue';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// GET all feedback (Admin sees all, others see their own)
export async function GET(req) {
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
    const { searchParams } = new URL(req.url);
    const tripId = searchParams.get('tripId');

    const where = {};

    if (user.role !== 'ADMIN') {
      where.userId = user.id;
    }

    if (tripId) where.tripId = tripId;

    const feedback = await prisma.feedback.findMany({
      where,
      include: {
        user: {
          select: {
            id: true,
            name: true,
            email: true,
          },
        },
        trip: {
          select: {
            id: true,
            status: true,
            route: {
              select: {
                name: true,
              },
            },
          },
        },
      },
      orderBy: {
        createdAt: 'desc',
      },
    });

    // Calculate average rating
    const avgRating = feedback.length > 0
      ? feedback.reduce((sum, f) => sum + f.rating, 0) / feedback.length
      : 0;

    return NextResponse.json({ feedback, averageRating: avgRating });
  } catch (error) {
    console.error('Get feedback error:', error);
    return NextResponse.json(
      { error: 'Failed to fetch feedback' },
      { status: 500 }
    );
  }
}

// CREATE feedback
export async function POST(req) {
  const authResult = await authMiddleware(req, ['ADMIN', 'PASSENGER']);
  
  if (authResult instanceof NextResponse) {
    return authResult;
  }

  const limited = await enforceRateLimit(req, 'COLLECTION_WRITE', {
    user: authResult.user,
  });
  if (limited) return limited;

  try {
    const { user } = authResult;
    const { tripId, rating, comment } = await req.json();

    if (!rating || rating < 1 || rating > 5) {
      return NextResponse.json(
        { error: 'Rating is required and must be between 1 and 5' },
        { status: 400 }
      );
    }

    // Verify the trip exists before attaching feedback to it.
    if (tripId) {
      const trip = await prisma.trip.findUnique({
        where: { id: tripId },
        select: { id: true },
      });

      if (!trip) {
        return NextResponse.json(
          { error: 'Trip not found' },
          { status: 404 }
        );
      }
    }

    // Check if user already gave feedback for this trip
    const existingFeedback = await prisma.feedback.findFirst({
      where: {
        userId: user.id,
        tripId: tripId || null,
      },
    });

    if (existingFeedback) {
      return NextResponse.json(
        { error: 'You have already provided feedback for this trip' },
        { status: 400 }
      );
    }

    const feedback = await prisma.feedback.create({
      data: {
        userId: user.id,
        tripId,
        rating,
        comment,
      },
      include: {
        user: {
          select: {
            id: true,
            name: true,
          },
        },
      },
    });

    // Notify admin about new feedback
    await enqueueNotification({
      userRole: 'ADMIN',
      type: 'FEEDBACK_RECEIVED',
      title: 'New Feedback Received',
      message: `New ${rating}-star feedback from ${user.name}: ${comment || 'No comment'}`,
      link: '/feedback',
    });

    await logActivity({
      userId: user.id,
      action: 'SUBMIT_FEEDBACK',
      details: `Feedback (${rating} stars) submitted`,
      req,
    });


    return NextResponse.json({
      message: 'Feedback submitted successfully',
      feedback,
    }, { status: 201 });
  } catch (error) {
    console.error('Create feedback error:', error);
    return NextResponse.json(
      { error: 'Failed to submit feedback' },
      { status: 500 }
    );
  }
}
