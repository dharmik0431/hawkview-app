import {
  BadGatewayException,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common'
import { createHash, randomBytes } from 'node:crypto'
import { decodeJwt, jwtVerify, SignJWT } from 'jose'

const DEFAULT_REQUIRED_PERMISSIONS = [
  'Organization.Read.All',
  'User.Read.All',
] as const

const PERMISSION_DESCRIPTIONS: Record<string, string> = {
  'Organization.Read.All':
    'Read the Microsoft 365 organization name, domains, and subscription details.',
  'User.Read.All': 'Read users and their basic directory profile information.',
}

interface ConsentState {
  customerTenantId: string
  organizationId: string
  nonce: string
}

interface MicrosoftOrganization {
  id: string
  displayName: string
  verifiedDomains?: Array<{
    name?: string
    isDefault?: boolean
    isInitial?: boolean
  }>
}

@Injectable()
export class MicrosoftConsentService {
  private getRequiredConfiguration() {
    const clientId = process.env.MICROSOFT_CLIENT_ID?.trim()
    const clientSecret = process.env.MICROSOFT_CLIENT_SECRET?.trim()
    const redirectUri = process.env.MICROSOFT_ADMIN_CONSENT_REDIRECT_URI?.trim()
    const stateSecret = process.env.MICROSOFT_CONSENT_STATE_SECRET?.trim()

    if (!clientId || !clientSecret || !redirectUri || !stateSecret) {
      throw new ServiceUnavailableException(
        'Microsoft tenant consent is not configured yet.'
      )
    }

    if (stateSecret.length < 32) {
      throw new ServiceUnavailableException(
        'Microsoft consent state protection is not configured securely.'
      )
    }

    return { clientId, clientSecret, redirectUri, stateSecret }
  }

  getRequiredPermissions() {
    const configured = process.env.MICROSOFT_REQUIRED_PERMISSIONS?.split(',')
      .map((permission) => permission.trim())
      .filter(Boolean)

    const permissions =
      configured && configured.length > 0
        ? [...new Set(configured)]
        : [...DEFAULT_REQUIRED_PERMISSIONS]

    return permissions.map((name) => ({
      name,
      description:
        PERMISSION_DESCRIPTIONS[name] ??
        'Required by a configured HawkView Microsoft synchronization module.',
    }))
  }

  async createAdminConsentUrl(
    microsoftTenantId: string,
    state: Omit<ConsentState, 'nonce'>
  ) {
    const configuration = this.getRequiredConfiguration()
    const nonce = randomBytes(32).toString('base64url')
    const stateToken = await new SignJWT({ ...state, nonce })
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setIssuedAt()
      .setExpirationTime('15m')
      .setIssuer('hawkview-api')
      .setAudience('microsoft-admin-consent')
      .sign(new TextEncoder().encode(configuration.stateSecret))

    const url = new URL(
      `https://login.microsoftonline.com/${microsoftTenantId}/v2.0/adminconsent`
    )
    url.searchParams.set('client_id', configuration.clientId)
    url.searchParams.set('scope', 'https://graph.microsoft.com/.default')
    url.searchParams.set('redirect_uri', configuration.redirectUri)
    url.searchParams.set('state', stateToken)

    return {
      consentUrl: url.toString(),
      stateHash: createHash('sha256').update(nonce).digest('hex'),
      expiresAt: new Date(Date.now() + 15 * 60 * 1000),
    }
  }

  async verifyConsentState(stateToken: string): Promise<ConsentState> {
    const { stateSecret } = this.getRequiredConfiguration()
    const { payload } = await jwtVerify(
      stateToken,
      new TextEncoder().encode(stateSecret),
      {
        algorithms: ['HS256'],
        issuer: 'hawkview-api',
        audience: 'microsoft-admin-consent',
      }
    )

    if (
      typeof payload.customerTenantId !== 'string' ||
      typeof payload.organizationId !== 'string' ||
      typeof payload.nonce !== 'string'
    ) {
      throw new Error('Microsoft consent state is invalid.')
    }

    return {
      customerTenantId: payload.customerTenantId,
      organizationId: payload.organizationId,
      nonce: payload.nonce,
    }
  }

  hashConsentNonce(nonce: string) {
    return createHash('sha256').update(nonce).digest('hex')
  }

  async verifyTenant(microsoftTenantId: string) {
    const { clientId, clientSecret } = this.getRequiredConfiguration()
    const tokenUrl = `https://login.microsoftonline.com/${microsoftTenantId}/oauth2/v2.0/token`
    const tokenResponse = await fetch(tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        scope: 'https://graph.microsoft.com/.default',
        grant_type: 'client_credentials',
      }),
      signal: AbortSignal.timeout(15_000),
    })

    if (!tokenResponse.ok) {
      throw new BadGatewayException(
        'Microsoft consent was granted, but HawkView could not obtain a tenant access token.'
      )
    }

    const tokenBody = (await tokenResponse.json()) as {
      access_token?: string
    }
    if (!tokenBody.access_token) {
      throw new BadGatewayException(
        'Microsoft did not return a tenant access token.'
      )
    }

    const tokenClaims = decodeJwt(tokenBody.access_token)
    const grantedPermissions = Array.isArray(tokenClaims.roles)
      ? tokenClaims.roles.filter(
          (permission): permission is string => typeof permission === 'string'
        )
      : []

    const organizationResponse = await fetch(
      'https://graph.microsoft.com/v1.0/organization?$select=id,displayName,verifiedDomains',
      {
        headers: {
          Authorization: `Bearer ${tokenBody.access_token}`,
          Accept: 'application/json',
        },
        signal: AbortSignal.timeout(15_000),
      }
    )

    if (!organizationResponse.ok) {
      throw new BadGatewayException(
        'Microsoft consent is missing the permission required to read organization details.'
      )
    }

    const organizationBody = (await organizationResponse.json()) as {
      value?: MicrosoftOrganization[]
    }
    const organization = organizationBody.value?.[0]

    if (
      !organization ||
      organization.id.toLowerCase() !== microsoftTenantId.toLowerCase()
    ) {
      throw new BadGatewayException(
        'Microsoft returned an organization that does not match the requested tenant.'
      )
    }

    const primaryDomain =
      organization.verifiedDomains?.find((domain) => domain.isDefault)?.name ??
      organization.verifiedDomains?.find((domain) => domain.isInitial)?.name ??
      null

    const requiredPermissionNames = this.getRequiredPermissions().map(
      (permission) => permission.name
    )
    const missingPermissions = requiredPermissionNames.filter(
      (permission) => !grantedPermissions.includes(permission)
    )

    return {
      displayName: organization.displayName,
      primaryDomain,
      grantedPermissions: [...new Set(grantedPermissions)].sort(),
      missingPermissions,
    }
  }
}
