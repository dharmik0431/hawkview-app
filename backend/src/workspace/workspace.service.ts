import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common'
import type { AuthenticatedIdentity } from '../auth/auth.types.js'
import {
  MembershipRole,
  MembershipStatus
} from '../generated/prisma/enums.js'
import type { Prisma } from '../generated/prisma/client.js'
import { PrismaService } from '../prisma/prisma.service.js'
import { resolveHawkViewAuthRedirectUrl } from './auth-email-config.js'
import {
  parseOrganizationSettings,
  parseOrganizationId,
  sameOrganizationSettings,
  workspaceOnboardingView,
} from './organization-onboarding.js'
import {
  createWorkspaceAuditOperation,
  safeWorkspaceAuditMetadata,
  type WorkspaceAuditMetadata,
  type WorkspaceAuditOperation,
  WORKSPACE_AUDIT_EVENT_VERSION,
  workspaceAuditErrorCode,
  workspaceAuditExpiration,
} from './workspace-audit.js'

const ROLE_VALUES = new Set(Object.values(MembershipRole))
const STATUS_VALUES = new Set(Object.values(MembershipStatus))
const AUTH_EMAIL_RATE_LIMITED_CODE = 'AUTH_EMAIL_RATE_LIMITED'
const AUTH_EMAIL_RATE_LIMITED_MESSAGE =
  'Authentication email sending is temporarily rate-limited. Please wait a few minutes and try again.'
const INVITATION_NOT_PENDING_CODE = 'INVITATION_NOT_PENDING'
const PASSWORD_RESET_REQUIRES_ACCEPTED_ACCOUNT_CODE =
  'PASSWORD_RESET_REQUIRES_ACCEPTED_ACCOUNT'
const EXISTING_AUTH_ACCOUNT = Symbol('existing-auth-account')

type OwnerContext = {
  userId: string
  email: string
  organizationId: string
  organizationName: string
  businessDomain: string | null
  timeZone: string | null
  onboardingCompletedAt: Date | null
}

type MemberRecord = {
  id: string
  userId: string
  organizationId: string
  role: MembershipRole
  status: MembershipStatus
  user: {
    id: string
    email: string
    displayName: string | null
    authProviderUserId: string | null
    disabledAt: Date | null
    inviteSentAt: Date | null
    inviteAcceptedAt: Date | null
    createdAt: Date
  }
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new BadRequestException('Invalid workspace administration request.')
  }
  return value as Record<string, unknown>
}

function requiredOrganizationId(body: unknown): string {
  const payload = record(body)
  const value = Object.prototype.hasOwnProperty.call(payload, 'organizationId')
    ? payload.organizationId
    : undefined
  return parseOrganizationId(value)
}

function stringValue(body: Record<string, unknown>, name: string): string {
  const value = body[name]
  return typeof value === 'string' ? value.trim() : ''
}

@Injectable()
export class WorkspaceService {
  private readonly logger = new Logger(WorkspaceService.name)
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  private async ownerContext(
    identity: AuthenticatedIdentity,
    requestedOrganizationId?: string
  ): Promise<OwnerContext> {
    const actor = await this.prisma.user.findUnique({
      where: { authProviderUserId: identity.subject },
      select: {
        id: true,
        email: true,
        disabledAt: true,
        memberships: {
          where: {
            role: MembershipRole.MSP_OWNER,
            status: MembershipStatus.ACTIVE,
            organization: { status: 'ACTIVE' },
          },
          select: {
            organization: {
              select: {
                id: true,
                name: true,
                businessDomain: true,
                timeZone: true,
                onboardingCompletedAt: true,
              },
            },
          },
        },
      },
    })

    if (!actor) throw new ForbiddenException('HawkView user account was not found.')
    if (actor.disabledAt) {
      throw new ForbiddenException('This HawkView account is disabled.')
    }
    const memberships = actor.memberships.filter(
      ({ organization }) => !requestedOrganizationId || organization.id === requestedOrganizationId
    )
    if (memberships.length === 0) {
      throw new ForbiddenException('Only an active MSP owner can manage this workspace team.')
    }
    const organization = memberships[0].organization
    return {
      userId: actor.id,
      email: actor.email,
      organizationId: organization.id,
      organizationName: organization.name,
      businessDomain: organization.businessDomain,
      timeZone: organization.timeZone,
      onboardingCompletedAt: organization.onboardingCompletedAt,
    }
  }

