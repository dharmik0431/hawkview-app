import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import test from 'node:test'
import * as presentation from './presentation.ts'
import type {
  RiskAssessmentFinding,
  RiskAssessmentUser,
  RiskProtection,
  RiskProtectionEvidence,
} from './types.ts'

const require = createRequire(import.meta.url)
const React = require('react')
const { renderToStaticMarkup } = require('react-dom/server')
const { JSDOM } = require('jsdom')
const ts = require('typescript')
const receiptTime = Date.parse('2026-09-08T22:00:00.000Z')
const observedAt = '2026-09-08T21:00:00.000Z'
const evaluatedAt = '2026-09-08T21:05:00.000Z'

function unknownEvidence<
  State extends string,
>(): RiskProtectionEvidence<State> {
  return {
    state: 'UNKNOWN',
    source: 'NOT_REPORTED',
    observedAt: null,
    freshness: 'UNKNOWN',
    reasonCode: 'NOT_REPORTED',
  }
}

function currentEvidence<State extends string>(
  state: State
): RiskProtectionEvidence<State> {
  return {
    state,
    source: 'MICROSOFT_GRAPH',
    observedAt,
    freshness: 'CURRENT',
    reasonCode: 'VERIFIED',
  }
}

function protection(): RiskProtection {
  return {
    conditionalAccess: {
      contractVersion: 1,
      source: 'EFFECTIVE_MFA_V1',
      status: 'UNKNOWN',
      freshness: 'UNKNOWN',
      observedAt: null,
      evaluatedAt: null,
      policies: [],
      reasonCodes: ['POLICIES_MISSING'],
    },
    securityDefaults: unknownEvidence(),
    legacyPerUserMfa: unknownEvidence(),
    registration: unknownEvidence(),
    explanation:
      'Protection facts are separate from finding priority and event authentication.',
  }
}

function finding(): RiskAssessmentFinding {
  return {
    id: 'opaque.finding.1',
    ruleId: 'HV-ID-AUTH-010.v1',
    ruleVersion: 'v1',
    priority: 'LOW',
    confidence: 'HIGH',
    activityState: 'CURRENT',
    title: 'Repeated invalid credentials',
    explanation: 'Repeated invalid-credential evidence requires review.',
    firstSeen: '2026-09-08T20:45:00.000Z',
    lastSeen: observedAt,
    evaluatedAt,
    activityWindowEndsAt: '2026-09-08T22:15:00.000Z',
    window: { start: '2026-09-08T20:45:00.000Z', end: observedAt },
    evidenceCount: 10,
    evidenceCountCapped: false,
    selectedSource: 'GRAPH_SIGN_INS',
    application: {
      id: 'opaque.application.1',
      state: 'RESOLVED',
      label: 'Authorized client application',
    },
    device: { state: 'NOT_REPORTED', label: null },
    clientSource: { reference: 'opaque.client.1', qualification: 'QUALIFIED' },
    evidenceReferences: [
      {
        id: 'opaque.evidence.1',
        recordedAt: observedAt,
        ingestedAt: '2026-09-08T21:03:00.000Z',
      },
    ],
    eventProtection: 'NOT_REPORTED',
    caveats: ['An application or device may hold outdated credentials.'],
    recommendedActions: [
      {
        code: 'CHECK_SAVED_CREDENTIALS',
        text: 'Untrusted action text must never render.',
      },
    ],
  }
}

function user(): RiskAssessmentUser {
  return {
    id: 'opaque.subject.1',
    label: 'Authorized directory identity',
    subjectType: 'USER',
    priority: 'LOW',
    protection: protection(),
    findings: [finding()],
  }
}

function coveredUser() {
  const value = user()
  value.protection.conditionalAccess = {
    contractVersion: 1,
    source: 'EFFECTIVE_MFA_V1',
    status: 'COVERED_BY_CONDITIONAL_ACCESS',
    freshness: 'CURRENT',
    observedAt,
    evaluatedAt,
    reasonCodes: ['POLICIES_FRESH'],
    policies: [
      {
        id: 'opaque.policy.1',
        name: 'Require MFA for staff',
        state: 'ENABLED',
        outcome: 'UNIVERSAL',
        materialConditions: [],
      },
    ],
  }
  return value
}

function compileDrawer() {
  const exports: Record<string, any> = {}
  const source = readFileSync(
    new URL(
      '../../components/identity-risk/risk-assessment-drawer.tsx',
      import.meta.url
    ),
    'utf8'
  )
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      jsx: ts.JsxEmit.ReactJSX,
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText
  const mocks: Record<string, unknown> = {
    '@/lib/identity-risk/presentation': presentation,
    '@/lib/utils': {
      cn: (...values: string[]) => values.filter(Boolean).join(' '),
    },
    '@/components/ui/badge': {
      Badge: ({ variant: _variant, ...props }: any) =>
        React.createElement('span', props),
    },
    '@/components/ui/button': {
      Button: React.forwardRef(function TestButton(
        { variant: _variant, size: _size, ...props }: any,
        ref: any
      ) {
        return React.createElement('button', { ...props, ref })
      }),
    },
  }
  new Function('require', 'exports', compiled)(
    (name: string) => mocks[name] ?? require(name),
    exports
  )
  return exports.RiskAssessmentDrawer
}

