import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common'
import type { AuthenticatedIdentity } from '../auth/auth.types.js'
import {
  MembershipRole,
  MembershipStatus,
} from '../generated/prisma/enums.js'
import type { Prisma } from '../generated/prisma/client.js'
import { PrismaService } from '../prisma/prisma.service.js'

const ROLE_VALUES = new Set(Object.values(MembershipRole))
const STATUS_VALUES = new Set(Object.values(MembershipStatus))

type OwnerContext = {
  userId: string
  email: string
  organizationId: string
  organizationName: string
}

type AuditMetadata = Record<string, string | number | boolean | null>

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

function optionalOrganizationId(body: unknown): string | undefined {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return undefined
  const value = (body as Record<string, unknown>).organizationId
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function stringValue(body: Record<string, unknown>, name: string): string {
  const value = body[name]
  return typeof value === 'string' ? value.trim() : ''
}

@Injectable()
export class WorkspaceService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  private async ownerContext(
    identity: AuthenticatedIdentity,
    requestedOrganizationId?: string,
  ): Promise<OwnerContext> {
    const actor = await this.prisma.user.findFirst({
      where: {
        OR: [
          { authProviderUserId: identity.subject },
          { email: identity.email.toLowerCase() },
        ],
      },
      select: {
        id: true,
        email: true,
        memberships: {
          where: { role: MembershipRole.MSP_OWNER, status: MembershipStatus.ACTIVE },
          select: {
            organization: { select: { id: true, name: true } },
          },
        },
      },
    })

    if (!actor) throw new ForbiddenException('HawkView user account was not found.')
    const memberships = actor.memberships.filter(
      ({ organization }) => !requestedOrganizationId || organization.id === requestedOrganizationId,
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
    }
  }

  private async memberForOwner(
    organizationId: string,
    membershipId: string,
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
      where: { organizationId, role: MembershipRole.MSP_OWNER, status: MembershipStatus.ACTIVE },
    })
  }

  private async protectOwner(
    actor: OwnerContext,
    member: MemberRecord,
    nextRole: MembershipRole,
    nextStatus: MembershipStatus,
  ) {
    const removesOwner =
      member.role === MembershipRole.MSP_OWNER &&
      member.status === MembershipStatus.ACTIVE &&
      (nextRole !== MembershipRole.MSP_OWNER || nextStatus !== MembershipStatus.ACTIVE)
    if (!removesOwner) return
    if (member.userId === actor.userId) {
      throw new BadRequestException('You cannot remove, suspend, or demote your own MSP owner access.')
    }
    if ((await this.ownerCount(actor.organizationId)) <= 1) {
      throw new BadRequestException('Assign another active MSP owner before changing the last owner.')
    }
  }

  private async audit(
    actor: OwnerContext,
    action: string,
    target?: Pick<MemberRecord['user'], 'id' | 'email'>,
    outcome = 'SUCCEEDED',
    metadata?: AuditMetadata,
  ) {
    await this.prisma.workspaceAdminAuditLog.create({
      data: {
        organizationId: actor.organizationId,
        actorUserId: actor.userId,
        actorEmail: actor.email,
        targetUserId: target?.id,
        targetEmail: target?.email,
        action,
        outcome,
        metadata: metadata as Prisma.InputJsonObject | undefined,
      },
    })
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
    const actor = await this.ownerContext(identity, organizationId)
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
      organization: { id: actor.organizationId, name: actor.organizationName },
      canManage: true,
      members: members.map((member) => this.memberView(member)),
    }
  }

  async listAuditLogs(identity: AuthenticatedIdentity, organizationId?: string) {
    const actor = await this.ownerContext(identity, organizationId)
    const items = await this.prisma.workspaceAdminAuditLog.findMany({
      where: { organizationId: actor.organizationId },
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
        'HawkView account administration is not configured. Contact a platform administrator.',
      )
    }
    return { url, serviceRoleKey }
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
      throw new BadRequestException('The requested HawkView account operation could not be completed.')
    }
    return result
  }

  async inviteMember(identity: AuthenticatedIdentity, body: unknown) {
    const candidate = record(body)
    const actor = await this.ownerContext(identity, optionalOrganizationId(body))
    const email = stringValue(candidate, 'email').toLowerCase()
    const displayName = stringValue(candidate, 'displayName') || null
    const role = stringValue(candidate, 'role') as MembershipRole
    if (!/^\S+@\S+\.\S+$/.test(email)) throw new BadRequestException('Enter a valid email address.')
    if (!ROLE_VALUES.has(role)) throw new BadRequestException('Select a valid workspace role.')

    let user = await this.prisma.user.findUnique({ where: { email } })
    let delivery: 'INVITE' | 'SETUP_LINK' = 'INVITE'
    try {
      if (!user || !user.authProviderUserId) {
        const invite = await this.supabaseAdminRequest('/auth/v1/invite', {
          method: 'POST',
          body: JSON.stringify({
            email,
            data: displayName ? { display_name: displayName } : undefined,
            redirect_to: process.env.HAWKVIEW_AUTH_REDIRECT_URL?.trim() || undefined,
          }),
        }) as { id?: unknown; user?: { id?: unknown } } | null
        const authProviderUserId = typeof invite?.id === 'string'
          ? invite.id
          : typeof invite?.user?.id === 'string' ? invite.user.id : null
        if (user) {
          user = await this.prisma.user.update({
            where: { id: user.id },
            data: {
              displayName: displayName ?? user.displayName,
              authProviderUserId,
              inviteSentAt: new Date(),
              inviteAcceptedAt: null,
            },
          })
        } else {
          user = await this.prisma.user.create({
            data: { email, displayName, authProviderUserId, inviteSentAt: new Date() },
          })
        }
      } else if (!user.inviteAcceptedAt) {
        // Supabase will not issue a second invite for an existing Auth user.
        // A recovery link lets a pending recipient securely set their password.
        delivery = 'SETUP_LINK'
        await this.supabaseAdminRequest('/auth/v1/recover', {
          method: 'POST',
          body: JSON.stringify({
            email: user.email,
            redirect_to: process.env.HAWKVIEW_AUTH_REDIRECT_URL?.trim() || undefined,
          }),
        })
        user = await this.prisma.user.update({
          where: { id: user.id },
          data: { inviteSentAt: new Date() },
        })
      } else {
        throw new BadRequestException(
          'This member has already completed HawkView account setup. Use password reset instead.',
        )
      }
    } catch (error) {
      await this.audit(actor, 'WORKSPACE_MEMBER_INVITE', user ?? undefined, 'FAILED', { email, role, delivery })
      throw error
    }
    if (!user) throw new ServiceUnavailableException('HawkView invitation could not be created.')
    const membership = await this.prisma.membership.upsert({
      where: { userId_organizationId: { userId: user.id, organizationId: actor.organizationId } },
      create: { userId: user.id, organizationId: actor.organizationId, role, status: MembershipStatus.ACTIVE },
      update: { role, status: MembershipStatus.ACTIVE },
      include: { user: { select: { id: true, email: true, displayName: true, authProviderUserId: true, disabledAt: true, inviteSentAt: true, inviteAcceptedAt: true, createdAt: true } } },
    })
    await this.audit(actor, 'WORKSPACE_MEMBER_INVITED', membership.user, 'SUCCEEDED', { role, delivery })
    return { member: this.memberView(membership), delivery }
  }

  async updateMember(identity: AuthenticatedIdentity, membershipId: string, body: unknown) {
    const candidate = record(body)
    const actor = await this.ownerContext(identity, optionalOrganizationId(body))
    const member = await this.memberForOwner(actor.organizationId, membershipId)
    const roleValue = stringValue(candidate, 'role')
    const statusValue = stringValue(candidate, 'status')
    const role = roleValue ? roleValue as MembershipRole : member.role
    const status = statusValue ? statusValue as MembershipStatus : member.status
    if (!ROLE_VALUES.has(role) || !STATUS_VALUES.has(status)) {
      throw new BadRequestException('Invalid workspace role or status.')
    }
    await this.protectOwner(actor, member, role, status)
    const updated = await this.prisma.membership.update({
      where: { id: member.id }, data: { role, status },
      include: { user: { select: { id: true, email: true, displayName: true, authProviderUserId: true, disabledAt: true, inviteSentAt: true, inviteAcceptedAt: true, createdAt: true } } },
    })
    await this.audit(actor, 'WORKSPACE_MEMBER_UPDATED', updated.user, 'SUCCEEDED', { role, status })
    return { member: this.memberView(updated) }
  }

  async removeMember(identity: AuthenticatedIdentity, membershipId: string, organizationId?: string) {
    const actor = await this.ownerContext(identity, organizationId)
    const member = await this.memberForOwner(actor.organizationId, membershipId)
    await this.protectOwner(actor, member, MembershipRole.MSP_VIEWER, MembershipStatus.SUSPENDED)
    await this.prisma.membership.delete({ where: { id: member.id } })
    await this.audit(actor, 'WORKSPACE_MEMBER_REMOVED', member.user)
    return { removed: true }
  }

  async sendPasswordReset(identity: AuthenticatedIdentity, membershipId: string, body: unknown) {
    const actor = await this.ownerContext(identity, optionalOrganizationId(body))
    const member = await this.memberForOwner(actor.organizationId, membershipId)
    try {
      await this.supabaseAdminRequest('/auth/v1/recover', {
        method: 'POST',
        body: JSON.stringify({ email: member.user.email, redirect_to: process.env.HAWKVIEW_AUTH_REDIRECT_URL?.trim() || undefined }),
      })
      await this.audit(actor, 'HAWKVIEW_PASSWORD_RESET_SENT', member.user)
      return { sent: true }
    } catch (error) {
      await this.audit(actor, 'HAWKVIEW_PASSWORD_RESET_SENT', member.user, 'FAILED')
      throw error
    }
  }

  async resetHawkViewMfa(identity: AuthenticatedIdentity, membershipId: string, body: unknown) {
    const actor = await this.ownerContext(identity, optionalOrganizationId(body))
    const member = await this.memberForOwner(actor.organizationId, membershipId)
    if (!member.user.authProviderUserId) {
      throw new BadRequestException('This invited member has not completed HawkView account setup yet.')
    }
    try {
      const result = await this.supabaseAdminRequest(
        `/auth/v1/admin/users/${encodeURIComponent(member.user.authProviderUserId)}/factors`,
        { method: 'GET' },
      ) as { factors?: Array<{ id?: unknown }> } | Array<{ id?: unknown }> | null
      const factors = Array.isArray(result) ? result : Array.isArray(result?.factors) ? result.factors : []
      for (const factor of factors) {
        if (typeof factor.id === 'string') {
          await this.supabaseAdminRequest(
            `/auth/v1/admin/users/${encodeURIComponent(member.user.authProviderUserId)}/factors/${encodeURIComponent(factor.id)}`,
            { method: 'DELETE' },
          )
        }
      }
      await this.audit(actor, 'HAWKVIEW_MFA_RESET', member.user, 'SUCCEEDED', { factorsRemoved: factors.length })
      return { factorsRemoved: factors.length }
    } catch (error) {
      await this.audit(actor, 'HAWKVIEW_MFA_RESET', member.user, 'FAILED')
      throw error
    }
  }
}