  private async memberForOwner(
    organizationId: string,
    membershipId: string
  ): Promise<MemberRecord> {
    const membership = await this.prisma.membership.findFirst({
      where: { id: membershipId, organizationId },
      include: {
        user: {
          select: {
            id: true,
            email: true,
            displayName: true,
            authProviderUserId: true,
            disabledAt: true,
            inviteSentAt: true,
            inviteAcceptedAt: true,
            createdAt: true,
          },
        },
      },
    })
    if (!membership) throw new NotFoundException('Workspace team member was not found.')
    return membership
  }

  private async ownerCount(organizationId: string): Promise<number> {
    return this.prisma.membership.count({
      where: { organizationId, role: MembershipRole.MSP_OWNER, status: MembershipStatus.ACTIVE, },
    })
  }

  private async protectOwner(
    actor: OwnerContext,
    member: MemberRecord,
    nextRole: MembershipRole,
    nextStatus: MembershipStatus
  ) {
    const removesOwner =
      member.role === MembershipRole.MSP_OWNER &&
      member.status === MembershipStatus.ACTIVE &&
      (nextRole !== MembershipRole.MSP_OWNER || nextStatus !== MembershipStatus.ACTIVE)
    if (!removesOwner) return
    const organization = await this.prisma.organization.findUnique({
      where: { id: actor.organizationId },
      select: { createdByUserId: true, onboardingCompletedAt: true },
    })
    if (
      organization?.onboardingCompletedAt === null &&
      organization.createdByUserId === member.userId
    ) {
      throw new BadRequestException(
        'The founding MSP owner cannot be removed or demoted until organization setup is complete.'
      )
    }
    if (member.userId === actor.userId) {
      throw new BadRequestException('You cannot remove, suspend, or demote your own MSP owner access.')
    }
    if ((await this.ownerCount(actor.organizationId)) <= 1) {
      throw new BadRequestException('Assign another active MSP owner before changing the last owner.')
    }
  }

  private async audit(
    actor: OwnerContext,
    evidence: WorkspaceAuditOperation & {
    action: string
      outcome: 'STARTED' | 'SUCCEEDED' | 'FAILED'
      stage: string
      errorCode?: string | null
      targetType: 'ORGANIZATION' | 'WORKSPACE_MEMBER'
      targetUserId?: string | null
      targetOpaqueId: string
      metadata?: WorkspaceAuditMetadata
    },
    client: Pick<PrismaService, 'workspaceAdminAuditLog'> = this.prisma
  ) {
    await client.workspaceAdminAuditLog.create({
      data: {
        organizationId: actor.organizationId,
        actorUserId: actor.userId,
        // Actor and target emails are intentionally not duplicated into new
        // audit rows. Internal IDs remain enough to resolve authorized views.
        actorEmail: null,
        targetUserId: evidence.targetUserId ?? null,
        targetEmail: null,
        targetType: evidence.targetType,
        targetOpaqueId: evidence.targetOpaqueId.slice(0, 128),
        action: evidence.
        action,
        outcome: evidence.outcome,
        stage: evidence.stage,
        errorCode: evidence.errorCode ?? null,
        requestId: evidence.requestId,
        operationId: evidence.operationId,
        eventVersion: WORKSPACE_AUDIT_EVENT_VERSION,
        metadata: safeWorkspaceAuditMetadata(evidence. metadata) as
          | Prisma.InputJsonObject | undefined,
        expiresAt: workspaceAuditExpiration(),
      },
    })
  }

  private operation(requestId?: string) {
    return createWorkspaceAuditOperation(requestId)
  }

  private memberTarget(
    operation: WorkspaceAuditOperation,
    userId?: string | null
  ) {
    return {
      targetType: 'WORKSPACE_MEMBER' as const,
      targetUserId: userId ?? null,
      targetOpaqueId: userId || `invite:${operation.operationId}`,
    }
  }

  private organizationSettingsView(organization: {
    id: string
    name: string
    businessDomain: string | null
    timeZone: string | null
    onboardingCompletedAt: Date | null
  }) {
    return {
      organization: {
        id: organization.id,
        name: organization.name,
        businessDomain: organization.businessDomain,
        businessDomainVerification: 'UNVERIFIED_INFORMATIONAL' as const,
        timeZone: organization.timeZone,
        onboardingCompletedAt: organization.onboardingCompletedAt,
      },
      workspaceOnboarding: workspaceOnboardingView(organization),
    }
  }

