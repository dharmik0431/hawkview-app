// QA — the PRODUCTION commit uses prisma.$transaction, not the explicit BEGIN/COMMIT I tested
// earlier. Does a failure on the SECOND table roll back the first? A constraint that only the
// job insert can violate puts the failure exactly between them.
import { PrismaPg } from '@prisma/adapter-pg'
import { PrismaClient } from '../generated/prisma/client.js'
import { AlertIntakeService } from './alert-intake.service.js'
const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL!, max: 5 }) })
const service = new AlertIntakeService(prisma as never)
const n = async (t: string) => Number((await prisma.$queryRawUnsafe<{ n: bigint }[]>(`SELECT count(*)::int AS n FROM ${t}`))[0]!.n)
process.env.HAWKVIEW_ALERT_WATERMARK_ISO = '2026-09-01T00:00:00.000Z'
const report = await service.runOnce(Date.now() + 30_000, new Date())
console.log(JSON.stringify({ QA_REAL_STORE_ATOMIC: {
  reportWasNull: report === null,
  incidentsLeftBehind: await n('alert_incidents'),
  jobsWritten: await n('alert_send_jobs'),
  verdict: (await n('alert_incidents')) === 0
    ? 'ATOMIC — the job insert failed and the incident did NOT survive, so $transaction spans both tables'
    : 'NOT ATOMIC — an incident survived a failed job insert, which is the stranding defect returning',
  note: 'runOnce never throws into the cascade, so the failure surfaces as a null report and a '
    + 'logged error rather than an exception - which is correct, and is why the database is the '
    + 'thing to check rather than the return value.',
} }, null, 2))
await prisma.$disconnect()
