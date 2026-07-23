import { NextRequest, NextResponse } from 'next/server'
import {
  getLiveMicrosoftTenantBundle,
  sanitizeGraphError,
} from '@/lib/microsoft-graph'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const mode = process.env.HAWKVIEW_DATA_MODE || 'mock'
  const forceRefresh = req.nextUrl.searchParams.get('refresh') === 'true'

  if (mode === 'microsoft') {
    try {
      const bundle = await getLiveMicrosoftTenantBundle(id, { forceRefresh })
      return NextResponse.json({
        mode: 'microsoft',
        bundle,
      })
    } catch (err: any) {
      const safeError = sanitizeGraphError(err)
      return NextResponse.json(
        {
          mode: 'microsoft',
          error: safeError,
          bundle: null,
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
  const { getMockTenant } = await import(
    '@/app/(protected)/tenants/[id]/mock/getMockTenant'
  )
  const bundle = getMockTenant(id)
  return NextResponse.json({
    mode: 'mock',
    bundle,
  })
}
