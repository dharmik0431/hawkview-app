import {
  Injectable,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common'
import { PrismaPg } from '@prisma/adapter-pg'
import { PrismaClient } from '../generated/prisma/client.js'
import { initializePrismaUtcSession } from './prisma-utc-session.js'

export function createAdapter(connectionString = process.env.DATABASE_URL) {
  if (!connectionString) {
    throw new Error('DATABASE_URL is required to start the HawkView API.')
  }

  // Supavisor allows 15 session clients for this database role. Render briefly
  // overlaps API processes during deployment; leave room for migrations and
  // other pooler clients instead of using pg's ten-client default per process.
  return new PrismaPg({
    connectionString,
    max: 3,
    onConnect: initializePrismaUtcSession,
  })
}

@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  constructor() {
    super({ adapter: createAdapter() })
  }

  async onModuleInit() {
    await this.$connect()
  }

  async onModuleDestroy() {
    await this.$disconnect()
  }
}