  private activeOwnerWhere(actor: OwnerContext, requireFounder = false) {
    return {
      id: actor.organizationId,
      status: 'ACTIVE' as const,
      ...(requireFounder ? { createdByUserId: actor.userId } : {}),
      memberships: {
        some: {
          userId: actor.userId,
          role: MembershipRole.MSP_OWNER,
          status: MembershipStatus.ACTIVE,
        },
      },
    }
  }

  private async assertOrganizationAuthority(
    transaction: Prisma.TransactionClient,
    actor: OwnerContext,
    requireFounder: boolean
  ) {
    const activeOrganization = await transaction.organization.findFirst({
      where: {
        id: actor.organizationId,
        status: 'ACTIVE',
        memberships: {
          some: {
            userId: actor.userId,
            role: MembershipRole.MSP_OWNER,
            status: MembershipStatus.ACTIVE,
          },
        },
      },
      select: {
        id: true,
        name: true,
        businessDomain: true,
        timeZone: true,
        onboardingCompletedAt: true,
        createdByUserId: true,
        updatedAt: true,
      },
    })
    if (!activeOrganization) {
      throw new ForbiddenException('Only an active MSP owner can manage this organization.')
    }
    if (requireFounder && activeOrganization.createdByUserId !== actor.userId) {
      throw new ForbiddenException(
        'Only the founding MSP owner can manage this organization identity.'
      )
    }
    return activeOrganization
  }

  async completeOrganizationOnboarding(
    identity: AuthenticatedIdentity,
    body: unknown,
    requestId?: string
  ) {
    const input = parseOrganizationSettings(body)
    const actor = await this.ownerContext(identity, input.organizationId)
    const completedAt = new Date()
    const operation = this.operation(requestId)

    try {

    return await this.prisma.$transaction(async (transaction) => {
      const result = await transaction.organization.updateMany({
        where: {
          ...this.activeOwnerWhere(actor, true),
          onboardingCompletedAt: null,
        },
        data: {
          name: input.organizationName,
          businessDomain: input.businessDomain,
          timeZone: input.timeZone,
          onboardingCompletedAt: completedAt,
        },
      })

      if (result.count === 0) {
        const organization = await this.assertOrganizationAuthority(
          transaction,
          actor,
          true
        )
        if (
          organization.onboardingCompletedAt &&
          sameOrganizationSettings(organization, input)
        ) {
          return this.organizationSettingsView(organization)
        }
        if (organization.onboardingCompletedAt) {
          throw new ConflictException(
            'Organization setup is already complete. Use organization settings to make changes.'
          )
        }
        throw new ConflictException(
          'Organization setup changed while this request was being processed. Refresh and try again.'
        )
      }

      const organization = await transaction.organization.findUniqueOrThrow({
        where: { id: actor.organizationId },
        select: {
          id: true,
          name: true,
          businessDomain: true,
          timeZone: true,
          onboardingCompletedAt: true,
        },
      })
      await this.audit(
          actor,{
            ...operation,
          action: 'ORGANIZATION_ONBOARDING_COMPLETED',
          outcome: 'SUCCEEDED',
            stage: 'COMPLETED',
            targetType: 'ORGANIZATION',
            targetOpaqueId: actor.organizationId,
          metadata: { changedFields: ['name', 'businessDomain', 'timeZone']
          },
        },
          transaction)
      return this.organizationSettingsView(organization)
    })
  } catch (error) {
      await this.audit(actor, {
        ...operation,
        action: 'ORGANIZATION_ONBOARDING_FAILED',
        outcome: 'FAILED',
        stage: 'ORGANIZATION_PERSISTENCE',
        errorCode: workspaceAuditErrorCode(error),
        targetType: 'ORGANIZATION',
        targetOpaqueId: actor.organizationId,
      })
      throw error
    }
  }

