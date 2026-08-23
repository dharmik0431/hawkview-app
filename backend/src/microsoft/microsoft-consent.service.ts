import {
  BadGatewayException,
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common'
import { createHash, randomBytes } from 'node:crypto'
import { decodeJwt, jwtVerify, SignJWT } from 'jose'
import { PrismaService } from '../prisma/prisma.service.js'
import { SecretStoreService } from '../secrets/secret-store.service.js'
import {
  fetchMicrosoftWithRetry,
  microsoftErrorMetadata,
  MicrosoftRequestError,
} from './microsoft-request.js'
import {
  CONNECTION_REQUIRED_PERMISSIONS,
  DEFAULT_REQUIRED_PERMISSIONS,
  MICROSOFT_ACCESS_CAPABILITIES,
  MICROSOFT_ACCESS_CONTRACT_VERSION,
  MICROSOFT_APPLICATION_PERMISSIONS,
  PERMISSION_DESCRIPTIONS,
} from './microsoft-access-contract.js'

const GRAPH_RESOURCE_HOST = 'graph.microsoft.com'
const MANAGEMENT_RESOURCE_HOST = 'manage.office.com'
const SHAREPOINT_RESOURCE_APP_ID = '00000003-0000-0ff1-ce00-000000000000'
const DEPRECATED_SHAREPOINT_FULL_CONTROL = 'sites.fullcontrol.all'

type ConfiguredPermissionOverride = {
  name: string
  rejected?: string
}

/**
 * Environment overrides historically used bare Microsoft Graph permission
 * names. It now accepts only code-owned canonical names, so an unknown bare
 * value is never silently reinterpreted as Graph. Resource-qualified
 * SharePoint values are rejected so standard mode can never request or report
 * the deprecated SharePoint full-control grant.
 */
function decodeBoundedPermissionOverride(raw: string): string | null {
  if (raw.length === 0 || raw.length > 256 || /[\u0000-\u001f\u007f\\]/.test(raw)) return null
  let value = raw
  for (let layer = 0; layer < 2 && value.includes('%'); layer += 1) {
    try {
      const decoded = decodeURIComponent(value)
      if (decoded === value) break
      value = decoded
    } catch {
      return null
    }
  }
  // An undecoded percent marker is ambiguous configuration, not a scope.
  return value.includes('%') || /[\u0000-\u001f\u007f\\]/.test(value) ? null : value
}

function canonicalPermissionName(value: string): string | null {
  const normalized = value.replace(/\s+/g, '').toLowerCase()
  return DEFAULT_REQUIRED_PERMISSIONS.find(
    (permission) => permission.toLowerCase() === normalized
  ) ?? null
}

/** Strictly accept only code-owned Graph names and the Office 365 Management
 * ActivityFeed.Read resource representation. Values are environment input,
 * so a resource-like or encoded unknown value is never treated as Graph. */
export function normalizeConfiguredRequiredPermissions(value: string | undefined): {
  permissions: string[]
  rejected: string[]
} {
  const parsed: ConfiguredPermissionOverride[] = (value ?? '')
    .split(',')
    .map((raw) => raw.trim())
    .filter(Boolean)
    .map((raw) => {
      const decoded = decodeBoundedPermissionOverride(raw)
      if (!decoded) return { name: raw, rejected: 'malformed or ambiguous permission override' }
      const compact = decoded.replace(/\s+/g, '')
      const canonicalBare = canonicalPermissionName(compact)
      if (canonicalBare) return { name: canonicalBare }

      const qualified = /^(https?):\/\/([^/?#:]+)(?::\d+)?\/([^/?#]+)$/i.exec(compact)
      const labelled = /^([a-z0-9.-]+)[:/]([^:/?#]+)$/i.exec(compact)
      const resource = (qualified?.[2] ?? labelled?.[1] ?? '').toLowerCase().replace(/\.$/, '')
      const permission = qualified?.[3] ?? labelled?.[2] ?? ''
      const canonical = canonicalPermissionName(permission)
      const normalizedPermission = permission.toLowerCase()
      const sharePointResource = resource === SHAREPOINT_RESOURCE_APP_ID || resource === 'sharepoint' || resource === 'office365sharepointonline' || resource === 'sharepoint.com' || resource.endsWith('.sharepoint.com')
      if (sharePointResource) {
        return { name: raw, rejected: normalizedPermission === DEPRECATED_SHAREPOINT_FULL_CONTROL ? 'deprecated SharePoint Sites.FullControl.All' : 'SharePoint-resource permissions are not used in standard mode' }
      }
      if (!canonical) return { name: raw, rejected: 'unknown permission override' }
      if ((resource === GRAPH_RESOURCE_HOST || resource === 'graph' || resource === 'microsoftgraph') && canonical !== 'ActivityFeed.Read') {
        return { name: canonical }
      }
      if ((resource === MANAGEMENT_RESOURCE_HOST || resource === 'office365management' || resource === 'management') && canonical === 'ActivityFeed.Read') {
        return { name: canonical }
      }
      return { name: raw, rejected: 'unrecognized or mismatched permission resource' }
    })

  return {
    permissions: [...new Set(parsed.filter((entry) => !entry.rejected).map((entry) => entry.name))],
    rejected: parsed.filter((entry) => entry.rejected).map((entry) => `${entry.name}: ${entry.rejected}`),
  }
}

interface ConsentState {
  customerTenantId?: string
  organizationId: string
  nonce: string
  flow: 'existing-tenant' | 'discover-tenant' | 'exchange-readonly'
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
  private readonly logger = new Logger(MicrosoftConsentService.name)
  private rejectedPermissionOverrideWarning?: string
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
      homeTenantId: connector.homeTenantId,
      clientSecret: await this.secretStore.access(
        connector.credentialReference
      ),
    }
  }

  async getManagedConnectorApplicationId() {
    return (await this.getManagedConnector()).clientId
  }

  getRequiredPermissions() {
    const configured = normalizeConfiguredRequiredPermissions(
      process.env.MICROSOFT_REQUIRED_PERMISSIONS
    )

    if (configured.rejected.length) {
      const warning = `Ignored unsafe Microsoft permission override(s): ${configured.rejected.join('; ')}`
      if (warning !== this.rejectedPermissionOverrideWarning) {
        this.rejectedPermissionOverrideWarning = warning
        this.logger.warn(warning)
      }
    }

    // Environment configuration may add deployment-specific permissions, but
    // it must not silently remove permissions required by compiled modules.
    const permissions = [
      ...new Set([...DEFAULT_REQUIRED_PERMISSIONS, ...configured.permissions]),
    ]

    return permissions.map((name) => {
      const definition = MICROSOFT_APPLICATION_PERMISSIONS.find((permission) => permission.name === name)
      const capabilities = MICROSOFT_ACCESS_CAPABILITIES.filter((capability) =>
        capability.applicationPermissions.some((permission) => permission.name === name),
      )
      return {
        name,
        description: PERMISSION_DESCRIPTIONS[name] ?? 'Required by a configured HawkView Microsoft synchronization module.',
        resource: definition?.resource ?? 'MICROSOFT_GRAPH',
        type: 'APPLICATION' as const,
        consentMode: definition?.consentMode ?? 'DEFAULT',
        connectionRequired: definition?.connectionRequired ?? false,
        tier: capabilities.some((capability) => capability.tier === 'CORE') ? 'CORE' as const : 'CAPABILITY_OPTIONAL' as const,
        purpose: capabilities.map((capability) => capability.label),
      }
    })
  }

  getAccessContract() {
    return {
      version: MICROSOFT_ACCESS_CONTRACT_VERSION,
      requestedPermissions: this.getRequiredPermissions(),
      connectionRequiredPermissions: [...CONNECTION_REQUIRED_PERMISSIONS],
      capabilities: MICROSOFT_ACCESS_CAPABILITIES,
    }
  }

  async createAdminConsentUrl(
    microsoftTenantId: string,
    state: Omit<ConsentState, 'nonce' | 'flow'>
  ) {
    return this.createConsentUrl(microsoftTenantId, {
      ...state,
      flow: 'existing-tenant',
    })
  }

  async createTenantDiscoveryConsentUrl(organizationId: string) {
    return this.createConsentUrl('organizations', {
      organizationId,
      flow: 'discover-tenant',
    })
  }

  async createExchangeReadOnlyConsentUrl(
    microsoftTenantId: string,
    state: Omit<ConsentState, 'nonce' | 'flow'>,
  ) {
    return this.createConsentUrl(microsoftTenantId, {
      ...state,
      flow: 'exchange-readonly',
    })
  }

  private async createConsentUrl(
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
    url.searchParams.set(
      'scope',
      state.flow === 'exchange-readonly'
        ? 'https://outlook.office365.com/.default'
        : 'https://graph.microsoft.com/.default',
    )
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

    const flow = payload.flow === 'discover-tenant'
      ? 'discover-tenant'
      : payload.flow === 'exchange-readonly' && typeof payload.customerTenantId === 'string'
        ? 'exchange-readonly'
        : typeof payload.customerTenantId === 'string'
          ? 'existing-tenant'
          : null

    if (
      typeof payload.organizationId !== 'string' ||
      typeof payload.nonce !== 'string' ||
      !flow ||
      ((flow === 'existing-tenant' || flow === 'exchange-readonly') &&
        typeof payload.customerTenantId !== 'string')
    ) {
      throw new Error('Microsoft consent state is invalid.')
    }

    return {
      customerTenantId:
        typeof payload.customerTenantId === 'string'
          ? payload.customerTenantId
          : undefined,
      organizationId: payload.organizationId,
      nonce: payload.nonce,
      flow,
    }
  }

  hashConsentNonce(nonce: string) {
    return createHash('sha256').update(nonce).digest('hex')
  }

  async verifyTenant(microsoftTenantId: string) {
    const credentials = await this.getManagedConnector()
    return this.verifyTenantWithCredentials(microsoftTenantId, credentials)
  }

  async verifyTenantAfterConsent(microsoftTenantId: string) {
    const retryDelaysMs = [1_000, 2_000, 3_000, 5_000, 8_000]
    let lastVerification: Awaited<ReturnType<typeof this.verifyTenant>> | null =
      null
    let lastError: unknown = null

    for (let attempt = 0; attempt <= retryDelaysMs.length; attempt += 1) {
      try {
        const verification = await this.verifyTenant(microsoftTenantId)
        lastVerification = verification
        lastError = null
        // Prefer a complete projection while Microsoft propagates the full
        // one-click grant. Capability permissions do not gate the connection,
        // but returning on the first baseline role would persist a misleading
        // partial grant set when the remaining roles are still propagating.
        if (verification.missingPermissions.length === 0) {
          return verification
        }
      } catch (error) {
        lastError = error
      }

      const retryDelay = retryDelaysMs[attempt]
      if (retryDelay) {
        await new Promise((resolve) => setTimeout(resolve, retryDelay))
      }
    }

    if (lastVerification) return lastVerification
    throw lastError instanceof Error
      ? lastError
      : new BadGatewayException(
          'Microsoft tenant verification did not complete after consent.'
        )
  }

  async verifyTenantWithCredentials(
    microsoftTenantId: string,
    credentials: { clientId: string; clientSecret: string }
  ) {
    let graphToken: Awaited<ReturnType<MicrosoftConsentService['requestAccessToken']>>
    try {
      graphToken = await this.requestAccessToken(microsoftTenantId, credentials)
    } catch (error) {
      if (error instanceof MicrosoftRequestError) {
        throw new BadGatewayException(error.message)
      }
      throw error
    }
    const { accessToken, grantedPermissions: graphPermissions } = graphToken

    // Application permissions are resource-specific. ActivityFeed.Read is
    // issued by the Office 365 Management APIs, so it never appears in a
    // Microsoft Graph token even after the customer grants consent.
    let managementPermissions: string[] = []
    try {
      const managementToken = await this.requestAccessToken(
        microsoftTenantId,
        credentials,
        'https://manage.office.com/.default'
      )
      managementPermissions = managementToken.grantedPermissions
    } catch {
      // Keep tenant verification useful before the new resource permission is
      // granted. The combined permission check below will report it as missing
      // and drive the admin-consent update flow in the UI.
    }
    const grantedPermissions = [
      ...new Set([...graphPermissions, ...managementPermissions]),
    ]

    const organizationResponse = await fetchMicrosoftWithRetry(
      'https://graph.microsoft.com/v1.0/organization?$select=id,displayName,verifiedDomains',
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: 'application/json',
        },
      },
      { label: 'Microsoft organization verification', timeoutMs: 15_000 },
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
    const missingRequiredPermissions = CONNECTION_REQUIRED_PERMISSIONS.filter(
      (permission) => !grantedPermissions.includes(permission),
    )
    const missingNonConnectionPermissions = missingPermissions.filter(
      (permission) => !missingRequiredPermissions.includes(permission),
    )

    return {
      displayName: organization.displayName,
      primaryDomain,
      grantedPermissions: [...new Set(grantedPermissions)].sort(),
      missingPermissions,
      missingRequiredPermissions,
      missingNonConnectionPermissions,
    }
  }

  private async requestAccessToken(
    microsoftTenantId: string,
    credentials: { clientId: string; clientSecret: string },
    scope = 'https://graph.microsoft.com/.default'
  ) {
    const { clientId, clientSecret } = credentials
    const tokenUrl = `https://login.microsoftonline.com/${microsoftTenantId}/oauth2/v2.0/token`
    const tokenResponse = await fetchMicrosoftWithRetry(tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        scope,
        grant_type: 'client_credentials',
      }),
    }, {
      label: 'Microsoft tenant access-token acquisition',
      timeoutMs: 15_000,
      // Client-credentials token acquisition is idempotent. Retrying only
      // transport/429/5xx failures never repeats a user or tenant mutation.
      retryUnsafeMethod: true,
    })

    if (!tokenResponse.ok) {
      const metadata = await microsoftErrorMetadata(tokenResponse)
      throw new MicrosoftRequestError(
        `Microsoft tenant access-token acquisition returned ${tokenResponse.status}.`,
        tokenResponse.status,
        metadata.code,
        metadata.requestId,
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
    const directoryRoleIds = Array.isArray(tokenClaims.wids)
      ? tokenClaims.wids.filter(
          (roleId): roleId is string => typeof roleId === 'string'
        )
      : []

    return {
      accessToken: tokenBody.access_token,
      grantedPermissions,
      directoryRoleIds,
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

  async getTenantExchangeAccessToken(input: {
    microsoftTenantId: string
    connectionMode: 'HAWKVIEW_MANAGED' | 'CUSTOMER_MANAGED'
    clientId: string | null
    credentialReference: string | null
  }) {
    const credentials = input.connectionMode === 'CUSTOMER_MANAGED'
      ? {
          clientId: input.clientId ?? '',
          clientSecret: input.credentialReference
            ? await this.secretStore.access(input.credentialReference)
            : '',
        }
      : await this.getManagedConnector()
    if (!credentials.clientId || !credentials.clientSecret) {
      throw new ServiceUnavailableException('The Microsoft tenant connection is incomplete.')
    }
    const result = await this.requestAccessToken(
      input.microsoftTenantId,
      credentials,
      'https://outlook.office365.com/.default',
    )
    if (!result.grantedPermissions.includes('Exchange.ManageAsAppV2')) {
      throw new BadRequestException(
        'Exchange.ManageAsAppV2 administrator consent has not been granted to this connector.',
      )
    }
    if ((result.directoryRoleIds ?? []).length > 0) {
      throw new BadRequestException(
        'The Exchange connector has a broader Microsoft Entra directory role. Remove broad directory roles before enabling Get-Mailbox-only mode.',
      )
    }
    return result.accessToken
  }

  async verifyTenantExchangeConsent(input: {
    microsoftTenantId: string
    connectionMode: 'HAWKVIEW_MANAGED' | 'CUSTOMER_MANAGED'
    clientId: string | null
    credentialReference: string | null
  }) {
    await this.getTenantExchangeAccessToken(input)
    return { permission: 'Exchange.ManageAsAppV2' as const }
  }

  async verifyConnectedTenant(input: {
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

    return this.verifyTenantWithCredentials(
      input.microsoftTenantId,
      credentials
    )
  }

  async getTenantManagementActivityAccessToken(input: {
    microsoftTenantId: string
    connectionMode: 'HAWKVIEW_MANAGED' | 'CUSTOMER_MANAGED'
    clientId: string | null
    credentialReference: string | null
  }) {
    const context = await this.getTenantManagementActivityContext(input)
    return context.accessToken
  }

  async getTenantManagementActivityContext(input: {
    microsoftTenantId: string
    connectionMode: 'HAWKVIEW_MANAGED' | 'CUSTOMER_MANAGED'
    clientId: string | null
    credentialReference: string | null
  }) {
    const credentials =
      input.connectionMode === 'CUSTOMER_MANAGED'
        ? {
            clientId: input.clientId ?? '',
            // Customer-managed connectors are currently tenant-local. If
            // HawkView later supports a customer-owned multi-tenant ISV app,
            // its publisher tenant must become an explicit stored field.
            homeTenantId: input.microsoftTenantId,
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
      credentials,
      'https://manage.office.com/.default'
    )
    return {
      accessToken: result.accessToken,
      publisherIdentifier: credentials.homeTenantId,
    }
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
    if (verification.missingRequiredPermissions.length > 0) {
      throw new BadRequestException(
        `The connector is missing connection-required permission(s): ${verification.missingRequiredPermissions.join(', ')}.`
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
    if (verification.missingRequiredPermissions.length > 0) {
      throw new BadRequestException(
        `The customer-managed application is missing connection-required permission(s): ${verification.missingRequiredPermissions.join(', ')}.`
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
