import { randomBytes } from 'node:crypto'
import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common'
import {
  CustomerTenantStatus,
  MembershipRole,
  MembershipStatus,
  OrganizationStatus,
  TenantConnectionStatus,
} from '../generated/prisma/enums.js'
import { PrismaService } from '../prisma/prisma.service.js'
import { GitHubCanaryOidcService } from './github-canary-oidc.service.js'

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const FULL_GIT_REVISION = /^[0-9a-f]{40}$/i
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const MAX_RESPONSE_BYTES = 64 * 1024

type CanarySlot = 'A' | 'B'

export type CanaryIdentityConfiguration = {
  slot: CanarySlot
  authUserId: string
  email: string
  organizationId: string
  tenantId: string
}

type CanaryConfiguration = {
  supabaseUrl: string
  serviceRoleKey: string
  identities: [CanaryIdentityConfiguration, CanaryIdentityConfiguration]
}

function plainRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
    ? (value as Record<string, unknown>)
    : null
}

function required(environment: NodeJS.ProcessEnv, key: string) {
  const value = environment[key]?.trim() ?? ''
  if (!value) throw new ServiceUnavailableException('The authenticated canary is not configured.')
  return value
}

function exactUuid(value: string) {
  return UUID_PATTERN.test(value) ? value.toLowerCase() : null
}

function canaryIdentity(
  environment: NodeJS.ProcessEnv,
  slot: CanarySlot,
): CanaryIdentityConfiguration {
  const prefix = `HAWKVIEW_CANARY_${slot}`
  const authUserId = exactUuid(required(environment, `${prefix}_AUTH_USER_ID`))
  const organizationId = exactUuid(required(environment, `${prefix}_ORGANIZATION_ID`))
  const tenantId = exactUuid(required(environment, `${prefix}_TENANT_ID`))
  const email = required(environment, `${prefix}_EMAIL`).toLowerCase()
  if (!authUserId || !organizationId || !tenantId || !EMAIL_PATTERN.test(email)) {
    throw new ServiceUnavailableException('The authenticated canary configuration is invalid.')
  }
  return { slot, authUserId, email, organizationId, tenantId }
}

export function canaryConfigurationFromEnvironment(
  environment: NodeJS.ProcessEnv,
): CanaryConfiguration {
  if (environment.HAWKVIEW_CANARY_ENABLED?.trim().toLowerCase() !== 'true') {
    throw new NotFoundException()
  }
  const supabaseCandidate = required(environment, 'SUPABASE_URL').replace(/\/$/, '')
  let supabaseUrl: URL
  try {
    supabaseUrl = new URL(supabaseCandidate)
  } catch {
    throw new ServiceUnavailableException('The authenticated canary configuration is invalid.')
  }
  if (
    supabaseUrl.protocol !== 'https:' ||
    !/^[a-z0-9]+\.supabase\.co$/i.test(supabaseUrl.hostname) ||
    supabaseUrl.port ||
    supabaseUrl.username ||
    supabaseUrl.password ||
    (supabaseUrl.pathname !== '/' && supabaseUrl.pathname !== '') ||
    supabaseUrl.search ||
    supabaseUrl.hash
  ) {
    throw new ServiceUnavailableException('The authenticated canary configuration is invalid.')
  }

  const identities: CanaryConfiguration['identities'] = [
    canaryIdentity(environment, 'A'),
    canaryIdentity(environment, 'B'),
  ]
  if (
    identities[0].authUserId === identities[1].authUserId ||
    identities[0].email === identities[1].email ||
    identities[0].organizationId === identities[1].organizationId ||
    identities[0].tenantId === identities[1].tenantId
  ) {
    throw new ServiceUnavailableException('The authenticated canary identities are not isolated.')
  }

  return {
    supabaseUrl: supabaseUrl.origin,
    serviceRoleKey: required(environment, 'SUPABASE_SERVICE_ROLE_KEY'),
    identities,
  }
}

export function parseCanaryIssueBody(body: unknown) {
  const candidate = plainRecord(body)
  if (!candidate || Object.keys(candidate).length !== 1) {
    throw new BadRequestException('Invalid canary request.')
  }
  const revision = candidate.deploymentRevision
  if (typeof revision !== 'string' || !FULL_GIT_REVISION.test(revision.trim())) {
    throw new BadRequestException('Invalid canary request.')
  }
  return revision.trim().toLowerCase()
}

async function boundedJson(response: Response) {
  const reader = response.body?.getReader()
  if (!reader) return null
  const chunks: Uint8Array[] = []
  let bytes = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    if (!value) continue
    bytes += value.byteLength
    if (bytes > MAX_RESPONSE_BYTES) {
      await reader.cancel()
      throw new ServiceUnavailableException('The canary identity provider response was invalid.')
    }
    chunks.push(value)
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
  } catch {
    return null
  }
}

@Injectable()
export class AuthenticatedCanaryService {
  constructor(
    @Inject(PrismaService)
    private readonly prisma: PrismaService,
    @Inject(GitHubCanaryOidcService)
    private readonly oidc: GitHubCanaryOidcService,
  ) {}