  async updateOrganization(identity: AuthenticatedIdentity, body: unknown,
    requestId?: string) {
    const input = parseOrganizationSettings(body)
    const actor = await this.ownerContext(identity, input.organizationId)
    const operation = this.operation(requestId)

    try {

    return await this.prisma.$transaction(async (transaction) => {
      const current = await this.assertOrganizationAuthority(
        transaction,
        actor,
        false
      )
      if (!current.onboardingCompletedAt) {
        throw new ConflictException(
          'Complete organization setup before changing organization settings.'
        )
      }
      if (sameOrganizationSettings(current, input)) {
        return this.organizationSettingsView(current)
      }

      const result = await transaction.organization.updateMany({
        where: {
          ...this.activeOwnerWhere(actor),
          onboardingCompletedAt: { not: null },
          updatedAt: current.updatedAt,
        },
        data: {
          name: input.organizationName,
          businessDomain: input.businessDomain,
          timeZone: input.timeZone,
        },
      })
      if (result.count !== 1) {
        throw new ConflictException(
          'Organization settings changed while this request was being processed. Refresh and try again.'
        )
      }
      const organization = await transaction.organization.findUniqueOrThrow({
        where: { id: actor.organizationId },
        select: {
          id: true,
          name: true,
          businessDomain: true,
          timeZone: true,
          onboardingCompletedAt: true,
        },
      })
      const changedFields: string[] = []
      if (current.name !== organization.name) changedFields.push('name')
      if (current.businessDomain !== organization.businessDomain) {
        changedFields.push('businessDomain')
      }
      if (current.timeZone !== organization.timeZone) changedFields.push('timeZone')
      await this.audit(
          actor,{
            ...operation,
          action: 'ORGANIZATION_SETTINGS_UPDATED',
          outcome: 'SUCCEEDED',
            stage: 'COMPLETED',
            targetType: 'ORGANIZATION',
            targetOpaqueId: actor.organizationId,
          metadata: { changedFields },
        },
          transaction)
      return this.organizationSettingsView(organization)
    })
    } catch (error) {
      await this.audit(actor, {
        ...operation,
        action: 'ORGANIZATION_SETTINGS_UPDATE_FAILED',
        outcome: 'FAILED',
        stage: 'ORGANIZATION_PERSISTENCE',
        errorCode: workspaceAuditErrorCode(error),
        targetType: 'ORGANIZATION',
        targetOpaqueId: actor.organizationId,
      })
      throw error
    }
  }

  private memberView(member: MemberRecord) {
    return {
      membershipId: member.id,
      userId: member.user.id,
      email: member.user.email,
      displayName: member.user.displayName,
      role: member.role,
      status: member.status,
      joinedAt: member.user.createdAt,
      // A Supabase identity is created as soon as an invitation is sent. It
      // does not mean the recipient has completed account setup.
      hasHawkViewAccount: Boolean(member.user.inviteAcceptedAt),
      invitationSentAt: member.user.inviteSentAt,
      invitationAcceptedAt: member.user.inviteAcceptedAt,
      disabled: Boolean(member.user.disabledAt),
    }
  }

  async listMembers(identity: AuthenticatedIdentity, organizationId?: string) {
    const actor = await this.ownerContext(identity, parseOrganizationId(organizationId))
    const members = await this.prisma.membership.findMany({
      where: { organizationId: actor.organizationId },
      orderBy: [{ role: 'asc' }, { user: { email: 'asc' } }],
      include: {
        user: {
          select: {
            id: true, email: true, displayName: true, authProviderUserId: true,
            disabledAt: true, inviteSentAt: true, inviteAcceptedAt: true, createdAt: true,
          },
        },
      },
    })
    return {
      organization: {
        id: actor.organizationId,
        name: actor.organizationName,
        businessDomain: actor.businessDomain,
        businessDomainVerification: 'UNVERIFIED_INFORMATIONAL' as const,
        timeZone: actor.timeZone,
        onboardingCompletedAt: actor.onboardingCompletedAt,
      },
      canManage: true,
      canEditOrganization: actor.onboardingCompletedAt !== null,
      members: members.map((member) => this.memberView(member)),
    }
  }

  async listAuditLogs(identity: AuthenticatedIdentity, organizationId?: string) {
    const actor = await this.ownerContext(identity, parseOrganizationId(organizationId))
    const now = new Date()
    try {
      await this.prisma.workspaceAdminAuditLog.deleteMany({
        where: {
          organizationId: actor.organizationId,
          expiresAt: { lte: now },
        },
      })
    } catch {
      // Retention cleanup must not turn a read into an outage. Expired rows are
      // still excluded below and a later authorized read retries cleanup.
      this.logger.warn('Workspace audit retention cleanup was unavailable.')
    }
    const items = await this.prisma.workspaceAdminAuditLog.findMany({
      // A positive expiry predicate is deliberate defense in depth. PostgreSQL
      // enforces NOT NULL after the retention migration, and any unexpected
      // drifted NULL remains invisible rather than becoming indefinitely readable.
      where: {
        organizationId: actor.organizationId,
        expiresAt: { gt: now },
      },
      orderBy: { createdAt: 'desc' },
      take: 100,
    })
    return { items }
  }

  private supabaseConfiguration() {
    const url = process.env.SUPABASE_URL?.trim().replace(/\/$/, '')
    const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim()
    if (!url || !serviceRoleKey) {
      throw new ServiceUnavailableException(
        'HawkView account administration is not configured. Contact a platform administrator.'
      )
    }
    return { url, serviceRoleKey }
  }

