import {
  BadGatewayException,
  BadRequestException,
  Inject,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common'
import { createHash, randomBytes } from 'node:crypto'
import { decodeJwt, jwtVerify, SignJWT } from 'jose'
import { PrismaService } from '../prisma/prisma.service.js'
import { SecretStoreService } from '../secrets/secret-store.service.js'

const DEFAULT_REQUIRED_PERMISSIONS = [
  'Organization.Read.All',
  'User.Read.All',
  'GroupMember.Read.All',
  'AuditLog.Read.All',
  'Policy.Read.All',
  'Policy.Read.AuthenticationMethod',
  'Device.Read.All',
  'RoleManagement.Read.Directory',
  'Application.Read.All',
  'Sites.Read.All',
  'SharePointTenantSettings.Read.All',
] as const

const PERMISSION_DESCRIPTIONS: Record<string, string> = {
  'Organization.Read.All':
    'Read the Microsoft 365 organization name, domains, and subscription details.',
  'User.Read.All': 'Read users and their basic directory profile information.',
  'GroupMember.Read.All':
    'Read Microsoft 365 and security groups and their user memberships.',
  'AuditLog.Read.All':
    'Read sign-in activity and user MFA registration status.',
  'Policy.Read.All': 'Read Conditional Access policies and named locations.',
  'Policy.Read.AuthenticationMethod':
    'Read the tenant authentication-method policy.',
  'Device.Read.All': 'Read Microsoft Entra registered and managed devices.',
  'RoleManagement.Read.Directory':
    'Read Microsoft Entra directory role assignments.',
  'Application.Read.All':
    'Resolve application IDs in Conditional Access policies to readable names.',
  'Sites.Read.All':
    'Read SharePoint site inventory and document-library storage usage.',
  'SharePointTenantSettings.Read.All':
    'Read tenant-level SharePoint and OneDrive storage and sharing settings.',
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
  constructor(
    @Inject(PrismaService)
    private readonly prisma: PrismaService,
    @Inject(SecretStoreService)
    private readonly secretStore: SecretStoreService
  ) {}

  private async getStateConfiguration() {
    const redirectUri = process.env.MICROSOFT_ADMIN_CONSENT_REDIRECT_URI?.trim()

    if (!redirectUri) {
      throw new ServiceUnavailableException(
        'Microsoft tenant consent is not configured yet.'
      )
    }
    const stateSecret = await this.secretStore.accessOrCreate(
      'hawkview-microsoft-consent-state-secret',
      () => randomBytes(48).toString('base64url')
    )

    return { redirectUri, stateSecret }
  }

  private async getManagedConnector() {
    const connector = await this.prisma.platformMicrosoftConnector.findUnique({
      where: { id: 'default' },
    })
    if (!connector) {
      throw new ServiceUnavailableException(
        'The HawkView-managed Microsoft connector has not been configured.'
      )
    }
    return {
      clientId: connector.clientId,
      clientSecret: await this.secretStore.access(
        connector.credentialReference
      ),
    }
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
    const configuration = await this.getStateConfiguration()
    const connector = await this.getManagedConnector()
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
    url.searchParams.set('client_id', connector.clientId)
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
    const { stateSecret } = await this.getStateConfiguration()
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
    const credentials = await this.getManagedConnector()
    return this.verifyTenantWithCredentials(microsoftTenantId, credentials)
  }

  async verifyTenantWithCredentials(
    microsoftTenantId: string,
    credentials: { clientId: string; clientSecret: string }
  ) {
    const { accessToken, grantedPermissions } = await this.requestAccessToken(
      microsoftTenantId,
      credentials
    )

    const organizationResponse = await fetch(
      'https://graph.microsoft.com/v1.0/organization?$select=id,displayName,verifiedDomains',
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
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

  private async requestAccessToken(
    microsoftTenantId: string,
    credentials: { clientId: string; clientSecret: string }
  ) {
    const { clientId, clientSecret } = credentials
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

    return {
      accessToken: tokenBody.access_token,
      grantedPermissions,
    }
  }

  async getTenantAccessToken(input: {
    microsoftTenantId: string
    connectionMode: 'HAWKVIEW_MANAGED' | 'CUSTOMER_MANAGED'
    clientId: string | null
    credentialReference: string | null
  }) {
    const credentials =
      input.connectionMode === 'CUSTOMER_MANAGED'
        ? {
            clientId: input.clientId ?? '',
            clientSecret: input.credentialReference
              ? await this.secretStore.access(input.credentialReference)
              : '',
          }
        : await this.getManagedConnector()

    if (!credentials.clientId || !credentials.clientSecret) {
      throw new ServiceUnavailableException(
        'The Microsoft tenant connection is incomplete.'
      )
    }

    const result = await this.requestAccessToken(
      input.microsoftTenantId,
      credentials
    )
    return result.accessToken
  }

  async configureManagedConnector(input: {
    clientId: string
    homeTenantId: string
    clientSecret: string
    credentialExpiresAt?: Date | null
  }) {
    const verification = await this.verifyTenantWithCredentials(
      input.homeTenantId,
      {
        clientId: input.clientId,
        clientSecret: input.clientSecret,
      }
    )
    if (verification.missingPermissions.length > 0) {
      throw new BadRequestException(
        `The connector is missing: ${verification.missingPermissions.join(', ')}.`
      )
    }

    const credentialReference = await this.secretStore.store(
      'hawkview-microsoft-connector-client-secret',
      input.clientSecret
    )
    const connector = await this.prisma.platformMicrosoftConnector.upsert({
      where: { id: 'default' },
      create: {
        id: 'default',
        clientId: input.clientId,
        homeTenantId: input.homeTenantId,
        credentialReference,
        credentialExpiresAt: input.credentialExpiresAt,
      },
      update: {
        clientId: input.clientId,
        homeTenantId: input.homeTenantId,
        credentialReference,
        credentialExpiresAt: input.credentialExpiresAt,
        configuredAt: new Date(),
      },
    })

    return {
      configured: true,
      clientId: connector.clientId,
      homeTenantId: connector.homeTenantId,
      credentialExpiresAt: connector.credentialExpiresAt?.toISOString() ?? null,
      verifiedOrganization: verification.displayName,
    }
  }

  async prepareCustomerManagedConnection(input: {
    microsoftTenantId: string
    clientId: string
    clientSecret: string
    secretId: string
  }) {
    const verification = await this.verifyTenantWithCredentials(
      input.microsoftTenantId,
      {
        clientId: input.clientId,
        clientSecret: input.clientSecret,
      }
    )
    if (verification.missingPermissions.length > 0) {
      throw new BadRequestException(
        `The customer-managed application is missing: ${verification.missingPermissions.join(', ')}.`
      )
    }
    const credentialReference = await this.secretStore.store(
      input.secretId,
      input.clientSecret
    )
    return { ...verification, credentialReference }
  }

  async deleteStoredCredential(reference: string) {
    await this.secretStore.delete(reference)
  }
}
