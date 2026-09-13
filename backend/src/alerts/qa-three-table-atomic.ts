// QA — the transaction now spans THREE tables and my atomicity evidence covered two. Registered
// as needing re-establishment rather than carry-over; this is that. A CHECK only the NOTIFICATION
// insert can violate places the failure between the incident and the notification.
import { PrismaPg } from '@prisma/adapter-pg'
import { PrismaClient } from '../generated/prisma/client.js'
import { AlertIntakeService } from './alert-intake.service.js'
const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL!, max: 5 }) })
const service = new AlertIntakeService(prisma as never)
process.env.HAWKVIEW_ALERT_WATERMARK_ISO = '2026-09-01T00:00:00.000Z'
const n = async (t: string) => Number((await prisma.$queryRawUnsafe<{ n: number }[]>(`SELECT count(*)::int AS n FROM ${t}`))[0]!.n)
const report = await service.runOnce(Date.now() + 30_000, new Date())
console.log(JSON.stringify({ QA_THREE_TABLE_ATOMIC: {
  reportWasNull: report === null,
  incidents: await n('alert_incidents'), jobs: await n('alert_send_jobs'), notifications: await n('notifications'),
  verdict: (await n('alert_incidents')) === 0 && (await n('alert_send_jobs')) === 0 && (await n('notifications')) === 0
    ? 'ATOMIC ACROSS THREE — the notification insert failed and neither the incident nor the job survived'
    : 'NOT ATOMIC — the stranding defect has moved one table along',
} }, null, 2))
await prisma.$disconnect()
