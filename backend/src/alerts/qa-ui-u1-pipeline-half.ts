// QA — U1's PIPELINE HALF, bound today so that when the UI lands only the UI-to-row half is new.
// The property is end to end and cannot be closed from one side; this closes the side that
// exists. If the pipeline did NOT read the disposition table, no UI could ever connect to it.
import { PrismaPg } from '@prisma/adapter-pg'
import { PrismaClient } from '../generated/prisma/client.js'
import { AlertIntakeService } from './alert-intake.service.js'

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL!, max: 5 }) })
const service = new AlertIntakeService(prisma as never)
process.env.HAWKVIEW_ALERT_WATERMARK_ISO = '2026-09-01T00:00:00.000Z'
const ORG = '11111111-1111-1111-1111-111111111111'
const OTHER = '99999999-9999-9999-9999-999999999999'
const n = async (t: string) => Number((await prisma.$queryRawUnsafe<{ n: number }[]>(`SELECT count(*)::int AS n FROM ${t}`))[0]!.n)
const reset = async () => { await prisma.$executeRawUnsafe('DELETE FROM alert_send_jobs'); await prisma.$executeRawUnsafe('DELETE FROM alert_incidents') }

// (a) NO ROW AT ALL — the catalogue's judgement applies and a job is written.
await prisma.$executeRawUnsafe('DELETE FROM alert_rule_dispositions')
await reset()
const withDefault = await service.runOnce(Date.now() + 30_000, new Date())

// (b) A ROW SAYING RECORD_ONLY — written the way a settings surface would write it.
await reset()
await prisma.$executeRawUnsafe(
  `INSERT INTO alert_rule_dispositions (id, organization_id, rule_id, disposition, updated_at)
   VALUES (gen_random_uuid(), $1::uuid, $2, 'RECORD_ONLY', now())`,
  ORG, 'security.suspected_credential_attack')
const withOverride = await service.runOnce(Date.now() + 30_000, new Date())

// (c) U8 — THE SAME ROW FOR A DIFFERENT ORGANISATION MUST NOT SILENCE THIS ONE.
await reset()
await prisma.$executeRawUnsafe('DELETE FROM alert_rule_dispositions')
await prisma.$executeRawUnsafe(
  `INSERT INTO alert_rule_dispositions (id, organization_id, rule_id, disposition, updated_at)
   VALUES (gen_random_uuid(), $1::uuid, $2, 'RECORD_ONLY', now())`,
  OTHER, 'security.suspected_credential_attack')
const otherOrgsOverride = await service.runOnce(Date.now() + 30_000, new Date())

console.log(JSON.stringify({
  QA_U1_PIPELINE_HALF: {
    a_noRow: { jobs: withDefault?.jobsWritten, skipped: (withDefault?.skipped ?? []).map((s) => s.because) },
    b_recordOnlyRow: { jobs: withOverride?.jobsWritten, skipped: (withOverride?.skipped ?? []).map((s) => s.because) },
    c_anotherOrgsRow: { jobs: otherOrgsOverride?.jobsWritten, skipped: (otherOrgsOverride?.skipped ?? []).map((s) => s.because) },
    U1_pipelineHalf: withDefault?.jobsWritten === 1 && withOverride?.jobsWritten === 0
      && (withOverride?.skipped ?? []).some((s) => s.because === 'RECORD_ONLY')
      ? 'BOUND — a disposition row changes the decision, and the reason is named RECORD_ONLY'
      : 'FAILED — the pipeline does not read the table a settings surface would write to',
    U8_scopedToItsOrganisation: otherOrgsOverride?.jobsWritten === 1
      ? 'BOUND — another organisation choosing RECORD_ONLY does not silence this one'
      : 'FAILED — one MSP can silence another',
    stillUnproven: 'that the UI writes to THIS table, with THIS rule_id spelling, scoped to THIS '
      + 'organisation. That is the half that does not exist yet, and it is where the seam breaks '
      + 'if it breaks — a correct endpoint and a correct pipeline can still disagree about the key.',
  },
}, null, 2))
await prisma.$disconnect()
