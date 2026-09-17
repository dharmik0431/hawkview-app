import { isIP } from 'node:net'
import type { SqlRunner } from './pipeline-store.js'
import { ALERT_CATALOG } from './alert-catalog.js'
import { joinUnambiguously } from './alert-key-encoding.js'
import { alertTypeForRule } from './finding-pipeline.js'
import { readSourceEventReference, SOURCE_REFERENCE_UUID as UUID } from '../risky-users-wiring/incident-source-reference.js'
import type { SourceEventReference } from '../evaluation-core/contract.js'
import { classifyAuditRecord, classifyGraphRecord } from '../risky-users-normalization/normalize.js'

export const EMAIL_CONTEXT_VERSION = 'hawkview-email-incident/v1' as const
export const EMAIL_CONTEXT_FINDING_LIMIT = 3
export type EmailFact = Readonly<{ label: string; value: string }>
export type EmailIncidentContext = Readonly<{
  version: typeof EMAIL_CONTEXT_VERSION
  facts: readonly EmailFact[]
  findings: readonly Readonly<{ title: string; facts: readonly EmailFact[];
    events: readonly Readonly<{ title: string; facts: readonly EmailFact[] }>[] }>[]
  omittedFindings: number
  note: string
}>
export interface EmailIncidentScope {
  organizationId: string; customerTenantId: string; incidentKey: string
  alertTypeId: string; subjectRole: string; subjectId: string
}

/** Original job identity is the disclosure authority, not a freshly reconstructed digest. */
export function parseEmailIncidentScope(messageId: string): EmailIncidentScope | null {
  if (typeof messageId !== 'string' || messageId.length > 500 || !messageId.startsWith('incident/')) return null
  const separator = messageId.indexOf('|', 9)
  if (separator < 0) return null
  const organizationId = messageId.slice(9, separator)
  const incidentKey = messageId.slice(separator + 1)
  if (!UUID.test(organizationId) || incidentKey.length > 400) return null
  const parts: string[] = []
  let offset = 0
  for (let i = 0; i < 6; i++) {
    const colon = incidentKey.indexOf(':', offset)
    if (colon < offset || colon - offset > 3) return null
    const digits = incidentKey.slice(offset, colon)
    if (!/^(0|[1-9][0-9]{0,2})$/.test(digits)) return null
    const length = Number(digits)
    const end = colon + 1 + length
    if (length < 1 || length > 150 || end > incidentKey.length) return null
    parts.push(incidentKey.slice(colon + 1, end)); offset = end
  }
  if (offset !== incidentKey.length || joinUnambiguously(parts) !== incidentKey
    || parts[0] !== 'hawkview-alert-incident/v1' || parts[2] !== organizationId
    || !UUID.test(parts[3]!) || parts[4] !== 'ACCOUNT'
    || !ALERT_CATALOG.some(type => type.id === parts[1] && type.category === 'SECURITY')
    || parts[5]!.length > 128 || /[\u0000-\u001f\u007f]/.test(parts[5]!)) return null
  return { organizationId, customerTenantId: parts[3]!, incidentKey,
    alertTypeId: parts[1]!, subjectRole: parts[4]!, subjectId: parts[5]! }
}

