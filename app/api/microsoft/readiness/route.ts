import { NextResponse } from 'next/server'
import { checkMicrosoftReadiness } from '@/lib/microsoft-graph'

export async function GET() {
  if (process.env.NODE_ENV === 'production') {
    return NextResponse.json(
      { error: 'Endpoint unavailable in production environment.' },
      { status: 403 }
    )
  }

  try {
    const readiness = await checkMicrosoftReadiness()

    return NextResponse.json({
      environment: process.env.NODE_ENV || 'development',
      overallStatus: readiness.overallStatus,
      checks: readiness.checks,
    })
  } catch {
    return NextResponse.json(
      {
        error: 'An unexpected error occurred while executing readiness checks.',
      },
      { status: 500 }
    )
  }
}
