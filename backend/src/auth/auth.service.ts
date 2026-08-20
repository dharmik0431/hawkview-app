import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
} from '@nestjs/common'
import { MembershipRole, MembershipStatus } from '../generated/prisma/enums.js'
import type { Prisma } from '../generated/prisma/client.js'
import { PrismaService } from '../prisma/prisma.service.js'
import type { AuthenticatedIdentity } from './auth.types.js'

const userWithMemberships = {
  id: true,
  email: true,
  displayName: true,
  timeZone: true,
  dateFormat: true,
  timeFormat: true,
  platformRole: true,
  disabledAt: true,
  memberships: {
    where: { status: 'ACTIVE' as const },
    select: {
      id: true,
      role: true,
      status: true,
      organization: {
        select: {
          id: true,
          name: true,
          slug: true,
          status: true,
        },
      },
    },
  },
} as const

type BootstrapUser = {
  id: string
  email: string
  displayName: string | null
  disabledAt: Date | null
}

type IdentityLookupUser = BootstrapUser & {
  authProviderUserId: string | null
  inviteSentAt: Date | null
  inviteAcceptedAt: Date | null
  memberships: Array<{ id: string }>
}

const identityLookupSelect = {
  id: true,
  email: true,
  displayName: true,
  authProviderUserId: true,
  inviteSentAt: true,
  inviteAcceptedAt: true,
  disabledAt: true,
  memberships: {
    where: {
      status: 'ACTIVE' as const,
      organization: { status: 'ACTIVE' as const },
    },
    select: { id: true },
  },
} as const

function isPendingInvitation(user: IdentityLookupUser) {
  return (
    user.disabledAt === null &&
    user.authProviderUserId === null &&
    user.inviteSentAt !== null &&
    user.inviteAcceptedAt === null &&
    user.memberships.length > 0
  )
}

function workspaceName(identity: AuthenticatedIdentity, user: BootstrapUser) {
  const fallback = user.email.split('@')[0] || 'HawkView'
  const ownerName = (user.displayName || identity.displayName || fallback).trim()
  return `${ownerName.slice(0, 180)}'s MSP Workspace`
}

function workspaceSlug(identity: AuthenticatedIdentity, user: BootstrapUser) {
  const fallback = user.email.split('@')[0] || 'hawkview'
  const base = (user.displayName || identity.displayName || fallback)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'hawkview'
  const subjectSuffix = identity.subject.replace(/[^a-z0-9]/gi, '').slice(-10).toLowerCase()
  return `${base.slice(0, 80)}-msp-${subjectSuffix || user.id.slice(-10)}`
}

@Injectable()
export class AuthService {
  constructor(
    @Inject(PrismaService)
    private readonly prisma: PrismaService,
  ) {}

  /**
   * A direct HawkView sign-up has no membership yet. Create its isolated
   * workspace and owner membership exactly once. Invited accounts already
   * have a membership before accepting the invite, so they are never moved
   * into a newly-created workspace.
   */
  private async ensureFirstWorkspace(
    transaction: Prisma.TransactionClient,
    identity: AuthenticatedIdentity,
    user: BootstrapUser,
  ) {
    if (user.disabledAt) return

    const membership = await transaction.membership.findFirst({
      where: { userId: user.id },
      select: { id: true },
    })
    if (membership) return

    const organization = await transaction.organization.create({
      data: {
        name: workspaceName(identity, user),
        slug: workspaceSlug(identity, user),
      },
      select: { id: true },
    })
    await transaction.membership.create({
      data: {
        userId: user.id,
        organizationId: organization.id,
        role: MembershipRole.MSP_OWNER,
        status: MembershipStatus.ACTIVE,
      },
    })
  }