const unknown = 'Not reported'
const controls = /[\u0000-\u001f\u007f-\u009f\u061c\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/
const secretOrUrl = /(?:https?:\/\/|\bBearer\s|(?:access[_ -]?token|refresh[_ -]?token|id[_ -]?token|client[_ -]?secret|api[_ -]?key|private[_ -]?key|password|passcode|secret|token|credential|authorization|code|sig(?:nature)?)[\s"']*[:=]|\b(?:re_|sk_|sb_secret_)[a-z0-9_-]{16,}|eyJ[a-zA-Z0-9_-]{16,}\.|AKIA[A-Z0-9]{16}|-----BEGIN[^-]*PRIVATE KEY)/i
function suspiciousScalar(value: string): boolean {
  let inspected = value
  for (let layer = 0; layer <= 2; layer++) {
    if (inspected.length > 4096 || controls.test(inspected) || secretOrUrl.test(inspected)
      || /^\s*[\[{]/.test(inspected)) return true
    if (!inspected.includes('%')) return false
    if (layer === 2 || /%(?![0-9a-f]{2})/i.test(inspected)) return true
    try { inspected = decodeURIComponent(inspected) } catch { return true }
  }
  return true
}

/** Bounded display scalar, never a raw object, provider error, link or credential. */
export function emailDisplayValue(value: unknown, limit = 160): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 4096
    || suspiciousScalar(value)) return unknown
  const chars = Array.from(value.trim())
  return chars.length <= limit ? chars.join('') : `${chars.slice(0, limit).join('')} [truncated]`
}
function timestamp(value: unknown): string | null {
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.toISOString() : null
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,7})?Z?$/.test(value)) return null
  const normalized = value.endsWith('Z') ? value : `${value}Z`
  const millis = Date.parse(normalized)
  if (!Number.isFinite(millis)) return null
  const iso = new Date(millis).toISOString()
  return iso.slice(0, 19) === value.slice(0, 19) ? iso : null
}
const utc = (value: unknown): string => {
  const iso = timestamp(value)
  return iso ? `${iso.replace('T', ' ').replace('Z', '')} UTC` : unknown
}
const plain = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object'
  && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype
const userGuid = (subject: string): string | null => subject.startsWith('subject:') && UUID.test(subject.slice(8))
  ? subject.slice(8) : null
const upnValue = (value: unknown): string => typeof value === 'string' && value.length <= 320
  && /^[^\s@<>]{1,255}@[^\s@.<>]+(?:\.[^\s@.<>]+)+$/.test(value) ? emailDisplayValue(value, 320) : unknown
const ip = (value: unknown): string | null => {
  if (typeof value !== 'string' || value.length > 64 || value.trim() !== value || value.includes('%') || !isIP(value)) return null
  return isIP(value) === 6 ? new URL(`http://[${value}]/`).hostname.slice(1, -1).toLowerCase() : value
}

interface ContextRow {
  organization_id: string; customer_tenant_id: string; incident_key: string; alert_type_id: string
  finding_id: string; rule_id: string; subject_id: string; subject_type: string
  observed_at: Date | string; evidence: unknown; total_findings: number | string
  tenant_name: unknown; tenant_domain: unknown
}
interface DirectoryRow { microsoft_user_id: string; display_name: unknown; user_principal_name: unknown }
interface EventRow {
  source: string; source_id: string; event_at: unknown; integrity_disputed: boolean
  user_id: unknown; user_upn: unknown; application_id: unknown; application_name: unknown
  resource_name: unknown; ip_address: unknown; actor_ip: unknown; error_code: unknown
  record_type: unknown; operation: unknown; microsoft_tenant_id: string; record_tenant_id: unknown
  classification_record: unknown
}