  private authEmailRedirectUrl() {
    try {
      return resolveHawkViewAuthRedirectUrl(
        process.env.HAWKVIEW_AUTH_REDIRECT_URL
      )
    } catch {
      throw new ServiceUnavailableException(
        'HawkView account administration is not configured correctly. Contact a platform administrator.'
      )
    }
  }

  private async supabaseAdminRequest(path: string, init: RequestInit) {
    const { url, serviceRoleKey } = this.supabaseConfiguration()
    let response: Response
    try {
      response = await fetch(`${url}${path}`, {
        ...init,
        headers: {
          apikey: serviceRoleKey,
          Authorization: `Bearer ${serviceRoleKey}`,
          'Content-Type': 'application/json',
          ...init.headers,
        },
      })
    } catch {
      throw new ServiceUnavailableException('HawkView account service could not be reached.')
    }
    const text = await response.text()
    let result: unknown = null
    try { result = text ? JSON.parse(text) : null } catch { result = null }
    if (!response.ok) {
      const isAuthenticationEmailRequest = path === '/auth/v1/invite' || path === '/auth/v1/recover'
      if (response.status === HttpStatus.TOO_MANY_REQUESTS && isAuthenticationEmailRequest) {
        throw new HttpException(
          {
            statusCode: HttpStatus.TOO_MANY_REQUESTS,
            code: AUTH_EMAIL_RATE_LIMITED_CODE,
            message: AUTH_EMAIL_RATE_LIMITED_MESSAGE,
          },
          HttpStatus.TOO_MANY_REQUESTS
        )
      }
      const providerCode =
        result && typeof result === 'object' && !Array.isArray(result) &&
        Object.prototype.hasOwnProperty.call(result, 'code')
          ? (result as { code?: unknown }).code
          : null
      if (
        path === '/auth/v1/invite' &&
        response.status === HttpStatus.UNPROCESSABLE_ENTITY &&
        providerCode === 'email_exists'
      ) {
        // Existing confirmed accounts are intentionally indistinguishable from
        // eligible new addresses at this email-entry boundary.
        return EXISTING_AUTH_ACCOUNT
      }
      throw new BadRequestException('The requested HawkView account operation could not be completed.')
    }
    return result
  }