  async bootstrap(identity: AuthenticatedIdentity) {
    const normalizedEmail = identity.email.trim().toLowerCase()

    const user = await this.prisma.$transaction(async (transaction) => {
      const [existingBySubject, existingByEmail] = await Promise.all([
        transaction.user.findUnique({
          where: { authProviderUserId: identity.subject },
          select: identityLookupSelect,
        }),
        transaction.user.findFirst({
          where: {
            email: {
              equals: normalizedEmail,
              mode: 'insensitive',
            },
          },
          select: identityLookupSelect,
        }),
      ])

      if (existingBySubject?.disabledAt) {
        throw new ForbiddenException('This HawkView account is disabled.')
      }

      let profile: BootstrapUser

      if (existingBySubject) {
        if (existingByEmail && existingByEmail.id !== existingBySubject.id) {
          throw new ForbiddenException(
            'This identity conflicts with another HawkView account.',
          )
        }

        profile = await transaction.user.update({
          where: { id: existingBySubject.id },
          data: {
            email: normalizedEmail,
            displayName:
              existingBySubject.displayName ?? identity.displayName,
            inviteAcceptedAt: existingBySubject.inviteAcceptedAt ?? new Date(),
          },
          select: { id: true, email: true, displayName: true, disabledAt: true },
        })
      } else if (existingByEmail) {
        // Email equality alone is not an identity-linking authority. The only
        // supported email-based claim is an explicit, still-pending workspace
        // invitation whose provider subject was not recorded when it was sent.
        // Accepted accounts and legacy profiles must use their original
        // provider identity or an audited administrative recovery flow.
        if (!isPendingInvitation(existingByEmail)) {
          throw new ForbiddenException(
            'This email is already associated with another HawkView identity. Sign in with the original account or contact support.',
          )
        }
        profile = await transaction.user.update({
          where: { id: existingByEmail.id },
          data: {
            authProviderUserId: identity.subject,
            email: normalizedEmail,
            displayName:
              existingByEmail.displayName ?? identity.displayName,
            inviteAcceptedAt: existingByEmail.inviteAcceptedAt ?? new Date(),
          },
          select: { id: true, email: true, displayName: true, disabledAt: true },
        })
      } else {
        profile = await transaction.user.create({
          data: {
            authProviderUserId: identity.subject,
            email: normalizedEmail,
            displayName: identity.displayName,
            inviteAcceptedAt: new Date(),
          },
          select: { id: true, email: true, displayName: true, disabledAt: true },
        })
      }

      await this.ensureFirstWorkspace(transaction, identity, profile)
      return transaction.user.findUniqueOrThrow({
        where: { id: profile.id },
        select: userWithMemberships,
      })
    })

    if (user.disabledAt) {
      throw new ForbiddenException('This HawkView account is disabled.')
    }

    const { disabledAt: _disabledAt, ...safeUser } = user

    return {
      user: safeUser,
      signInProvider: identity.signInProvider,
    }
  }

  async updateProfile(identity: AuthenticatedIdentity, body: unknown) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      throw new BadRequestException('Profile settings are required.')
    }

    const payload = body as Record<string, unknown>
    const displayName =
      typeof payload.displayName === 'string' ? payload.displayName.trim() : ''
    const timeZone =
      typeof payload.timeZone === 'string' ? payload.timeZone.trim() : ''
    const dateFormat =
      typeof payload.dateFormat === 'string' ? payload.dateFormat.trim() : ''
    const timeFormat =
      typeof payload.timeFormat === 'string' ? payload.timeFormat.trim() : ''

    if (!displayName || displayName.length > 200) {
      throw new BadRequestException('Enter a valid display name.')
    }
    if (!timeZone || timeZone.length > 100) {
      throw new BadRequestException('Enter a valid time zone.')
    }
    if (!['MM/DD/YYYY', 'DD/MM/YYYY', 'YYYY-MM-DD'].includes(dateFormat)) {
      throw new BadRequestException('Select a supported date format.')
    }
    if (!['12h', '24h'].includes(timeFormat)) {
      throw new BadRequestException('Select a supported time format.')
    }

    const user = await this.prisma.user.update({
      where: { authProviderUserId: identity.subject },
      data: { displayName, timeZone, dateFormat, timeFormat },
      select: userWithMemberships,
    })

    const { disabledAt: _disabledAt, ...safeUser } = user
    return { user: safeUser, signInProvider: identity.signInProvider }
  }
}