/** All selected fields come from one exact source row, never a user/time search. */
async function selectedEvent(
  runner: SqlRunner, scope: EmailIncidentScope, directory: DirectoryRow | undefined,
  reference: SourceEventReference, signal: string,
): Promise<Readonly<{ title: string; facts: readonly EmailFact[] }> | null> {
  if (!directory || reference.organizationId !== scope.organizationId
    || reference.customerTenantId !== scope.customerTenantId || reference.subjectRef !== scope.subjectId
    || directory.microsoft_user_id !== userGuid(scope.subjectId)) return null
  const rows = await runner.query<EventRow>(`SELECT
      CASE WHEN s.raw->>'hawkviewSource' = 'MICROSOFT_365_MANAGEMENT_ACTIVITY' THEN 'M365_AUDIT_STS'
        WHEN NOT (s.raw ? 'hawkviewSource') THEN 'GRAPH_SIGN_INS' ELSE 'UNKNOWN' END AS source,
      CASE WHEN $4 = 'GRAPH_SIGN_INS' THEN s.raw->>'id' ELSE s.raw#>>'{managementActivityRecord,Id}' END AS source_id,
      CASE WHEN $4 = 'GRAPH_SIGN_INS' THEN s.raw->>'createdDateTime' ELSE s.raw#>>'{managementActivityRecord,CreationTime}' END AS event_at,
      s.raw ? 'hawkviewAuthenticationIntegrity' AS integrity_disputed,
      s.raw->>'userId' AS user_id, s.raw#>>'{managementActivityRecord,UserId}' AS user_upn,
      CASE WHEN $4 = 'GRAPH_SIGN_INS' THEN s.raw->>'appId' ELSE s.raw#>>'{managementActivityRecord,ApplicationId}' END AS application_id,
      CASE WHEN $4 = 'GRAPH_SIGN_INS' AND jsonb_typeof(s.raw->'appDisplayName') = 'string' THEN s.raw->>'appDisplayName'
        WHEN $4 = 'M365_AUDIT_STS' AND jsonb_typeof(s.raw#>'{managementActivityRecord,Application}') = 'string'
          THEN s.raw#>>'{managementActivityRecord,Application}' ELSE NULL END AS application_name,
      CASE WHEN $4 = 'GRAPH_SIGN_INS' AND jsonb_typeof(s.raw->'resourceDisplayName') = 'string'
        THEN s.raw->>'resourceDisplayName' ELSE NULL END AS resource_name,
      CASE WHEN $4 = 'GRAPH_SIGN_INS' THEN s.raw->>'ipAddress' ELSE s.raw#>>'{managementActivityRecord,ClientIP}' END AS ip_address,
      CASE WHEN $4 = 'GRAPH_SIGN_INS' THEN NULL ELSE s.raw#>>'{managementActivityRecord,ActorIpAddress}' END AS actor_ip,
      CASE WHEN $4 = 'GRAPH_SIGN_INS' THEN s.raw#>>'{status,errorCode}' ELSE NULL END AS error_code,
      s.raw#>>'{managementActivityRecord,RecordType}' AS record_type,
      s.raw#>>'{managementActivityRecord,Operation}' AS operation,
      t.microsoft_tenant_id, s.raw#>>'{managementActivityRecord,OrganizationId}' AS record_tenant_id,
      CASE WHEN $4 = 'GRAPH_SIGN_INS' THEN jsonb_build_object('status', jsonb_build_object(
        'errorCode', s.raw#>'{status,errorCode}', 'failureReason', s.raw#>'{status,failureReason}'))
      ELSE COALESCE((SELECT jsonb_object_agg(field.key, field.value)
        FROM jsonb_each(CASE WHEN jsonb_typeof(s.raw->'managementActivityRecord') = 'object'
          THEN s.raw->'managementActivityRecord' ELSE '{}'::jsonb END) field
        WHERE field.key IN ('Operation', 'LoginStatus', 'ErrorCode', 'LoginError', 'LogonError')), '{}'::jsonb)
        || jsonb_build_object('ExtendedProperties', COALESCE((SELECT jsonb_agg(p.item ORDER BY p.ordinal)
          FROM jsonb_array_elements(CASE WHEN jsonb_typeof(s.raw#>'{managementActivityRecord,ExtendedProperties}') = 'array'
            THEN s.raw#>'{managementActivityRecord,ExtendedProperties}' ELSE '[]'::jsonb END)
            WITH ORDINALITY p(item, ordinal)
          WHERE p.ordinal <= 100 AND lower(btrim(p.item->>'Name'))
            IN ('loginstatus', 'errorcode', 'errornumber', 'loginerror', 'logonerror')), '[]'::jsonb))
      END AS classification_record
    FROM sign_in_logs s JOIN customer_tenants t ON t.id = s.customer_tenant_id AND t.organization_id = s.organization_id
    WHERE s.organization_id = $1::uuid AND s.customer_tenant_id = $2::uuid
      AND s.microsoft_sign_in_id = $3 LIMIT 2`,
  [scope.organizationId, scope.customerTenantId,
    reference.source === 'GRAPH_SIGN_INS' ? reference.eventId : `management:${reference.eventId}`, reference.source])
  if (rows.length !== 1) return null
  const row = rows[0]!
  if (row.source !== reference.source || row.source_id !== reference.eventId || row.integrity_disputed !== false
    || timestamp(row.event_at) !== reference.eventAt) return null
  if (!plain(row.classification_record)) return null
  const classified = reference.source === 'GRAPH_SIGN_INS'
    ? classifyGraphRecord(row.classification_record) : classifyAuditRecord(row.classification_record)
  if (classified.classification.kind !== 'APPLIES' || classified.classification.outcome !== signal) return null
  if (reference.source === 'GRAPH_SIGN_INS') {
    if (typeof row.user_id !== 'string' || row.user_id.toLowerCase() !== directory.microsoft_user_id
      || typeof row.event_at !== 'string' || !row.event_at.endsWith('Z')) return null
  } else {
    if (typeof row.user_upn !== 'string' || typeof directory.user_principal_name !== 'string'
      || upnValue(row.user_upn.trim()) === unknown || upnValue(directory.user_principal_name.trim()) === unknown
      || row.user_upn.trim().toLowerCase() !== directory.user_principal_name.trim().toLowerCase()
      || row.record_type !== '15' || !['UserLoggedIn', 'UserLoginFailed'].includes(String(row.operation))
      || (row.record_tenant_id !== null && row.record_tenant_id !== row.microsoft_tenant_id)) return null
  }
  const reportedIps = [row.ip_address, row.actor_ip].filter(value => value !== null && value !== undefined && value !== '')
  const qualifiedIps = reportedIps.map(ip)
  const address = qualifiedIps.length > 0 && qualifiedIps.every(value => value !== null)
    && new Set(qualifiedIps).size === 1 ? qualifiedIps[0]! : unknown
  const appId = typeof row.application_id === 'string' && /^[0-9a-f-]{36}$/i.test(row.application_id)
    && UUID.test(row.application_id.toLowerCase()) ? row.application_id : unknown
  return {
    title: signal === 'PASSWORD_REJECTED' ? 'Latest qualifying password-rejection event' : 'Latest qualifying lockout event',
    facts: [
      { label: 'Event time', value: utc(reference.eventAt) },
      { label: 'Source', value: reference.source === 'GRAPH_SIGN_INS' ? 'Microsoft Graph sign-in record' : 'Microsoft 365 audit STS record' },
      { label: 'Application', value: emailDisplayValue(row.application_name) },
      { label: 'Application ID', value: appId },
      { label: 'Resource', value: emailDisplayValue(row.resource_name) },
      { label: 'Source IP', value: address },
      { label: 'Actor', value: 'Not reported separately from the sign-in subject' },
      ...(reference.source === 'GRAPH_SIGN_INS' && typeof row.error_code === 'string' && /^\d{1,9}$/.test(row.error_code)
        ? [{ label: 'Recorded result code', value: row.error_code }] : []),
      { label: 'Scope', value: 'One selected qualifying event, not the application or IP for every attempt.' },
    ],
  }
}

