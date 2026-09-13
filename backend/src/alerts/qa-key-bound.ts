// QA — CAN the derivation exceed the column, not DID it. Computed from the real catalogue and
// the real database column widths, at the worst case each allows.
import { ALERT_CATALOG } from './alert-catalog.js'
import { incidentGrouping } from './alert-incident-key.js'

const UUID = 'f'.repeat(8) + '-' + 'f'.repeat(4) + '-' + 'f'.repeat(4) + '-' + 'f'.repeat(4) + '-' + 'f'.repeat(12)
const SUBJECT_MAX = 128   // identity_risk_findings.subject_id, from information_schema
const INCIDENT_COL = 300  // alert_incidents.incident_key
const MESSAGE_COL = 400   // alert_send_jobs.message_id

let worst = { key: '', len: 0, type: '', role: '' }
for (const type of ALERT_CATALOG) {
  for (const role of ['ACTOR', 'TARGET', 'ACCOUNT', 'TENANT', 'COLLECTOR'] as const) {
    const grouping = incidentGrouping(
      { id: type.id, subject: role },
      { organizationId: UUID, customerTenantId: UUID },
      { resolved: true, id: 'z'.repeat(SUBJECT_MAX) })
    if (!grouping.groups) continue
    if (grouping.key.length > worst.len) worst = { key: grouping.key, len: grouping.key.length, type: type.id, role }
  }
}

// messageId = `incident/${organizationId}|${incidentKey}`
const worstMessage = `incident/${UUID}|${worst.key}`
// and the ungrouped branch: `ungrouped:${finding.id}` where id is a uuid
const ungrouped = `incident/${UUID}|ungrouped:${UUID}`

console.log(JSON.stringify({
  QA_KEY_BOUND: {
    longestAlertTypeId: ALERT_CATALOG.reduce((a, t) => (t.id.length > a.length ? t.id : a), ''),
    worstCase: { alertTypeId: worst.type, subjectRole: worst.role, incidentKeyLength: worst.len },
    incidentColumn: INCIDENT_COL,
    incidentKeyFits: worst.len <= INCIDENT_COL,
    incidentHeadroom: INCIDENT_COL - worst.len,
    worstMessageIdLength: worstMessage.length,
    messageColumn: MESSAGE_COL,
    messageIdFits: worstMessage.length <= MESSAGE_COL,
    messageHeadroom: MESSAGE_COL - worstMessage.length,
    ungroupedBranchLength: ungrouped.length,
    verdict: worst.len <= INCIDENT_COL && worstMessage.length <= MESSAGE_COL
      ? 'CANNOT EXCEED - at the worst case every bound allows'
      : 'CAN EXCEED',
  },
}, null, 2))