const Drawer = compileDrawer()

function renderDrawer(value: RiskAssessmentUser | null) {
  const markup = renderToStaticMarkup(
    React.createElement(Drawer, { user: value, onClose: () => undefined })
  )
  const dom = new JSDOM(markup)
  return {
    dom,
    document: dom.window.document as Document,
    text: dom.window.document.body.textContent ?? '',
    markup,
  }
}

function field(document: Document, label: string) {
  return Array.from(document.querySelectorAll('dt')).find(
    (node) => node.textContent === label
  )?.nextElementSibling?.textContent
}

test('current evaluator evidence presents the authorized policy name and neutral protection heading', (t) => {
  t.mock.method(Date, 'now', () => receiptTime)
  const value = coveredUser()
  assert.equal(presentation.riskProtectionSummary(value).tone, 'positive')
  assert.match(
    presentation.riskProtectionSummary(value).label,
    /Require MFA for staff/
  )
  const rendered = renderDrawer(value)
  assert.equal(
    rendered.document.querySelector('#protection-heading')?.textContent,
    'Protection context'
  )
  assert.match(rendered.text, /Effective MFA evaluator v1/)
  assert.match(rendered.text, /policies: fresh/)
  assert.doesNotMatch(rendered.text, /Verified protection context/)
  rendered.dom.window.close()
})

test('stale, unknown, undated, invalid, future and expired CA evidence never verifies coverage', (t) => {
  t.mock.method(Date, 'now', () => receiptTime)
  const cases: Array<(value: RiskProtection['conditionalAccess']) => void> = [
    (value) => {
      value.freshness = 'STALE'
    },
    (value) => {
      value.freshness = 'UNKNOWN'
    },
    (value) => {
      value.observedAt = null
    },
    (value) => {
      value.evaluatedAt = null
    },
    (value) => {
      value.observedAt = '2026-02-30T21:00:00Z'
    },
    (value) => {
      value.evaluatedAt = '2026-09-08T20:59:00.000Z'
    },
    (value) => {
      value.evaluatedAt = '2026-09-08T22:00:00.001Z'
    },
    (value) => {
      value.observedAt = '2026-09-08T22:01:00.000Z'
      value.evaluatedAt = value.observedAt
    },
    (value) => {
      value.observedAt = new Date(receiptTime - 26 * 3600000 - 1).toISOString()
    },
    (value) => {
      value.source = 'MICROSOFT_GRAPH' as typeof value.source
    },
    (value) => {
      value.contractVersion = 2 as 1
    },
    (value) => {
      value.policies = []
    },
    (value) => {
      value.policies[0].state = 'DISABLED'
    },
    (value) => {
      value.policies[0].materialConditions = ['application subset']
    },
  ]
  for (const change of cases) {
    const value = coveredUser()
    change(value.protection.conditionalAccess)
    assert.equal(
      presentation.riskConditionalAccessIsCurrent(
        value.protection.conditionalAccess
      ),
      false
    )
    assert.notEqual(presentation.riskProtectionSummary(value).tone, 'positive')
    const rendered = renderDrawer(value)
    assert.match(rendered.text, /Coverage not verified from current evidence/)
    assert.equal(
      rendered.document.querySelector(
        '[aria-labelledby="protection-heading"] [class*="emerald"]'
      ),
      null
    )
    rendered.dom.window.close()
  }
})

test('independent protection facts require dated current provenance; 26-hour boundary is inclusive', (t) => {
  t.mock.method(Date, 'now', () => receiptTime)
  const fact = currentEvidence('ENABLED')
  fact.observedAt = new Date(receiptTime - 26 * 3600000).toISOString()
  assert.equal(presentation.riskProtectionEvidenceIsCurrent(fact), true)
  const cases: Array<Partial<typeof fact>> = [
    { freshness: 'STALE' },
    { freshness: 'UNKNOWN' },
    { source: 'NOT_REPORTED' },
    { state: 'UNKNOWN' },
    { reasonCode: 'FAILED' },
    { reasonCode: 'MISSING_PERMISSION' },
    { reasonCode: 'INCOMPLETE' },
    { observedAt: null },
    { observedAt: 'bad-date' },
    { observedAt: '2026-02-30T21:00:00Z' },
    { observedAt: new Date(receiptTime + 1).toISOString() },
    { observedAt: new Date(receiptTime - 26 * 3600000 - 1).toISOString() },
  ]
  for (const change of cases) {
    const value = user()
    value.protection.securityDefaults = { ...fact, ...change }
    assert.equal(
      presentation.riskProtectionEvidenceIsCurrent(
        value.protection.securityDefaults
      ),
      false
    )
    assert.notEqual(presentation.riskProtectionSummary(value).tone, 'positive')
  }
  const value = coveredUser()
  value.protection.conditionalAccess.observedAt = fact.observedAt
  assert.equal(
    presentation.riskConditionalAccessIsCurrent(
      value.protection.conditionalAccess
    ),
    true
  )
})

