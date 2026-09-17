import { ALERT_CATALOG, type AlertTypeId } from './alert-catalog.js'
import { type Body } from './email-delivery.js'
import { type EmailIncidentContext, validateEmailIncidentContext } from './email-incident-context.js'

export const ALERT_EMAIL_CONSOLE_ORIGIN = 'https://console.hawkviewapp.com'
export const ALERT_EMAIL_CONSOLE_URL = `${ALERT_EMAIL_CONSOLE_ORIGIN}/risky-users`
export const ALERT_EMAIL_TEMPLATE_VERSION = 'hawkview-security-v2'
export const ALERT_EMAIL_LOGO_URL = 'https://console.hawkviewapp.com/brand/hawkview-mark-256.png'

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
  readonly summary: string
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
  readonly incidentContext: EmailIncidentContext | null
  readonly compact: CompactAlertEmailContent | null
}

export interface CompactAlertEmailContent {
  readonly headline: string
  readonly intro: string
  readonly facts: readonly { readonly label: string; readonly value: string }[]
  readonly qualification: string
  readonly action: string
}

/** Presentation only: keep all fields and counts associated with one supplied snapshot/event. */
function compactIncidentContent(context: EmailIncidentContext, headline: string): CompactAlertEmailContent {
  const candidates = context.findings.flatMap(finding => finding.events.map(event => ({ finding, event })))
  const selected = candidates.find(item => item.event.title === 'Latest qualifying lockout event')
    ?? candidates.find(item => item.event.title === 'Latest qualifying password-rejection event')
  const finding = selected?.finding ?? context.findings[0]!
  const value = (facts: readonly { label: string; value: string }[], label: string) =>
    facts.find(fact => fact.label === label)?.value ?? 'Not reported'
  const reported = (entry: string) => !entry.startsWith('Not reported') && !entry.startsWith('Not applicable')
  const facts = [{ label: 'Tenant', value: value(context.facts, 'Tenant (current directory)') }]
  const domain = value(context.facts, 'Tenant domain (current directory)')
  if (reported(domain)) facts.push({ label: 'Domain', value: domain })
  facts.push({ label: 'Affected user', value: value(context.facts, 'Affected user (current directory)') },
    { label: 'Email', value: value(context.facts, 'Affected UPN (current directory)') })

  const activity: string[] = []
  for (const [label, singular, plural] of [
    ['Password-rejection events', 'password rejection', 'password rejections'],
    ['Lockout events', 'lockout reported', 'lockouts reported'],
  ]) {
    const match = /^(At least )?(\d+) in the evaluated window$/.exec(value(finding.facts, label!))
    if (!match || !Number.isSafeInteger(Number(match[2])) || Number(match[2]) <= 0) continue
    activity.push(`${match[1] ?? ''}${match[2]} ${Number(match[2]) === 1 ? singular : plural}`)
  }
  if (activity.length) facts.push({ label: 'Activity', value: `${activity.join('; ')} (evaluated window)` })
  if (selected) {
    facts.push({ label: 'Selected source event', value: selected.event.title })
    for (const label of ['Application', 'Resource', 'Source IP']) {
      const entry = value(selected.event.facts, label)
      if (reported(entry)) facts.push({ label, value: entry })
    }
    facts.push({ label: 'Observed', value: value(selected.event.facts, 'Event time') })
  } else {
    facts.push({ label: 'Observed (finding)', value: value(finding.facts, 'Finding observed') })
  }
  const missingFinding = finding.facts.some(fact => fact.label === 'Finding details'
    && fact.value.includes('underlying finding evidence is unavailable'))
  const eventKind = selected?.event.title === 'Latest qualifying lockout event' ? 'lockout' : 'password-rejection'
  let qualification = selected
    ? `Tenant and identity labels are current directory values; application, resource, IP, and time describe the selected ${eventKind} event, not every attempt.`
    : missingFinding
      ? 'Tenant and identity labels are current directory values; underlying finding evidence is unavailable.'
      : 'Tenant and identity labels are current directory values; event-specific application and source IP were not reported for this alert.'
  const others = context.findings.length - 1 + context.omittedFindings
  if (others) qualification += ` ${others} other finding snapshots are not shown.`
  const credential = finding.title === 'Repeated credential failures' && activity.length > 0
  return {
    headline: credential ? 'Credential-failure activity needs review' : headline,
    intro: credential ? 'HawkView recorded repeated authentication failures for this identity.'
      : 'Review the recorded security activity in your HawkView workspace.',
    facts, qualification,
    action: credential
      ? 'Review the sign-in evidence, confirm whether the activity was expected, and follow your incident-response process if it was not.'
      : 'Review the available evidence in HawkView and confirm whether the activity was expected before taking action.',
  }
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

/** Fixed English/UTC formatting is deterministic across hosts and preserves supplied precision. */
function observedRange(from: string, to: string): string {
  const date = (iso: string) => {
    const value = new Date(iso)
    const month = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][value.getUTCMonth()]
    return `${month} ${value.getUTCDate()}, ${value.getUTCFullYear()}`
  }
  const time = (iso: string) => {
    const seconds = iso.slice(17, 19), milliseconds = iso.slice(20, 23)
    return iso.slice(11, 16) + (seconds !== '00' || milliseconds !== '000' ? `:${seconds}` : '')
      + (milliseconds !== '000' ? `.${milliseconds}` : '')
  }
  return `${date(from)}, ${time(from)} to ${from.slice(0, 10) === to.slice(0, 10) ? '' : `${date(to)}, `}${time(to)} UTC`
}