/** Called only inside a NEW envelope freeze. Never called to enrich a frozen retry. */
export async function loadEmailIncidentContext(
  runner: SqlRunner, messageId: string, ownerUserId: string,
): Promise<EmailIncidentContext> {
  const scope = parseEmailIncidentScope(messageId)
  if (!scope || !UUID.test(ownerUserId)) throw new Error('EMAIL_CONTEXT_UNAVAILABLE')
  // Authorization failure is not missing evidence. Prove the original scope before any fallback.
  const scoped = await runner.query<Pick<ContextRow, 'organization_id' | 'customer_tenant_id'
    | 'incident_key' | 'alert_type_id' | 'tenant_name' | 'tenant_domain'>>(`SELECT n.organization_id,
      n.customer_tenant_id, n.incident_key, n.alert_type_id,
      t.display_name AS tenant_name, t.primary_domain AS tenant_domain
    FROM customer_tenants t JOIN notifications n ON n.customer_tenant_id = t.id AND n.organization_id = t.organization_id
    JOIN alert_incidents i ON i.organization_id = n.organization_id AND i.incident_key = n.incident_key
    JOIN memberships m ON m.organization_id = t.organization_id AND m.user_id = $6::uuid
    JOIN users u ON u.id = m.user_id JOIN organizations o ON o.id = m.organization_id
    WHERE t.organization_id = $1::uuid AND t.id = $2::uuid AND n.incident_key = $3
      AND n.alert_type_id = $5 AND i.alert_type_id = $5
      AND (n.recipient_user_id IS NULL OR n.recipient_user_id = m.user_id)
      AND m.status = 'ACTIVE' AND m.role = 'MSP_OWNER' AND u.disabled_at IS NULL AND o.status = 'ACTIVE'
      AND NOT EXISTS (SELECT 1 FROM notifications conflict
        WHERE conflict.organization_id = $1::uuid AND conflict.incident_key = $3
          AND (conflict.customer_tenant_id IS DISTINCT FROM $2::uuid OR conflict.alert_type_id IS DISTINCT FROM $5))
      AND NOT EXISTS (SELECT 1 FROM notifications linked
        JOIN identity_risk_findings retained ON retained.organization_id = linked.organization_id
          AND linked.dedupe_key = 'identity-risk:' || retained.dedupe_key
        LEFT JOIN identity_risk_matched_results matched ON matched.id = retained.matched_result_id
        WHERE linked.organization_id = $1::uuid AND linked.incident_key = $3
          AND (retained.customer_tenant_id <> $2::uuid OR retained.subject_id <> $4
            OR (matched.id IS NOT NULL AND (matched.organization_id <> retained.organization_id
              OR matched.customer_tenant_id <> retained.customer_tenant_id OR matched.subject_id <> retained.subject_id
              OR matched.subject_type <> retained.subject_type OR matched.rule_id <> retained.rule_id))))
    LIMIT 1`, [scope.organizationId, scope.customerTenantId, scope.incidentKey, scope.subjectId, scope.alertTypeId, ownerUserId])
  const currentScope = scoped[0]
  if (scoped.length !== 1 || !currentScope || currentScope.organization_id !== scope.organizationId
    || currentScope.customer_tenant_id !== scope.customerTenantId || currentScope.incident_key !== scope.incidentKey
    || currentScope.alert_type_id !== scope.alertTypeId) throw new Error('EMAIL_CONTEXT_UNAVAILABLE')
  const rows = await runner.query<ContextRow>(`SELECT n.organization_id, n.customer_tenant_id,
      n.incident_key, n.alert_type_id, f.id AS finding_id, f.rule_id, f.subject_id, f.subject_type,
      r.observed_at, r.evidence, COUNT(*) OVER() AS total_findings,
      t.display_name AS tenant_name, t.primary_domain AS tenant_domain
    FROM notifications n
    JOIN customer_tenants t ON t.id = n.customer_tenant_id AND t.organization_id = n.organization_id
    JOIN identity_risk_findings f ON f.organization_id = n.organization_id AND f.customer_tenant_id = n.customer_tenant_id
      AND n.dedupe_key = 'identity-risk:' || f.dedupe_key
    JOIN identity_risk_matched_results r ON r.id = f.matched_result_id AND r.organization_id = f.organization_id
      AND r.customer_tenant_id = f.customer_tenant_id AND r.subject_id = f.subject_id
      AND r.subject_type = f.subject_type AND r.rule_id = f.rule_id
    WHERE n.organization_id = $1::uuid AND n.customer_tenant_id = $2::uuid AND n.incident_key = $3
      AND f.subject_id = $4 AND n.alert_type_id = $5
      AND (n.recipient_user_id IS NULL OR n.recipient_user_id = $6::uuid)
    ORDER BY r.observed_at DESC, f.id LIMIT ${EMAIL_CONTEXT_FINDING_LIMIT}`,
  [scope.organizationId, scope.customerTenantId, scope.incidentKey, scope.subjectId, scope.alertTypeId, ownerUserId])
  if (rows.some(row => row.organization_id !== scope.organizationId
    || row.customer_tenant_id !== scope.customerTenantId || row.incident_key !== scope.incidentKey
    || row.alert_type_id !== scope.alertTypeId || row.subject_id !== scope.subjectId
    || alertTypeForRule(row.rule_id) !== scope.alertTypeId)) throw new Error('EMAIL_CONTEXT_UNAVAILABLE')
  const total = rows.length ? Number(rows[0]!.total_findings) : 0
  if (!Number.isSafeInteger(total) || total < rows.length) throw new Error('EMAIL_CONTEXT_UNAVAILABLE')
  const hasNativeUser = rows.some(row => row.rule_id === 'HV-ID-AUTH-011.v1' && row.subject_type === 'USER')
  const userId = hasNativeUser ? userGuid(scope.subjectId) : null
  const users = userId ? await runner.query<DirectoryRow>(`SELECT d.microsoft_user_id, d.display_name, d.user_principal_name
    FROM directory_users d WHERE d.organization_id = $1::uuid AND d.customer_tenant_id = $2::uuid
      AND d.microsoft_user_id = $3::uuid
      AND NOT EXISTS (SELECT 1 FROM directory_users other WHERE other.organization_id = d.organization_id
        AND other.customer_tenant_id = d.customer_tenant_id AND other.id <> d.id
        AND lower(btrim(other.user_principal_name)) = lower(btrim(d.user_principal_name)))
    LIMIT 2`, [scope.organizationId, scope.customerTenantId, userId]) : []
  const directory = users.length === 1 && users[0]!.microsoft_user_id === userId ? users[0] : undefined
  const findings: EmailIncidentContext['findings'][number][] = []
  if (!rows.length) findings.push({ title: 'Recorded security incident', events: [], facts: [
    { label: 'Finding details', value: 'Not reported: underlying finding evidence is unavailable. Review the retained incident in HawkView.' },
  ] })
  const shownEvents = new Set<string>()
  for (const row of rows) {
    const native = row.rule_id === 'HV-ID-AUTH-011.v1' && row.subject_type === 'USER'
    const facts: EmailFact[] = [{ label: 'Finding observed', value: utc(row.observed_at) }]
    const events: EmailIncidentContext['findings'][number]['events'][number][] = []
    let duplicateEvents = 0
    const evidence = plain(row.evidence) ? row.evidence : null
    const signals = native && evidence?.detectorId === 'repeated-credential-failure'
      && Array.isArray(evidence.signals) && evidence.signals.length === 2 ? evidence.signals : []
    const seen = new Set<string>()
    for (const signal of signals) {
      if (!plain(signal) || (signal.signal !== 'PASSWORD_REJECTED' && signal.signal !== 'LOCKED_OUT_AFTER_REPEATED_FAILURES')
        || seen.has(signal.signal) || !Number.isSafeInteger(signal.count) || Number(signal.count) < 0
        || typeof signal.capped !== 'boolean') continue
      seen.add(signal.signal)
      const label = signal.signal === 'PASSWORD_REJECTED' ? 'Password-rejection events' : 'Lockout events'
      facts.push({ label, value: `${signal.capped ? 'At least ' : ''}${signal.count} in the evaluated window` })
      const latest = plain(signal.latest) && signal.latest.kind === 'EVENT_OCCURRED' ? timestamp(signal.latest.at) : null
      if (Number(signal.count) > 0 && latest) facts.push({ label: `${label}: latest observed`, value: utc(latest) })
      const ref = evidence?.schemaVersion === 'hawkview-native-email-evidence/v1'
        ? readSourceEventReference(signal.sourceEvent) : undefined
      if (ref && Number(signal.count) > 0 && latest === ref.eventAt) {
        const eventKey = JSON.stringify([ref.organizationId, ref.customerTenantId, ref.subjectRef, ref.source, ref.eventId])
        if (shownEvents.has(eventKey)) { duplicateEvents++; continue }
        const event = await selectedEvent(runner, scope, directory, ref, signal.signal)
        if (event) { events.push(event); shownEvents.add(eventKey) }
      }
    }
    if (duplicateEvents) facts.push({ label: 'Repeated selected evidence', value: `${duplicateEvents} selected event examples already shown above are not repeated.` })
    if (!events.length && !duplicateEvents) facts.push({ label: 'Application / source IP / actor',
      value: 'Not reported: no resolvable exact source-event reference is available for this finding.' })
    facts.push({ label: 'Role / policy', value: native ? 'Not applicable to this credential-failure finding' : unknown })
    findings.push({ title: native ? 'Repeated credential failures' : 'Recorded security finding', facts, events })
  }
  return { version: EMAIL_CONTEXT_VERSION,
    facts: [
      { label: 'Tenant (current directory)', value: emailDisplayValue(currentScope.tenant_name) },
      { label: 'Tenant domain (current directory)', value: typeof currentScope.tenant_domain === 'string'
        && /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9-]{2,63}$/i.test(currentScope.tenant_domain)
        ? emailDisplayValue(currentScope.tenant_domain, 253) : unknown },
      { label: 'Affected user (current directory)', value: emailDisplayValue(directory?.display_name) },
      { label: 'Affected UPN (current directory)', value: upnValue(directory?.user_principal_name) },
    ], findings, omittedFindings: total - rows.length,
    note: 'One incident and one tenant. Directory labels are current at email preparation, not historical event labels. Selected event details do not describe every attempt. This snapshot does not establish account compromise.' }
}

