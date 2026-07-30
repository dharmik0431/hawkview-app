import 'dotenv/config'
import { PrismaPg } from '@prisma/adapter-pg'
import {
  MembershipRole,
  MembershipStatus,
  OrganizationStatus,
  PlatformRole,
  PrismaClient,
} from '../src/generated/prisma/client'

const connectionString = process.env.DATABASE_URL

if (!connectionString) {
  throw new Error('DATABASE_URL is required to seed the database.')
}

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString }),
})

const DEVELOPMENT_OWNER = {
  email: 'dharmik0417@outlook.com',
  displayName: 'Dharmik',
  organizationName: 'SSH TECH',
  organizationSlug: 'ssh-tech',
} as const

async function main() {
  const result = await prisma.$transaction(async (transaction) => {
    const user = await transaction.user.upsert({
      where: { email: DEVELOPMENT_OWNER.email },
      update: {
        displayName: DEVELOPMENT_OWNER.displayName,
        platformRole: PlatformRole.PLATFORM_ADMIN,
        disabledAt: null,
      },
      create: {
        email: DEVELOPMENT_OWNER.email,
        displayName: DEVELOPMENT_OWNER.displayName,
        platformRole: PlatformRole.PLATFORM_ADMIN,
      },
    })

    const organization = await transaction.organization.upsert({
      where: { slug: DEVELOPMENT_OWNER.organizationSlug },
      update: {
        name: DEVELOPMENT_OWNER.organizationName,
        status: OrganizationStatus.ACTIVE,
      },
      create: {
        name: DEVELOPMENT_OWNER.organizationName,
        slug: DEVELOPMENT_OWNER.organizationSlug,
        status: OrganizationStatus.ACTIVE,
      },
    })

    const membership = await transaction.membership.upsert({
      where: {
        userId_organizationId: {
          userId: user.id,
          organizationId: organization.id,
        },
      },
      update: {
        role: MembershipRole.MSP_OWNER,
        status: MembershipStatus.ACTIVE,
      },
      create: {
        userId: user.id,
        organizationId: organization.id,
        role: MembershipRole.MSP_OWNER,
        status: MembershipStatus.ACTIVE,
      },
    })

    return { user, organization, membership }
  })

  console.log('Development seed completed.')
  console.table({
    user: {
      id: result.user.id,
      email: result.user.email,
      role: result.user.platformRole,
    },
    organization: {
      id: result.organization.id,
      name: result.organization.name,
      role: result.membership.role,
    },
  })
}

main()
  .catch((error) => {
    console.error('Development seed failed.', error)
    process.exitCode = 1
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
