/** No-database child for the real Nest shutdown hook and shell-exec signal smoke. */
import 'reflect-metadata'
import { Module } from '@nestjs/common'
import { createHawkviewApp } from '../bootstrap.js'
import { PrismaService } from '../prisma/prisma.service.js'
import { syncDrainRegistry } from './sync-drain-registry.js'

// A provider accidentally constructed instead of the fake must fail before a socket.
delete process.env.DATABASE_URL
delete process.env.HAWKVIEW_RUN_DATABASE_INTEGRATION_TESTS
const fake = Object.create(PrismaService.prototype) as PrismaService
Object.defineProperty(fake, '$connect', { value: async () => undefined })
Object.defineProperty(fake, '$disconnect', { value: async () => {
  process.stdout.write('FAKE_PRISMA_DISCONNECTED\n')
} })

class ChildModule {}
Module({ providers: [{ provide: PrismaService, useValue: fake }] })(ChildModule)

const app = await createHawkviewApp(ChildModule)
await app.init()
let release!: () => void
const held = new Promise<void>(resolve => { release = resolve })
const active = syncDrainRegistry.run(async () => {
  await held
  process.stdout.write('TRACKED_WORK_SETTLED\n')
})
process.stdin.once('data', () => { release() })
void active.catch(error => { console.error(error); process.exitCode = 1 })
process.stdout.write(`READY:${process.pid}\n`)