/** Only the closed content DTO crosses into the renderer. No arbitrary evidence object. */
export function validateEmailIncidentContext(context: EmailIncidentContext): void {
  const fail = (): never => { throw new Error('EMAIL_CONTEXT_UNAVAILABLE') }
  if (!plain(context) || context.version !== EMAIL_CONTEXT_VERSION || !Array.isArray(context.facts)
    || context.facts.length > 6 || !Array.isArray(context.findings) || context.findings.length < 1
    || context.findings.length > EMAIL_CONTEXT_FINDING_LIMIT || !Number.isSafeInteger(context.omittedFindings)
    || context.omittedFindings < 0) fail()
  const safe = (value: unknown, max: number): void => {
    if (typeof value !== 'string' || !value || value.length > max || suspiciousScalar(value)) fail()
  }
  const facts = (values: readonly EmailFact[]): void => {
    if (!Array.isArray(values) || values.length > 12) fail()
    for (const fact of values) {
      if (!plain(fact) || Object.keys(fact).sort().join(',') !== 'label,value') fail()
      safe(fact.label, 80); safe(fact.value, 400)
    }
  }
  if (Object.keys(context).sort().join(',') !== 'facts,findings,note,omittedFindings,version') fail()
  safe(context.note, 600); facts(context.facts)
  for (const finding of context.findings) {
    if (!plain(finding) || Object.keys(finding).sort().join(',') !== 'events,facts,title'
      || !Array.isArray(finding.events) || finding.events.length > 2) fail()
    safe(finding.title, 100); facts(finding.facts)
    for (const event of finding.events) {
      if (!plain(event) || Object.keys(event).sort().join(',') !== 'facts,title') fail()
      safe(event.title, 100); facts(event.facts)
    }
  }
}
