// QA — THE WAY U1 WILL BREAK, demonstrated before anybody writes the UI.
// The column is called `rule_id`. The pipeline looks it up by ALERT TYPE ID. A settings surface
// author reading the column name would reasonably store the risk rule id — and both halves would
// look correct while the toggle did nothing.
import { PrismaPg } from '@prisma/adapter-pg'
import { PrismaClient } from '../generated/prisma/client.js'
import { AlertIntakeService } from './alert-intake.service.js'
const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL!, max: 5 }) })
const service = new AlertIntakeService(prisma as never)
process.env.HAWKVIEW_ALERT_WATERMARK_ISO = '2026-09-01T00:00:00.000Z'
const ORG = '11111111-1111-1111-1111-111111111111'
const reset = async () => {
  await prisma.$executeRawUnsafe('DELETE FROM alert_send_jobs')
  await prisma.$executeRawUnsafe('DELETE FROM alert_incidents')
  await prisma.$executeRawUnsafe('DELETE FROM alert_rule_dispositions')
}
const put = (key: string) => prisma.$executeRawUnsafe(
  `INSERT INTO alert_rule_dispositions (id, organization_id, rule_id, disposition, updated_at)
   VALUES (gen_random_uuid(), $1::uuid, $2, 'RECORD_ONLY', now())`, ORG, key)

await reset(); await put('HV-ID-AUTH-010.v1')          // the RISK RULE id — what the column name suggests
const byRuleId = await service.runOnce(Date.now() + 30_000, new Date())
await reset(); await put('security.suspected_credential_attack')   // the ALERT TYPE id — what is read
const byAlertType = await service.runOnce(Date.now() + 30_000, new Date())

console.log(JSON.stringify({
  QA_UI_KEY_TRAP: {
    storedAsRiskRuleId: { jobsStillSent: byRuleId?.jobsWritten, silenced: byRuleId?.jobsWritten === 0 },
    storedAsAlertTypeId: { jobsStillSent: byAlertType?.jobsWritten, silenced: byAlertType?.jobsWritten === 0 },
    verdict: byRuleId?.jobsWritten === 1 && byAlertType?.jobsWritten === 0
      ? 'THE TRAP IS REAL — a disposition stored under the risk rule id is silently ignored, and '
        + 'the email goes anyway. The row exists, the endpoint succeeded, the MSP sees their choice '
        + 'saved, and nothing changes.'
      : 'not reproduced',
    forTheImplementer: 'alert_rule_dispositions.rule_id holds an ALERT TYPE id '
      + '(security.suspected_credential_attack), not a risk rule id (HV-ID-AUTH-010.v1). The '
      + 'column name says otherwise.',
  },
}, null, 2))
await prisma.$disconnect()
