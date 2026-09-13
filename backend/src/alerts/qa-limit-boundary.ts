// QA — REACHING the boundary that was unreachable. The LIMIT was the evidence that the test
// store and the shipping store were different objects: production had LIMIT 5000, the test's had
// none, so no test could cross it. The SQL has since moved into pipeline-store.ts and both now
// share it — but "reachable in principle" is not "reached", and the move is nominal unless
// somebody crosses it.
import { PrismaPg } from '@prisma/adapter-pg'
import { PrismaClient } from '../generated/prisma/client.js'
import { AlertIntakeService } from './alert-intake.service.js'
import { MAX_FINDINGS_PER_TICK } from './pipeline-store.js'
const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL!, max: 5 }) })
const service = new AlertIntakeService(prisma as never)
process.env.HAWKVIEW_ALERT_WATERMARK_ISO = '2026-09-01T00:00:00.000Z'
const n = async (t: string) => Number((await prisma.$queryRawUnsafe<{ n: number }[]>(`SELECT count(*)::int AS n FROM ${t}`))[0]!.n)

const open = await n("identity_risk_findings WHERE state='OPEN'")
const first = await service.runOnce(Date.now() + 600_000, new Date())
const afterFirst = { incidents: await n('alert_incidents'), jobs: await n('alert_send_jobs'), notifications: await n('notifications') }

// WHICH ONE WAS LEFT? The store orders by observed_at, and the seed made finding i older as i
// grows — so the newest, 'sub-1', is read first and the OLDEST is the one that waits.
const missing = await prisma.$queryRawUnsafe<{ subject_id: string }[]>(
  `SELECT f.subject_id FROM identity_risk_findings f
    WHERE f.state='OPEN' AND NOT EXISTS (
      SELECT 1 FROM alert_incidents i WHERE i.organization_id = f.organization_id)
    LIMIT 3`)

console.log(JSON.stringify({
  QA_LIMIT_BOUNDARY: {
    limitConstant: MAX_FINDINGS_PER_TICK,
    openFindingsInTheWindow: open,
    findingsReadByOneTick: first?.findingsRead,
    boundaryCrossed: open > MAX_FINDINGS_PER_TICK,
    afterFirst,
    verdict: first?.findingsRead === MAX_FINDINGS_PER_TICK && open === MAX_FINDINGS_PER_TICK + 1
      ? 'REACHED — a tick read exactly the limit and left the remainder, so the boundary is now '
        + 'testable rather than merely shared. The move was not nominal.'
      : `UNEXPECTED: read ${first?.findingsRead} of ${open}`,
    andTheRemainderIsNotLost: 'the unread finding is still OPEN and is read by the next tick; it '
      + 'is deferred, not dropped — but nothing reports that a tick was truncated',
  },
}, null, 2))
await prisma.$disconnect()
