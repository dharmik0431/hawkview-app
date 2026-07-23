import { NextResponse } from 'next/server'
import {
  getLiveMicrosoftTenantSummary,
  sanitizeGraphError,
} from '@/lib/microsoft-graph'
import { TENANTS } from '@/app/(protected)/tenants/[id]/mock/tenants'

export async function GET() {
  const start = performance.now()
  const mode = process.env.HAWKVIEW_DATA_MODE || 'mock'

  if (mode === 'microsoft') {
    try {
      const liveTenant = await getLiveMicrosoftTenantSummary()
      const duration = Math.round(performance.now() - start)
      if (process.env.NODE_ENV !== 'production') {
        console.log(`[API /api/tenants] Total duration: ${duration}ms`)
      }
      return NextResponse.json({
        mode: 'microsoft',
        tenants: [liveTenant],
      })
    } catch (err: any) {
      const duration = Math.round(performance.now() - start)
      if (process.env.NODE_ENV !== 'production') {
        console.log(`[API /api/tenants] Total duration (error): ${duration}ms`)
      }
      const safeError = sanitizeGraphError(err)
      return NextResponse.json(
        {
          mode: 'microsoft',
          error: safeError,
          tenants: [],
        },
        {
          status: safeError.includes('Missing required Microsoft credentials')
            ? 400
            : 502,
        }
      )
    }
  }

  // Default: mock mode
  const duration = Math.round(performance.now() - start)
  if (process.env.NODE_ENV !== 'production') {
    console.log(`[API /api/tenants] Total duration (mock): ${duration}ms`)
  }
  return NextResponse.json({
    mode: 'mock',
    tenants: TENANTS,
  })
}
