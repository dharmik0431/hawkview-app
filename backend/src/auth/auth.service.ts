import {
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
              identity.displayName ?? existingBySubject.displayName,
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
              identity.displayName ?? existingByEmail.displayName,
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
}