  private async assertSyntheticFixture(identity: CanaryIdentityConfiguration) {
    const user = await this.prisma.user.findUnique({
      where: { authProviderUserId: identity.authUserId },
      select: {
        email: true,
        disabledAt: true,
        memberships: {
          select: {
            organizationId: true,
            role: true,
            status: true,
            organization: { select: { status: true } },
          },
        },
      },
    })
    const organizationMemberCount = await this.prisma.membership.count({
      where: { organizationId: identity.organizationId },
    })
    const tenants = await this.prisma.customerTenant.findMany({
      where: { organizationId: identity.organizationId },
      select: {
        id: true,
        status: true,
        connection: {
          select: {
            status: true,
            connectionMode: true,
            clientId: true,
            credentialReference: true,
            consentedPermissions: true,
            consentedAt: true,
            onboardingCompletedAt: true,
          },
        },
      },
      take: 2,
    })
    const membership = user?.memberships[0]
    const tenant = tenants[0]
    if (
      !user ||
      user.disabledAt !== null ||
      user.email.trim().toLowerCase() !== identity.email ||
      user.memberships.length !== 1 ||
      membership?.organizationId !== identity.organizationId ||
      membership.role !== MembershipRole.MSP_OWNER ||
      membership.status !== MembershipStatus.ACTIVE ||
      membership.organization.status !== OrganizationStatus.ACTIVE ||
      organizationMemberCount !== 1 ||
      tenants.length !== 1 ||
      tenant?.id !== identity.tenantId ||
      tenant.status !== CustomerTenantStatus.PENDING ||
      !tenant.connection ||
      tenant.connection.status !== TenantConnectionStatus.PENDING_CONSENT ||
      tenant.connection.connectionMode !== 'HAWKVIEW_MANAGED' ||
      tenant.connection.clientId !== null ||
      tenant.connection.credentialReference !== null ||
      tenant.connection.consentedPermissions.length !== 0 ||
      tenant.connection.consentedAt !== null ||
      tenant.connection.onboardingCompletedAt !== null
    ) {
      throw new ServiceUnavailableException('The synthetic canary fixture is not isolated.')
    }
  }

  private async supabaseRequest(
    configuration: CanaryConfiguration,
    path: string,
    init: RequestInit,
  ) {
    let response: Response
    try {
      response = await fetch(`${configuration.supabaseUrl}${path}`, {
        ...init,
        headers: {
          apikey: configuration.serviceRoleKey,
          Authorization: `Bearer ${configuration.serviceRoleKey}`,
          'Content-Type': 'application/json',
          ...init.headers,
        },
        signal: AbortSignal.timeout(10_000),
      })
    } catch {
      throw new ServiceUnavailableException('The canary identity provider is unavailable.')
    }
    const result = await boundedJson(response)
    if (!response.ok) {
      throw new ServiceUnavailableException('The canary identity provider rejected the request.')
    }
    return result
  }

  private async setTemporaryPassword(
    configuration: CanaryConfiguration,
    identity: CanaryIdentityConfiguration,
    password: string,
  ) {
    await this.supabaseRequest(
      configuration,
      `/auth/v1/admin/users/${encodeURIComponent(identity.authUserId)}`,
      {
        method: 'PUT',
        headers: { Authorization: `Bearer ${configuration.serviceRoleKey}` },
        body: JSON.stringify({ password }),
      },
    )
  }

  private async issueIdentitySession(
    configuration: CanaryConfiguration,
    identity: CanaryIdentityConfiguration,
  ) {
    await this.assertSyntheticFixture(identity)
    const temporaryPassword = randomBytes(48).toString('base64url')
    const rotatedPassword = randomBytes(48).toString('base64url')
    await this.setTemporaryPassword(configuration, identity, temporaryPassword)

    let result: unknown
    try {
      result = await this.supabaseRequest(
        configuration,
        '/auth/v1/token?grant_type=password',
        {
          method: 'POST',
          body: JSON.stringify({ email: identity.email, password: temporaryPassword }),
        },
      )
    } finally {
      await this.setTemporaryPassword(configuration, identity, rotatedPassword)
    }

    const session = plainRecord(result)
    const user = plainRecord(session?.user)
    const accessToken = session?.access_token
    const tokenType = session?.token_type
    const expiresIn = session?.expires_in
    if (
      typeof accessToken !== 'string' ||
      accessToken.length < 100 ||
      tokenType !== 'bearer' ||
      typeof expiresIn !== 'number' ||
      !Number.isInteger(expiresIn) ||
      expiresIn < 60 ||
      expiresIn > 3600 ||
      user?.id !== identity.authUserId ||
      typeof user.email !== 'string' ||
      user.email.trim().toLowerCase() !== identity.email
    ) {
      throw new ServiceUnavailableException('The canary identity provider response was invalid.')
    }

    return {
      slot: identity.slot,
      accessToken,
      tokenType,
      expiresIn,
      email: identity.email,
      expectedOrganizationId: identity.organizationId,
      expectedTenantId: identity.tenantId,
    }
  }

  async issueSessions(authorization: string | undefined, body: unknown) {
    const match = authorization?.match(/^Bearer ([^\s]+)$/)
    if (!match) throw new NotFoundException()
    const deploymentRevision = parseCanaryIssueBody(body)
    const configuration = canaryConfigurationFromEnvironment(process.env)
    const liveRevision = process.env.RENDER_GIT_COMMIT?.trim().toLowerCase() ?? ''
    if (liveRevision !== deploymentRevision) {
      throw new ServiceUnavailableException('The requested canary revision is not live.')
    }

    await this.oidc.verify(match[1], deploymentRevision)
    const sessions = []
    for (const identity of configuration.identities) {
      sessions.push(await this.issueIdentitySession(configuration, identity))
    }
    return { contractVersion: 1 as const, deploymentRevision, sessions }
  }
}
