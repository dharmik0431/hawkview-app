import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
} from '@nestjs/common'
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

@Injectable()
export class AuthService {
  constructor(
    @Inject(PrismaService)
    private readonly prisma: PrismaService,
  ) {}

  async bootstrap(identity: AuthenticatedIdentity) {
    const user = await this.prisma.$transaction(async (transaction) => {
      const existingBySubject = await transaction.user.findUnique({
        where: { identityPlatformUserId: identity.subject },
      })

      if (existingBySubject) {
        return transaction.user.update({
          where: { id: existingBySubject.id },
          data: {
            displayName:
              existingBySubject.displayName ?? identity.displayName,
          },
          select: userWithMemberships,
        })
      }

      const existingByEmail = await transaction.user.findUnique({
        where: { email: identity.email },
      })

      if (
        existingByEmail?.identityPlatformUserId &&
        existingByEmail.identityPlatformUserId !== identity.subject
      ) {
        throw new ConflictException(
          'This email is already linked to another identity.',
        )
      }

      if (existingByEmail) {
        return transaction.user.update({
          where: { id: existingByEmail.id },
          data: {
            identityPlatformUserId: identity.subject,
            displayName:
              existingByEmail.displayName ?? identity.displayName,
          },
          select: userWithMemberships,
        })
      }

      return transaction.user.create({
        data: {
          identityPlatformUserId: identity.subject,
          email: identity.email,
          displayName: identity.displayName,
        },
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
      where: { identityPlatformUserId: identity.subject },
      data: { displayName, timeZone, dateFormat, timeFormat },
      select: userWithMemberships,
    })

    const { disabledAt: _disabledAt, ...safeUser } = user
    return { user: safeUser, signInProvider: identity.signInProvider }
  }
}
