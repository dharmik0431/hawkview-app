import { ALERT_CATALOG, type AlertTypeId } from './alert-catalog.js'
import { type Body } from './email-delivery.js'

export const ALERT_EMAIL_CONSOLE_ORIGIN = 'https://console.hawkviewapp.com'
export const ALERT_EMAIL_CONSOLE_URL = `${ALERT_EMAIL_CONSOLE_ORIGIN}/risky-users`
export const ALERT_EMAIL_TEMPLATE_VERSION = 'hawkview-security-v1'

type SecurityType = Extract<AlertTypeId, `security.${string}`>
const GUIDANCE: Record<SecurityType, { why: string; steps: readonly string[] }> = {
  'security.suspected_credential_attack': {
    why: 'Repeated authentication failures can be consistent with a credential attack. They do not, by themselves, establish that an account was compromised.',
    steps: [
      'Open the alert in HawkView and review the affected accounts and available sign-in evidence.',
      'Check whether successful sign-ins followed the failures and whether the activity was expected.',
      'If the evidence indicates unauthorized access, follow your incident-response process and document the investigation.',
    ],
  },
  'security.privileged_directory_change': {
    why: 'Changes to privileged access or security configuration can affect who can access the environment. A change may be legitimate; authorization needs to be checked.',
    steps: [
      'Open the alert in HawkView and inspect the available directory-change evidence.',
      'Compare the actor, affected permissions and timing with an approved administrative change.',
      'If the change was not authorized, follow your incident-response process and record the response.',
    ],
  },
  'security.routine_directory_change': {
    why: 'A recorded directory change provides administrative context. Its presence alone does not establish malicious activity or an account compromise.',
    steps: [
      'Open the record in HawkView and review the available change evidence.',
      'Confirm whether the change matches expected administration.',
      'Investigate unexpected activity alongside related evidence before deciding on a response.',
    ],
  },
}

export interface AlertEmailContent {
  readonly subject: string
  readonly brand: string
  readonly eyebrow: string
  readonly headline: string
  readonly intro: string
  readonly notice: string | null
  readonly facts: readonly { readonly label: string; readonly value: string }[]
  readonly priorityNote: string
  readonly why: string
  readonly steps: readonly string[]
  readonly source: string
  readonly actionLabel: string
  readonly actionUrl: string
  readonly authorizationNote: string
  readonly previewNote: string | null
}

const unavailable = (): never => { throw new Error('EMAIL_CONTENT_UNAVAILABLE') }

/** Never interpolate untrusted URLs, tenant labels, titles or identifiers into an email. */
export function allowlistedAlertEmailUrl(origin: string): string {
  if (origin !== ALERT_EMAIL_CONSOLE_ORIGIN) throw new Error('EMAIL_LINK_UNAVAILABLE')
  return ALERT_EMAIL_CONSOLE_URL
}

export function escapeAlertEmailHtml(value: string): string {
  return value.replace(/[&<>"']/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]!)
}

function observedIso(value: unknown): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)) return unavailable()
  const time = Date.parse(value)
  if (!Number.isFinite(time)) return unavailable()
  const canonical = new Date(time).toISOString()
  if (canonical !== (value.includes('.') ? value : value.replace('Z', '.000Z'))) return unavailable()
  return canonical
}

/** Pure snapshot content. No clock, I/O, recipient data, current-state lookup or free-text input. */
export function buildAlertEmailContent(
  body: Body, options: { readonly mode: 'live' | 'historical-test' } = { mode: 'live' },
): AlertEmailContent {
  if (options.mode !== 'live' && options.mode !== 'historical-test') return unavailable()
  if (!Array.isArray(body) || body.length < 1 || body.length > 2
    || body.some(line => !line || typeof line !== 'object'
      || (line.kind !== 'TYPE_COUNT' && line.kind !== 'WINDOW'))) return unavailable()
  const counts = body.filter(line => line.kind === 'TYPE_COUNT')
  const windows = body.filter(line => line.kind === 'WINDOW')
  if (counts.length !== 1 || windows.length > 1) return unavailable()
  const count = counts[0]
  if (!Number.isSafeInteger(count.tenantsAffected) || count.tenantsAffected < 1
    || !Number.isSafeInteger(count.incidentsAffected) || count.incidentsAffected < 1
    || count.tenantsAffected > count.incidentsAffected) return unavailable()
  const declaration = ALERT_CATALOG.find(entry => entry.id === count.alertTypeId)
  if (!declaration || declaration.category !== 'SECURITY') return unavailable()
  const guidance = GUIDANCE[declaration.id]
  const historical = options.mode === 'historical-test'
  const facts = [
    { label: 'Alert type', value: declaration.summary },
    { label: 'Catalog priority', value: { ACT_NOW: 'Act now', ACT_TODAY: 'Act today', RECORD_ONLY: 'Record only' }[declaration.severity] },
    { label: 'Affected tenants', value: String(count.tenantsAffected) },
    { label: 'Incidents of this type', value: String(count.incidentsAffected) },
  ]
  if (windows.length) {
    const from = observedIso(windows[0].fromIso)
    const to = observedIso(windows[0].toIso)
    if (from > to) return unavailable()
    facts.push({ label: 'Observed range (UTC)', value: `${from} to ${to}` })
  }
  return {
    subject: `${historical ? '[TEST] ' : ''}HawkView security alert`,
    brand: 'HawkView',
    eyebrow: historical ? 'TEST / HISTORICAL ALERT PREVIEW' : 'SECURITY ALERT',
    headline: declaration.summary,
    intro: historical
      ? 'This is a preview of a previously recorded HawkView alert.'
      : 'A security alert needs review in your HawkView workspace.',
    notice: historical ? 'Not a newly detected incident. No action is required for this test. The guidance below is for reference only.' : null,
    facts,
    priorityNote: 'Catalog priority is the rule default, not recorded incident severity or your current rule setting.',
    why: guidance.why,
    steps: guidance.steps,
    source: 'Source: HawkView alert classification. This is not a Microsoft-issued notification. Review the underlying source evidence in HawkView.',
    actionLabel: historical ? 'View historical context in HawkView' : 'Review in HawkView',
    actionUrl: ALERT_EMAIL_CONSOLE_URL,
    authorizationNote: 'Sign-in and current workspace authorization are required. Select your workspace to see affected tenant and account details.',
    previewNote: historical ? 'This preview is for appearance and provider-delivery checks only. It does not verify the application queue, delivery ledger or end-to-end alert delivery.' : null,
  }
}

/** The HTML renderer must use this same content object, including all caveats and TEST copy. */
export function alertEmailPlaintext(content: AlertEmailContent): string {
  return [
    content.brand, content.eyebrow, content.headline, '', content.intro,
    ...(content.notice ? [content.notice] : []), '',
    ...content.facts.map(fact => `${fact.label}: ${fact.value}`),
    content.priorityNote, '', 'Why it matters', content.why, '', 'Investigation next steps',
    ...content.steps.map((step, index) => `${index + 1}. ${step}`), '',
    content.source, '', `${content.actionLabel}: ${content.actionUrl}`, content.authorizationNote,
    ...(content.previewNote ? ['', content.previewNote] : []), '',
  ].join('\n')
}