  async inviteMember(identity: AuthenticatedIdentity, body: unknown,
    requestId?: string) {
    const candidate = record(body)
    const actor = await this.ownerContext(identity, requiredOrganizationId(body)
    )
    const operation = this.operation(requestId)
    const email = stringValue(candidate, 'email').toLowerCase()
    const displayName = stringValue(candidate, 'displayName') || null
    const role = stringValue(candidate, 'role') as MembershipRole
    let stage = 'REQUEST_VALIDATION'
    let target = this.memberTarget(operation)
    let user: MemberRecord['user'] | null = null
    const delivery = 'INVITE' as const

    // The intent is durable before any external email side effect. If this
    // write fails the request stops and Supabase is never called.
    await this.audit(actor, {
      ...operation,
      ...target,
      action: 'WORKSPACE_MEMBER_INVITE_REQUESTED',
      outcome: 'STARTED',
      stage: 'REQUEST_ACCEPTED',
    })

    try {
    if (!/^\S+@\S+\.\S+$/.test(email)) { throw new BadRequestException('Enter a valid email address.')
      }
    if (!ROLE_VALUES.has(role)) { throw new BadRequestException('Select a valid workspace role.')
      }
      stage = 'AUTH_PROVIDER'
      const invite = await this.supabaseAdminRequest('/auth/v1/invite', {
        method: 'POST',
        body: JSON.stringify({
          email,
          data: displayName ? { display_name: displayName } : undefined,
          redirect_to: this.authEmailRedirectUrl(),
        }),
      })
      await this.audit(actor, {
        ...operation,
        ...target,
        action: 'WORKSPACE_MEMBER_INVITE_PROVIDER_RESOLVED',
        outcome: 'SUCCEEDED',
        stage: 'AUTH_PROVIDER',
        metadata: { delivery },
      })

      stage = 'USER_PERSISTENCE'
      user = await this.prisma.user.findUnique({ where: { email } })
      if (invite === EXISTING_AUTH_ACCOUNT || user) {
        await this.audit(actor, {
          ...operation,
          ...target,
          action: 'WORKSPACE_MEMBER_INVITE_REQUEST_RESOLVED',
          outcome: 'SUCCEEDED',
          stage: 'COMPLETED',
          metadata: { role, delivery },
        })
        return {
          accepted: true,
          delivery,
          operationId: operation.operationId,
          requestId: operation.requestId,
        }
      }

      const providerInvite = invite as
        | { id?: unknown; user?: { id?: unknown } }
        | null
      const authProviderUserId = typeof providerInvite?.id === 'string'
        ? providerInvite.id
        : typeof providerInvite?.user?.id === 'string'
          ? providerInvite.user.id
          : null
      user = await this.prisma.user.create({
        data: { email, displayName, authProviderUserId, inviteSentAt: new Date(), },
      })
      target = this.memberTarget(operation, user.id)
      stage = 'MEMBERSHIP_PERSISTENCE'
    await this.prisma.$transaction(async (transaction) => {
        const persisted = await transaction.membership.upsert({
      where: { userId_organizationId: { userId: user!.id, organizationId: actor.organizationId, }, },
      create: { userId: user!.id, organizationId: actor.organizationId, role, status: MembershipStatus.ACTIVE, },
      update: { role, status: MembershipStatus.ACTIVE },
      include: { user: { select: { id: true, email: true, displayName: true, authProviderUserId: true, disabledAt: true, inviteSentAt: true, inviteAcceptedAt: true, createdAt: true, }, }, },
    })
    await this.audit(actor,
          {
            ...operation,
            ...this.memberTarget(operation),
            action: 'WORKSPACE_MEMBER_INVITE_REQUEST_RESOLVED',
            outcome: 'SUCCEEDED',
            stage: 'COMPLETED',
            metadata: { role, delivery },
          },
          transaction
        )
        return persisted })
    return { accepted: true, delivery,
        operationId: operation.operationId,
        requestId: operation.requestId,
      }
    } catch (error) {
      await this.audit(actor, {
        ...operation,
        ...target,
        action: 'WORKSPACE_MEMBER_INVITE_FAILED',
        outcome: 'FAILED',
        stage,
        errorCode: workspaceAuditErrorCode(error),
        metadata: {
          ...(ROLE_VALUES.has(role) ? { role } : {}),
          delivery,
        },
      })
      throw error }
  }

  async resendMemberInvitation(
    identity: AuthenticatedIdentity,
    membershipId: string,
    body: unknown,
    requestId?: string
  ) {
    const actor = await this.ownerContext(identity, requiredOrganizationId(body))
    const operation = this.operation(requestId)
    const member = await this.memberForOwner(actor.organizationId, membershipId)
    const target = this.memberTarget(operation, member.userId)
    const delivery = 'INVITE_RESEND' as const
    let stage = 'REQUEST_VALIDATION'

    // Persist intent before the provider side effect. If evidence storage is
    // unavailable, no invitation email is sent.
    await this.audit(actor, {
      ...operation,
      ...target,
      action: 'WORKSPACE_MEMBER_INVITE_RESEND_REQUESTED',
      outcome: 'STARTED',
      stage: 'REQUEST_ACCEPTED',
      metadata: { delivery },
    })

    try {
      const invitationIsPending =
        member.status === MembershipStatus.ACTIVE &&
        !member.user.disabledAt &&
        Boolean(member.user.authProviderUserId) &&
        Boolean(member.user.inviteSentAt) &&
        !member.user.inviteAcceptedAt

      if (!invitationIsPending) {
        throw new HttpException(
          {
            statusCode: HttpStatus.CONFLICT,
            code: INVITATION_NOT_PENDING_CODE,
            message:
              'This member does not have a pending HawkView invitation. Use password reset for an accepted account.',
          },
          HttpStatus.CONFLICT
        )
      }

      stage = 'AUTH_PROVIDER'
      await this.supabaseAdminRequest('/auth/v1/invite', {
        method: 'POST',
        body: JSON.stringify({
          email: member.user.email,
          data: member.user.displayName
            ? { display_name: member.user.displayName }
            : undefined,
          redirect_to: this.authEmailRedirectUrl(),
        }),
      })
      await this.audit(actor, {
        ...operation,
        ...target,
        action: 'WORKSPACE_MEMBER_INVITE_RESEND_PROVIDER_ACCEPTED',
        outcome: 'SUCCEEDED',
        stage: 'AUTH_PROVIDER',
        metadata: { delivery },
      })

      stage = 'USER_PERSISTENCE'
      const invitationSentAt = new Date()
      const updated = await this.prisma.$transaction(async (transaction) => {
        const user = await transaction.user.update({
          where: { id: member.userId },
          data: { inviteSentAt: invitationSentAt },
        })
        await this.audit(
          actor,
          {
            ...operation,
            ...target,
            action: 'WORKSPACE_MEMBER_INVITATION_RESENT',
            outcome: 'SUCCEEDED',
            stage: 'COMPLETED',
            metadata: { delivery },
          },
          transaction
        )
        return user
      })

      return {
        member: this.memberView({ ...member, user: updated }),
        delivery,
        operationId: operation.operationId,
        requestId: operation.requestId,
      }
    } catch (error) {
      await this.audit(actor, {
        ...operation,
        ...target,
        action: 'WORKSPACE_MEMBER_INVITE_RESEND_FAILED',
        outcome: 'FAILED',
        stage,
        errorCode: workspaceAuditErrorCode(error),
        metadata: { delivery },
      })
      throw error
    }
  }

