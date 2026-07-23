import { NextResponse } from 'next/server'
import { checkMicrosoftConnection } from '@/lib/microsoft-graph'

export async function GET() {
  try {
    const result = await checkMicrosoftConnection()

    if (!result.connected) {
      return NextResponse.json(
        {
          connected: false,
          tenantId: result.tenantId,
          displayName: result.displayName,
          verifiedDomains: result.verifiedDomains,
          error: result.error || 'Microsoft Graph connection failed.',
        },
        {
          status: result.error?.includes('Missing required Microsoft credentials')
            ? 400
            : 502,
        }
      )
    }

    return NextResponse.json({
      connected: true,
      tenantId: result.tenantId,
      displayName: result.displayName,
      verifiedDomains: result.verifiedDomains,
    })
  } catch {
    return NextResponse.json(
      {
        connected: false,
        tenantId: null,
        displayName: null,
        verifiedDomains: null,
        error: 'Internal server error checking Microsoft connection.',
      },
      { status: 500 }
    )
  }
}