test('registration alone and legacy enabled state do not prove enforced MFA', (t) => {
  t.mock.method(Date, 'now', () => receiptTime)
  const value = user()
  value.protection.registration = currentEvidence('REGISTERED')
  value.protection.legacyPerUserMfa = currentEvidence('ENABLED')
  assert.notEqual(presentation.riskProtectionSummary(value).tone, 'positive')
  const rendered = renderDrawer(value)
  assert.match(rendered.text, /MFA registration does not prove enforcement/)
  assert.match(rendered.text, /Microsoft Graph/)
  assert.match(rendered.text, /Verified from current evidence/)
  assert.doesNotMatch(rendered.text, /Per-user MFA enforced/)
  rendered.dom.window.close()
  value.protection.legacyPerUserMfa = currentEvidence('ENFORCED')
  assert.equal(
    presentation.riskProtectionSummary(value).label,
    'Per-user MFA enforced'
  )
  value.protection.legacyPerUserMfa.freshness = 'STALE'
  assert.notEqual(presentation.riskProtectionSummary(value).tone, 'positive')
  value.protection.securityDefaults = currentEvidence('ENABLED')
  assert.equal(
    presentation.riskProtectionSummary(value).label,
    'Security Defaults enabled'
  )
})

test('report-only, disabled and conditional policies never become universal MFA protection', (t) => {
  t.mock.method(Date, 'now', () => receiptTime)
  const cases = [
    {
      status: 'REPORT_ONLY',
      state: 'REPORT_ONLY',
      outcome: 'NOT_ENFORCED',
      conditions: [],
      label: 'Conditional Access is report-only',
    },
    {
      status: 'REPORT_ONLY',
      state: 'REPORT_ONLY',
      outcome: 'UNIVERSAL',
      conditions: [],
      label: 'Conditional Access is report-only',
    },
    {
      status: 'REPORT_ONLY',
      state: 'REPORT_ONLY',
      outcome: 'CONDITIONAL',
      conditions: ['application subset'],
      label: 'Conditional Access is report-only',
    },
    {
      status: 'NOT_COVERED',
      state: 'DISABLED',
      outcome: 'NOT_ENFORCED',
      conditions: [],
      label: 'Protection not verified',
    },
    {
      status: 'CONDITIONALLY_COVERED',
      state: 'ENABLED',
      outcome: 'CONDITIONAL',
      conditions: ['application subset', 'location'],
      label: 'Conditional MFA coverage',
    },
  ] as const
  for (const item of cases) {
    const value = coveredUser()
    const ca = value.protection.conditionalAccess
    ca.status = item.status
    ca.policies[0].state = item.state
    ca.policies[0].outcome = item.outcome
    ca.policies[0].materialConditions = [...item.conditions]
    assert.equal(presentation.riskProtectionSummary(value).label, item.label)
    assert.notEqual(presentation.riskProtectionSummary(value).tone, 'positive')
    const rendered = renderDrawer(value)
    assert.match(rendered.text, /Require MFA for staff/)
    assert.doesNotMatch(rendered.text, /MFA required by Conditional Access/)
    if (item.status === 'CONDITIONALLY_COVERED')
      assert.match(rendered.text, /Conditions: application subset · location/)
    rendered.dom.window.close()
  }
})

test('negative enforcement requires independent verified defaults and per-user evidence', (t) => {
  t.mock.method(Date, 'now', () => receiptTime)
  const value = coveredUser()
  value.protection.conditionalAccess.status = 'NOT_COVERED'
  value.protection.conditionalAccess.policies = []
  value.protection.securityDefaults = currentEvidence('DISABLED')
  assert.equal(
    presentation.riskProtectionSummary(value).label,
    'Protection not verified'
  )
  value.protection.legacyPerUserMfa = currentEvidence('DISABLED')
  assert.equal(
    presentation.riskProtectionSummary(value).label,
    'No enforced MFA protection verified'
  )
  value.protection.securityDefaults.reasonCode = 'FAILED'
  assert.equal(
    presentation.riskProtectionSummary(value).label,
    'Protection not verified'
  )
})

