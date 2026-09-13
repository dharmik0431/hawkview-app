// QA — where the 11 characters go, and what would consume them.
import { incidentGrouping } from './alert-incident-key.js'
const UUID = 'f'.repeat(8) + '-' + 'f'.repeat(4) + '-' + 'f'.repeat(4) + '-' + 'f'.repeat(4) + '-' + 'f'.repeat(12)
const keyFor = (typeIdLen: number, subjectLen: number) => {
  const g = incidentGrouping(
    { id: 'x'.repeat(typeIdLen), subject: 'COLLECTOR' },
    { organizationId: UUID, customerTenantId: UUID },
    { resolved: true, id: 'z'.repeat(subjectLen) })
  return g.groups ? g.key.length : -1
}
const rows: Record<string, unknown>[] = []
for (const len of [36, 46, 47, 48, 50]) rows.push({ alertTypeIdLength: len, incidentKeyLength: keyFor(len, 128), fitsIn300: keyFor(len, 128) <= 300 })
const subjectRows = [128, 138, 139, 140].map((s) => ({ subjectIdLength: s, incidentKeyLength: keyFor(36, s), fitsIn300: keyFor(36, s) <= 300 }))
console.log(JSON.stringify({
  QA_KEY_HEADROOM: {
    todayLongestTypeId: 36,
    byAlertTypeIdLength: rows,
    bySubjectIdLength: subjectRows,
    note: 'subject_id is capped at 128 by identity_risk_findings today; the alert type id is '
      + 'capped by nothing but the catalogue, so it is the one a future change moves',
  },
}, null, 2))