/** Pure snapshot content. No clock, I/O, recipient data, current-state lookup or free-text input. */
export function buildAlertEmailContent(
  body: Body, options: { readonly mode: 'live' | 'historical-test'; readonly incidentContext?: EmailIncidentContext } = { mode: 'live' },
): AlertEmailContent {
  if (options.incidentContext) validateEmailIncidentContext(options.incidentContext)
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
    { label: 'Rule priority', value: { ACT_NOW: 'Act now', ACT_TODAY: 'Act today', RECORD_ONLY: 'Record only' }[declaration.severity] },
  ]
  if (windows.length) {
    const from = observedIso(windows[0].fromIso)
    const to = observedIso(windows[0].toIso)
    if (from > to) return unavailable()
    facts.push({ label: 'Observed range', value: observedRange(from, to) })
  }
  return {
    subject: `${historical ? '[TEST] ' : ''}HawkView security alert`,
    brand: 'HawkView',
    eyebrow: historical ? 'TEST / HISTORICAL ALERT PREVIEW' : 'SECURITY ALERT',
    headline: declaration.summary,
    intro: historical
      ? 'This is a preview of a previously recorded HawkView alert.'
      : 'A security alert needs review in your HawkView workspace.',
    summary: options.incidentContext ? '1 incident in 1 tenant' : `${count.incidentsAffected} ${count.incidentsAffected === 1 ? 'incident' : 'incidents'} across ${count.tenantsAffected} ${count.tenantsAffected === 1 ? 'tenant' : 'tenants'}`,
    notice: historical ? 'Not a newly detected incident. No action is required for this test. The guidance below is for reference only.' : null,
    facts: options.incidentContext ? facts.filter(fact => fact.label !== 'Observed range') : facts,
    priorityNote: 'Default rule priority, not recorded severity or a current override.',
    why: guidance.why,
    steps: guidance.steps,
    source: 'Source: HawkView alert classification. This is not a Microsoft-issued notification. Review the underlying source evidence in HawkView.',
    actionLabel: historical ? 'View historical context in HawkView' : 'Review in HawkView',
    actionUrl: ALERT_EMAIL_CONSOLE_URL,
    authorizationNote: 'Sign-in and current workspace authorization are required. Select your workspace to see affected tenant and account details.',
    previewNote: historical ? 'This preview is for appearance and provider-delivery checks only. It does not verify the application queue, delivery ledger or end-to-end alert delivery.' : null,
    incidentContext: options.incidentContext ?? null,
    compact: options.incidentContext ? compactIncidentContent(options.incidentContext, declaration.summary) : null,
  }
}

/** The HTML renderer must use this same content object, including all caveats and TEST copy. */
export function alertEmailPlaintext(content: AlertEmailContent): string {
  if (content.compact) {
    const compact = content.compact
    return [content.brand, content.eyebrow, compact.headline, '', compact.intro,
      ...(content.notice ? [content.notice] : []), '',
      ...compact.facts.map(fact => `${fact.label}: ${fact.value}`), '', compact.qualification, '',
      'Recommended action', compact.action, '',
      `${content.notice ? content.actionLabel : 'View in HawkView'}: ${content.actionUrl}`,
      'Sign-in and current workspace authorization are required.',
      ...(content.previewNote ? ['', content.previewNote] : []), '',
    ].join('\n')
  }
  return [
    content.brand, content.eyebrow, content.headline, '', content.intro,
    ...(content.notice ? [content.notice] : []), '',
    ...(content.incidentContext ? [
      'Incident details', ...content.incidentContext.facts.map(fact => `${fact.label}: ${fact.value}`),
      ...content.incidentContext.findings.flatMap(finding => [
        '', finding.title, ...finding.facts.map(fact => `${fact.label}: ${fact.value}`),
        ...finding.events.flatMap(event => ['', event.title, ...event.facts.map(fact => `${fact.label}: ${fact.value}`)]),
      ]),
      ...(content.incidentContext.omittedFindings ? [`${content.incidentContext.omittedFindings} additional finding snapshots for this incident are not shown.`] : []),
      content.incidentContext.note, '',
    ] : []),
    'Why it matters', content.why, '',
    ...(!content.incidentContext ? ['Alert scope', content.summary,
      ...content.facts.map(fact => `${fact.label}: ${fact.value}`), content.priorityNote, ''] : []),
    `${content.actionLabel}: ${content.actionUrl}`, content.authorizationNote, '',
    'Investigation next steps', ...content.steps.map((step, index) => `${index + 1}. ${step}`), '', content.source,
    ...(content.previewNote ? ['', content.previewNote] : []), '',
  ].join('\n')
}