test('event-specific protection is separate from current protection and finding priority', (t) => {
  t.mock.method(Date, 'now', () => receiptTime)
  for (const eventProtection of [
    'MFA_SATISFIED',
    'BLOCKED_BY_POLICY',
    'NOT_REPORTED',
  ] as const) {
    const value = user()
    value.findings[0].eventProtection = eventProtection
    value.findings[0].activityState = 'HISTORICAL'
    value.priority = null
    const before = JSON.stringify(value)
    const rendered = renderDrawer(value)
    assert.match(rendered.text, /Protection not verified/)
    assert.match(rendered.text, /low priority/)
    assert.match(rendered.text, /Historical/)
    assert.match(rendered.text, /does not reduce finding priority/)
    assert.match(
      rendered.text,
      eventProtection === 'MFA_SATISFIED'
        ? /MFA satisfied for this event/
        : eventProtection === 'BLOCKED_BY_POLICY'
          ? /Blocked by policy/
          : /Event protection not reported/
    )
    assert.equal(JSON.stringify(value), before)
    rendered.dom.window.close()
  }
})

test('real drawer distinguishes activity, evidence, ingestion and evaluation times', (t) => {
  t.mock.method(Date, 'now', () => receiptTime)
  const value = user()
  value.findings.push(
    { ...finding(), id: 'opaque.finding.2', activityState: 'HISTORICAL' },
    { ...finding(), id: 'opaque.finding.3', activityState: 'UNKNOWN' }
  )
  const rendered = renderDrawer(value)
  assert.match(rendered.text, /1 current · 1 historical · 1 timing unknown/)
  for (const label of [
    'First evidence time',
    'Last evidence time',
    'Evaluation time',
    'Activity window ends',
    'Evidence window starts',
    'Evidence window ends',
  ]) {
    assert.ok(field(rendered.document, label), label)
  }
  assert.match(rendered.text, /Evidence time: /)
  assert.match(rendered.text, /Ingestion time: /)
  assert.match(rendered.text, /opaque\.evidence\.1/)
  assert.match(rendered.text, /Activity timing unknown/)
  rendered.dom.window.close()
})

test('application and client source require resolved and qualified fields; device labels are never invented', (t) => {
  t.mock.method(Date, 'now', () => receiptTime)
  const value = user()
  let rendered = renderDrawer(value)
  assert.equal(
    field(rendered.document, 'Application'),
    'Authorized client application'
  )
  assert.equal(field(rendered.document, 'Device'), 'Not reported')
  assert.equal(
    field(rendered.document, 'Client source reference'),
    'opaque.client.1'
  )
  rendered.dom.window.close()
  value.findings[0].application.state = 'NOT_REPORTED'
  value.findings[0].application.label = 'Speculative application label'
  value.findings[0].device = {
    state: 'INSUFFICIENT_FIELDS',
    label: 'Speculative device label' as unknown as null,
  }
  value.findings[0].clientSource = {
    qualification: 'INSUFFICIENT_FIELDS',
    reference: '192.0.2.42',
  }
  rendered = renderDrawer(value)
  assert.equal(field(rendered.document, 'Application'), 'Not reported')
  assert.equal(field(rendered.document, 'Device'), 'Insufficient fields')
  assert.equal(
    field(rendered.document, 'Client source reference'),
    'Insufficient fields'
  )
  assert.doesNotMatch(rendered.text, /Speculative|192\.0\.2\.42/)
  rendered.dom.window.close()
})

test('text is escaped and suggested actions are code-owned, including unknown-code fallback', (t) => {
  t.mock.method(Date, 'now', () => receiptTime)
  const value = coveredUser()
  value.label = '<script>userInjection()</script>'
  value.protection.conditionalAccess.policies[0].name =
    '<img src=x onerror=policyInjection()>'
  value.findings[0].application.label = '<svg onload=applicationInjection()>'
  value.findings[0].recommendedActions[0].text =
    '<script>actionInjection()</script>'
  const rendered = renderDrawer(value)
  assert.equal(rendered.document.querySelector('script,img,svg[onload]'), null)
  assert.match(rendered.markup, /&lt;script&gt;userInjection/)
  assert.match(rendered.markup, /&lt;img/)
  assert.match(
    rendered.text,
    /Check for outdated credentials saved in an application or device/
  )
  assert.doesNotMatch(rendered.text, /actionInjection|Untrusted action text/)
  assert.equal(
    presentation.riskRecommendedActionLabel('__proto__' as never),
    'Review the available evidence.'
  )
  assert.equal(
    presentation.riskRecommendedActionLabel('constructor' as never),
    'Review the available evidence.'
  )
  rendered.dom.window.close()
})

test('closed drawer renders no subject or finding content', () => {
  const rendered = renderDrawer(null)
  assert.equal(rendered.document.querySelector('[role="dialog"]'), null)
  assert.equal(rendered.text, '')
  rendered.dom.window.close()
})