  async updateMember(identity: AuthenticatedIdentity, membershipId: string, body: unknown,
    requestId?: string) {
    const candidate = record(body)
    const actor = await this.ownerContext(identity, requiredOrganizationId(body))
    const operation = this.operation(requestId)
    const member = await this.memberForOwner(actor.organizationId, membershipId)
    const target = this.memberTarget(operation, member.userId)
    let stage = 'REQUEST_VALIDATION'
    try {
    const roleValue = stringValue(candidate, 'role')
    const statusValue = stringValue(candidate, 'status')
    const role = roleValue ? ( roleValue as MembershipRole) : member.role
    const status = statusValue ? ( statusValue as MembershipStatus) : member.status
    if (!ROLE_VALUES.has(role) || !STATUS_VALUES.has(status)) {
      throw new BadRequestException('Invalid workspace role or status.')
    }
    await this.protectOwner(actor, member, role, status)
      stage = 'MEMBERSHIP_PERSISTENCE'
    const updated = await this.prisma.$transaction(async (transaction) => {
        const persisted = await transaction.membership.update({
      where: { id: member.id }, data: { role, status },
      include: { user: { select: { id: true, email: true, displayName: true, authProviderUserId: true, disabledAt: true, inviteSentAt: true, inviteAcceptedAt: true, createdAt: true, }, }, },
    })
    await this.audit(actor,
          {
            ...operation,
            ...target,
            action: 'WORKSPACE_MEMBER_UPDATED',
            outcome: 'SUCCEEDED',
            stage: 'COMPLETED',
            metadata: { role, status,
              priorRole: member.role,
              priorStatus: member.status,
            },
          },
          transaction
        )
        return persisted })
    return { member: this.memberView(updated),
        operationId: operation.operationId,
        requestId: operation.requestId,
      }
    } catch (error) {
      await this.audit(actor, {
        ...operation,
        ...target,
        action: 'WORKSPACE_MEMBER_UPDATE_FAILED',
        outcome: 'FAILED',
        stage,
        errorCode: workspaceAuditErrorCode(error),
        metadata: { priorRole: member.role, priorStatus: member.status },
      })
      throw error }
  }

  async removeMember(identity: AuthenticatedIdentity, membershipId: string, organizationId?: string,
    requestId?: string) {
    const actor = await this.ownerContext(
      identity,
      parseOrganizationId(organizationId)
    )
    const operation = this.operation(requestId
    )
    const member = await this.memberForOwner(actor.organizationId, membershipId)
    const target = this.memberTarget(operation, member.userId)
    let stage = 'REQUEST_VALIDATION'
    try {
    await this.protectOwner(actor, member, MembershipRole.MSP_VIEWER, MembershipStatus.SUSPENDED)
      stage = 'MEMBERSHIP_PERSISTENCE'
    await this.prisma.$transaction(async (transaction) => {
        await transaction.membership.delete({ where: { id: member.id } })
    await this.audit(actor,
          {
            ...operation,
            ...target,
            action: 'WORKSPACE_MEMBER_REMOVED',
            outcome: 'SUCCEEDED',
            stage: 'COMPLETED',
            metadata: { priorRole: member.role, priorStatus: member.status },
          },
          transaction
        )
      })
    return { removed: true,
        operationId: operation.operationId,
        requestId: operation.requestId,
      }
    } catch (error) {
      await this.audit(actor, {
        ...operation,
        ...target,
        action: 'WORKSPACE_MEMBER_REMOVE_FAILED',
        outcome: 'FAILED',
        stage,
        errorCode: workspaceAuditErrorCode(error),
        metadata: { priorRole: member.role, priorStatus: member.status },
      })
      throw error }
  }

