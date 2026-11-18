import {
  Injectable,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common'
import { PrismaPg } from '@prisma/adapter-pg'
import { PrismaClient } from '../generated/prisma/client.js'
import { initializePrismaUtcSession } from './prisma-utc-session.js'
import { randomUUID } from 'node:crypto'
import { syncDrainRegistry } from '../tenants/sync-drain-registry.js'

const bootId = randomUUID()
const revision = /^[0-9a-f]{40}$/i.test(process.env.RENDER_GIT_COMMIT ?? '')
  ? process.env.RENDER_GIT_COMMIT!.toLowerCase() : null

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
    console.info(JSON.stringify({ event: 'sync_instance_started', bootId, revision, pid: process.pid }))
  }

  async onModuleDestroy() {
    // Nest invokes onModuleDestroy before beforeApplicationShutdown. Keep the
    // shared pool connected until every tracked SYNC operation has settled.
    const drained = syncDrainRegistry.closeAdmissionsAndDrain()
    console.info(JSON.stringify({ event: 'sync_shutdown_drain_started', bootId, revision,
      pid: process.pid, ...syncDrainRegistry.snapshot() }))
    await drained
    await this.$disconnect()
    console.info(JSON.stringify({ event: 'sync_shutdown_drain_completed', bootId, revision,
      pid: process.pid, ...syncDrainRegistry.snapshot(), sharedPrismaDisconnected: true }))
  }
}