  async sendPasswordReset(identity: AuthenticatedIdentity, membershipId: string, body: unknown,
    requestId?: string) {
    const actor = await this.ownerContext(identity, requiredOrganizationId(body))
    const operation = this.operation(requestId)
    const member = await this.memberForOwner(actor.organizationId, membershipId)
    const target = this.memberTarget(operation, member.userId)
    let stage = 'REQUEST_VALIDATION'
    await this.audit(actor, {
      ...operation,
      ...target,
      action: 'HAWKVIEW_PASSWORD_RESET_REQUESTED',
      outcome: 'STARTED',
      stage: 'REQUEST_ACCEPTED',
    })
    try {
      const accountCanResetPassword =
        !member.user.disabledAt &&
        Boolean(member.user.authProviderUserId) &&
        Boolean(member.user.inviteAcceptedAt)
      if (!accountCanResetPassword) {
        throw new HttpException(
          {
            statusCode: HttpStatus.CONFLICT,
            code: PASSWORD_RESET_REQUIRES_ACCEPTED_ACCOUNT_CODE,
            message:
              'Password reset is available only after the member accepts their HawkView invitation.',
          },
          HttpStatus.CONFLICT
        )
      }
      stage = 'AUTH_PROVIDER'
      await this.supabaseAdminRequest('/auth/v1/recover', {
        method: 'POST',
        body: JSON.stringify({
          email: member.user.email,
          redirect_to: this.authEmailRedirectUrl(),
        }),
      })
      await this.audit(actor, {
        ...operation,
        ...target,
        action: 'HAWKVIEW_PASSWORD_RESET_SENT',
        outcome: 'SUCCEEDED',
        stage: 'AUTH_PROVIDER',
      })
      return { sent: true,
        operationId: operation.operationId,
        requestId: operation.requestId, }
    } catch (error) {
      await this.audit(actor, {
        ...operation,
        ...target,
        action: 'HAWKVIEW_PASSWORD_RESET_FAILED',
        outcome: 'FAILED',
        stage,
        errorCode: workspaceAuditErrorCode(error),
      })
      throw error
    }
  }

  async resetHawkViewMfa(identity: AuthenticatedIdentity, membershipId: string, body: unknown,
    requestId?: string) {
    const actor = await this.ownerContext(identity, requiredOrganizationId(body))
    const operation = this.operation(requestId)
    const member = await this.memberForOwner(actor.organizationId, membershipId)
    const target = this.memberTarget(operation, member.userId)
    let stage = 'REQUEST_VALIDATION'
    await this.audit(actor, {
      ...operation,
      ...target,
      action: 'HAWKVIEW_MFA_RESET_REQUESTED',
      outcome: 'STARTED',
      stage: 'REQUEST_ACCEPTED',
    })
    try {
    if (member.userId === actor.userId) {
      throw new BadRequestException(
        'Use Account & Security to manage your own HawkView authenticators.'
      )
    }
    if (!member.user.authProviderUserId) {
      throw new BadRequestException('This invited member has not completed HawkView account setup yet.')
    }
      stage = 'AUTH_PROVIDER'
      const result = ( await this.supabaseAdminRequest(
        `/auth/v1/admin/users/${encodeURIComponent(member.user.authProviderUserId)}/factors`,
        { method: 'GET' }
      )
      ) as
        | { factors?: Array<{ id?: unknown }> } | Array<{ id?: unknown }> | null
      const factors = Array.isArray(result) ? result : Array.isArray(result?.factors) ? result.factors : []
      for (const factor of factors) {
        if (typeof factor.id === 'string') {
          await this.supabaseAdminRequest(
            `/auth/v1/admin/users/${encodeURIComponent(member.user.authProviderUserId)}/factors/${encodeURIComponent(factor.id)}`,
            { method: 'DELETE' }
          )
        }
      }
      await this.audit(actor, {
        ...operation,
        ...target,
        action: 'HAWKVIEW_MFA_RESET',
        outcome: 'SUCCEEDED',
        stage: 'COMPLETED',
        metadata: { factorsRemoved: factors.length }, })
      return { factorsRemoved: factors.length,
        operationId: operation.operationId,
        requestId: operation.requestId, }
    } catch (error) {
      await this.audit(actor, {
        ...operation,
        ...target,
        action: 'HAWKVIEW_MFA_RESET_FAILED',
        outcome: 'FAILED',
        stage,
        errorCode: workspaceAuditErrorCode(error),
      })
      throw error
    }
  }
}
