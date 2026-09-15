import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import test from 'node:test'
import * as adapter from './adapter.ts'
import * as presentation from './presentation.ts'
import * as riskyUsersView from './risky-users-view.ts'
import * as microsoftRiskSummary from './microsoft-risk-summary.ts'
import type { useNativeRiskyUsersRead } from '../api/risky-users-assessment-hooks.ts'
import type { NativeAssessment } from './native-assessment.ts'
import {
  assessmentFixture,
  assessmentNow,
  assessmentUser,
  at,
} from './assessment-test-fixtures.ts'
import { syntheticRiskResponses, unavailableMeta } from './test-fixtures.ts'
import { nativeAssessmentFixture, nativeRiskyUsersFixture } from './risky-users-ui-native-fixtures.ts'

type NativeRiskyUsersRead = ReturnType<typeof useNativeRiskyUsersRead>

const require = createRequire(import.meta.url)
const React = require('react')
const { renderToStaticMarkup } = require('react-dom/server')
const { JSDOM } = require('jsdom')
const ts = require('typescript')

function compile(path: string, mocks: Record<string, unknown>) {
  const exports: Record<string, any> = {}
  const compiled = ts.transpileModule(
    readFileSync(new URL(path, import.meta.url), 'utf8'),
    {
      compilerOptions: {
        jsx: ts.JsxEmit.ReactJSX,
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
      },
    }
  ).outputText
  new Function('require', 'exports', compiled)(
    (name: string) => mocks[name] ?? require(name),
    exports
  )
  return exports
}

/** A Microsoft envelope that reports the tenant is not licensed for P2. */
function microsoftWithoutP2() {
  return {
    ...syntheticRiskResponses().microsoftRiskyUsers,
    ...unavailableMeta(
      'Microsoft Entra risky-user evidence is not available on this tenant.'
    ),
    reasonCode: 'LICENSE_REQUIRED',
    users: [],
    microsoftRiskSummary: {
      source: 'MICROSOFT_IDENTITY_PROTECTION',
      availability: 'UNAVAILABLE',
      completeness: 'UNKNOWN',
      rawRecordCount: null,
      observedActiveDistinctUserCount: null,
      activeDistinctUserCount: null,
      snapshotObservedAt: null,
      collectionSucceededAt: null,
      reasonCode: 'SOURCE_UNAVAILABLE',
    },
  }
}

function exactMicrosoftSummary(rawRecordCount: number, activeDistinctUserCount: number) {
  return {
    source: 'MICROSOFT_IDENTITY_PROTECTION',
    availability: 'AVAILABLE',
    completeness: 'COMPLETE',
    rawRecordCount,
    observedActiveDistinctUserCount: activeDistinctUserCount,
    activeDistinctUserCount,
    snapshotObservedAt: '2026-09-08T22:00:00.000Z',
    collectionSucceededAt: '2026-09-08T22:01:00.000Z',
    reasonCode: null,
  }
}

/**
 * A tenant where Microsoft's channel is live — threat-intelligence verdicts
 * already present in the sign-in evidence, no API call or purchase involved.
 */
function microsoftLive(hasMore = false) {
  const envelope = syntheticRiskResponses().microsoftRiskyUsers
  return {
    ...envelope,
    users: [
      {
        id: 'microsoft-record-1',
        identityLabel: 'Synthetic finance user',
        riskLevel: 'high',
        riskState: 'atRisk',
        riskDetail: null,
        observedAt: envelope.observedAt,
      },
      {
        id: 'microsoft-record-2',
        identityLabel: 'Synthetic sales user',
        riskLevel: 'medium',
        riskState: 'dismissed',
        riskDetail: null,
        observedAt: envelope.observedAt,
      },
    ],
    pageInfo: hasMore
      ? { hasMore: true, nextCursor: 'cursor.abc' }
      : { hasMore: false, nextCursor: null },
    microsoftRiskSummary: exactMicrosoftSummary(2, 1),
  }
}

function microsoftMixedVerdicts() {
  const envelope = syntheticRiskResponses().microsoftRiskyUsers
  const base = {
    riskLevel: 'high',
    riskDetail: null,
    observedAt: envelope.observedAt,
  }
  return {
    ...envelope,
    users: [
      {
        ...base,
        id: 'ms-1',
        identityLabel: 'Flagged user',
        riskState: 'atRisk',
      },
      {
        ...base,
        id: 'ms-2',
        identityLabel: 'Machine cleared user',
        riskState: 'atRisk',
        riskDetail: 'aiConfirmedSigninSafe',
      },
      {
        ...base,
        id: 'ms-3',
        identityLabel: 'Admin dismissed user',
        riskState: 'dismissed',
        riskDetail: 'adminDismissedAllRiskForUser',
      },
      {
        ...base,
        id: 'ms-4',
        identityLabel: 'Unrecognised verdict user',
        riskState: 'unknownFutureValue',
      },
      {
        ...base,
        id: 'ms-5',
        identityLabel: 'Level withheld user',
        riskLevel: 'hidden',
        riskState: 'atRisk',
      },
    ],
    pageInfo: { hasMore: false, nextCursor: null },
    microsoftRiskSummary: {
      ...exactMicrosoftSummary(5, 2),
      availability: 'PARTIAL',
      completeness: 'PARTIAL',
      activeDistinctUserCount: null,
      reasonCode: 'PARTIAL_RECORDS',
    },
  }
}

function render(
  assessmentValue: unknown = assessmentFixture(true),
  options: {
    microsoft?: unknown
    native?: NativeAssessment | null
    requestFailed?: boolean
    contractFailed?: boolean
    notReported?: boolean
    loading?: boolean
    // Applied after adaptation, for states the wire contract does not yet
    // allow but the projection is required to survive. The adapter's job is to
    // reject malformed payloads; the view model's is to be honest about shapes
    // the server is permitted to grow into.
    afterAdapt?: (value: any) => void
  } = {}
) {
  const assessment = adapter.adaptRiskAssessmentResponse(
    assessmentValue,
    assessmentNow
  )
  if (assessment) options.afterAdapt?.(assessment)
  const nativeView = options.native === undefined
    ? nativeAssessmentFixture(assessment)
    : options.native
  const microsoftView = adapter.adaptMicrosoftRiskyUsersResponse(
    options.microsoft ?? microsoftWithoutP2()
  )

  const identityRiskHooks = {
    useIdentityRiskChannels: () => ({
      cacheScope: 'synthetic-msp-session',
      assessmentView:
        options.contractFailed || options.notReported ? null : assessment,
      assessmentLoading: options.loading ?? false,
      assessmentRequestError: options.requestFailed ?? false,
      assessmentContractError: options.contractFailed ?? false,
      microsoftView,
      microsoftLoading: false,
      retryAssessment: () => undefined,
      retryMicrosoft: () => undefined,
    }),
  }

  const nativeRiskyUsersRead = {
    cacheScope: 'synthetic-msp-session',
    nativeView:
      options.contractFailed || options.notReported ? null : nativeView,
    assessmentLoading: options.loading ?? false,
    assessmentRequestError: options.requestFailed ?? false,
    assessmentContractError: options.contractFailed ?? false,
    microsoftView,
    microsoftLoading: false,
    retryAssessment: () => undefined,
    retryMicrosoft: () => undefined,
  } satisfies NativeRiskyUsersRead

  const nativeViewModule = require('./native-view.ts')
  const riskPresentationMapper = require('./risk-presentation-mapper.ts')

  const uiMocks = {
    '@/lib/identity-risk/presentation': presentation,
    '@/lib/identity-risk/risky-users-view': riskyUsersView,
    '@/lib/identity-risk/microsoft-risk-summary': microsoftRiskSummary,
    '@/lib/identity-risk/native-view': nativeViewModule,
    '@/lib/identity-risk/risk-presentation-mapper': riskPresentationMapper,
    '@/lib/api/hooks': {
      useTenantOperationalProjection: () => ({ tenant: { name: 'Synthetic Tenant', defaultDomainName: 'synthetic.com' } }),
    },
    '@/components/ui/input': {
      Input: (props: any) => React.createElement('input', props),
    },
    '@/components/ui/tooltip': {
      TooltipProvider: ({ children }: any) => React.createElement('div', null, children),
      Tooltip: ({ children }: any) => React.createElement('div', null, children),
      TooltipTrigger: ({ children }: any) => React.createElement('div', null, children),
      TooltipContent: ({ children }: any) => React.createElement('div', null, children),
    },
    '@/components/ui/table': {
      Table: ({ children, ...props }: any) => React.createElement('table', props, children),
      TableHeader: ({ children, ...props }: any) => React.createElement('thead', props, children),
      TableBody: ({ children, ...props }: any) => React.createElement('tbody', props, children),
      TableRow: ({ children, ...props }: any) => React.createElement('tr', props, children),
      TableHead: ({ children, ...props }: any) => React.createElement('th', props, children),
      TableCell: ({ children, ...props }: any) => React.createElement('td', props, children),
    },
    '@/lib/utils': {
      cn: (...values: any[]) => values.filter(Boolean).join(' '),
    },
    '@/components/ui/badge': {
      Badge: ({ variant: _, ...props }: any) =>
        React.createElement('span', props),
    },
    '@/components/ui/button': {
      Button: React.forwardRef(function TestButton(
        { variant: _, size: __, ...props }: any,
        ref: any
      ) {
        return React.createElement('button', { ...props, ref })
      }),
    },
  }

  const hooks = compile('../api/risky-users-hooks.ts', {
    ...uiMocks,
    './identity-risk-hooks': identityRiskHooks,
    './risky-users-assessment-hooks': {
      useNativeRiskyUsersRead: () => nativeRiskyUsersRead,
    },
  })
  const drawer = compile(
    '../../components/identity-risk/risk-assessment-drawer.tsx',
    { ...uiMocks, '@/lib/api/identity-risk-hooks': identityRiskHooks }
  )
  const fleetDrawer = compile(
    '../../components/identity-risk/fleet-risk-assessment-drawer.tsx',
    uiMocks
  )
  const section = compile(
    '../../components/identity-risk/risky-users-section.tsx',
    {
      ...uiMocks,
      '@/lib/api/risky-users-hooks': hooks,
      './risk-assessment-drawer': drawer,
      '@/components/identity-risk/fleet-risk-assessment-drawer': fleetDrawer,
    }
  )
  const card = compile(
    '../../components/identity-risk/risky-users-count-card.tsx',
    { ...uiMocks, '@/lib/api/risky-users-hooks': hooks }
  )

  const dom = new JSDOM(
    renderToStaticMarkup(
      React.createElement(section.default, { tenantId: 'synthetic-tenant' })
    )
  )
  const cardDom = new JSDOM(
    renderToStaticMarkup(
      React.createElement(card.RiskyUsersCountCard, {
        tenantId: 'synthetic-tenant',
        onOpen: () => undefined,
      })
    )
  )
  const visibleTextOf = (document: any) => {
    const clone = document.body.cloneNode(true)
    for (const hidden of clone.querySelectorAll('.sr-only')) hidden.remove()
    return (clone.textContent ?? '').replace(/\s+/g, ' ')
  }
  return {
    document: dom.window.document,
    text: dom.window.document.body.textContent ?? '',
    cardText: cardDom.window.document.body.textContent ?? '',
    cardDocument: cardDom.window.document,
    visibleCardText: visibleTextOf(cardDom.window.document),
    visibleText: visibleTextOf(dom.window.document),
    openNativeDrawer: (subjectRef?: string) => {
      function OpenNativeDrawer() {
        const view = hooks.useRiskyUsers('synthetic-tenant')
        const rows = [...view.list.rows, ...view.list.context]
        const row = subjectRef
          ? rows.find((candidate: any) => candidate.reference === subjectRef)
          : rows[0]
        assert.ok(row, 'an opened drawer must have a real row from the native hook')
        return React.createElement(fleetDrawer.FleetRiskAssessmentDrawer, {
          row: { ...row, tenantId: 'synthetic-tenant', tenantName: 'Synthetic Tenant', tenantDomain: null },
          isOpen: true,
          onClose: () => undefined,
        })
      }
      const opened = new JSDOM(renderToStaticMarkup(React.createElement(OpenNativeDrawer)))
      assert.ok(opened.window.document.querySelector('[role="dialog"]'))
      return {
        document: opened.window.document,
        text: opened.window.document.body.textContent ?? '',
      }
    },
  }
}

/* -------------------------------------------------------------------------- */


/** QA contract: the compact summary directly precedes the current native table. */
function compactSummary(document: Document) {
  const table = document.querySelector('[aria-labelledby="risky-users-table-heading"]')
  assert.ok(table, 'the current native table must exist')
  const summary = table.previousElementSibling
  assert.ok(summary, 'the real compact summary must exist')
  return summary
}

function nativeMicrosoftPair() {
  const native = nativeRiskyUsersFixture()
  const correlation = {
    available: true as const,
    shape: 'DIRECTORY_OBJECT_ID' as const,
    ref: '00000000-0000-4000-8000-000000000011',
  }
  native.findings[0]!.subject.correlation = correlation
  const base = microsoftLive()
  return {
    native,
    microsoft: {
      ...base,
      users: [{
        ...base.users[0]!,
        identityLabel: 'Native fixture user',
        correlation,
      }],
    },
  }
}


type ReadableNative = Extract<NativeAssessment, { available: true }>
const nativeProjection = require('./native-view.ts') as typeof import('./native-view.ts')

function renderNative(native: NativeAssessment | null = nativeRiskyUsersFixture(), options: Parameters<typeof render>[1] = {}) {
  return render(undefined, { ...options, native })
}

function nativeZero() {
  const native = nativeRiskyUsersFixture()
  native.count.value = 0
  native.findings = []
  return native
}

function nativeWithheld(because = 'UNRESOLVED_SUBJECT_IDENTITY') {
  const native = nativeRiskyUsersFixture()
  native.count.accuracy = 'NOT_AVAILABLE'
  native.count.value = null
  native.withheld = [{ stream: null, because }]
  return native
}

function nativeSignal(signal = 'PASSWORD_REJECTED', count = 10,
  kind: 'EVENT_OCCURRED' | 'STATE_OBSERVED' = 'EVENT_OCCURRED',
  at: string | null = '2026-09-08T21:59:00.000Z') {
  return { signal, count, capped: false, latest: at === null ? null : { at, kind } }
}

function nativeMailbox() {
  const native = nativeWithheld()
  native.findings[0] = {
    detectorId: 'external-mailbox-forwarding',
    subject: {
      ...native.findings[0]!.subject,
      kind: 'MAILBOX',
      ref: '00000000-0000-4000-8000-000000000022',
      displayName: 'Native mailbox fixture',
      userPrincipalName: null,
    },
    signals: [nativeSignal('EXTERNAL_FORWARDING_CONFIGURED', 3, 'STATE_OBSERVED')],
  }
  return native
}

function nativeTable(document: Document) {
  const table = document.querySelector('[aria-labelledby="risky-users-table-heading"]')
  assert.ok(table)
  return table
}

function actionableRows(document: Document) {
  return Array.from(nativeTable(document).querySelectorAll('tbody tr')).filter(row => row.querySelector('button'))
}

function findingItems(document: Document) {
  return Array.from(document.querySelectorAll('h4')).map(heading => {
    let item = heading.parentElement
    while (item && !item.querySelector('details')) item = item.parentElement
    assert.ok(item, 'each real drawer finding has its own technical disclosure')
    return item
  })
}

function primaryText(document: Document) {
  const body = document.body.cloneNode(true) as HTMLElement
  for (const detail of Array.from(body.querySelectorAll('details'))) detail.remove()
  return body.textContent ?? ''
}

function assertNativeCountCopy(native: ReadableNative, result: ReturnType<typeof render>) {
  const count = nativeProjection.nativeRiskyUserCount(native)
  for (const text of [result.text, result.cardText]) {
    assert.ok(text.includes(count.caption), 'the native count scope must reach both surfaces')
    // Exact-count coverage gaps carry the normalized gap headline, not a
    // duplicate reason paragraph. Withholding still requires every explanation.
    if (count.accuracy === 'WITHHELD') {
      for (const reason of count.reasons) assert.ok(text.includes(reason), reason)
    }
    for (const gap of count.gaps) assert.ok(text.includes(gap), gap)
    assert.doesNotMatch(text, /\d+ identities evaluated|\d+ mailboxes assessed/i)
  }
  return count
}

function assertIndependentPair() {
  const pair = nativeMicrosoftPair()
  const result = renderNative(pair.native, { microsoft: pair.microsoft })
  const rows = actionableRows(result.document)
  assert.equal(rows.length, 1)
  const badges = rows[0]!.querySelectorAll('td')[2]!.textContent ?? ''
  assert.match(badges, /HawkView/)
  assert.match(badges, /Microsoft/)
  assert.doesNotMatch(badges, /partial|unavailable|not comparable/i)
  assert.match(compactSummary(result.document).textContent ?? '', /1 users requiring review/)
  assert.match(compactSummary(result.document).textContent ?? '', /1 active Microsoft risk/)
  const drawer = result.openNativeDrawer()
  assert.match(drawer.text, /Detected by HawkView & Microsoft/)
  assert.match(drawer.text, /independent signals/)
  assert.match(result.text, /never combined into a single score/)
  return result
}

function assertNoMicrosoftConclusion() {
  const native = nativeRiskyUsersFixture()
  const result = renderNative(native, { microsoft: microsoftLive() })
  assert.equal(actionableRows(result.document).length, 1)
  const drawer = result.openNativeDrawer()
  assert.match(drawer.text, /Microsoft risk comparison incomplete/)
  assert.match(drawer.text, /No conclusion about active Microsoft risk can be drawn/)
  assert.match(drawer.text, /Partial coverage/)
  assert.doesNotMatch(drawer.text, /No active Microsoft risk reported|currently has no active risk record/)
  return result
}

function assertNoActiveMicrosoftControl() {
  const pair = nativeMicrosoftPair()
  pair.microsoft.users = []
  const view = adapter.adaptMicrosoftRiskyUsersResponse(pair.microsoft)
  const row = nativeProjection.nativeRiskyUserList(pair.native, riskyUsersView.microsoftChannel(view), view.users).rows[0]!
  assert.equal(row.detection.microsoft, 'NOT_REPORTED')
  const result = renderNative(pair.native, { microsoft: pair.microsoft })
  const drawer = result.openNativeDrawer()
  assert.match(drawer.text, /No active Microsoft risk reported/)
  assert.match(drawer.text, /does not confirm that the account is safe/)
  assert.doesNotMatch(drawer.text, /Microsoft risk comparison incomplete/)
  return result
}

function nativeWire(native: ReadableNative) {
  return {
    version: 'hawkview-risky-users/v1', available: true, run: native.run,
    collectors: native.collectors,
    coverage: native.coverage.map(({ stream, ...coverage }) => ({ stream, coverage })),
    subjectsNamed: native.subjectsNamed,
    count: { accuracy: native.count.accuracy, value: native.count.value,
      scope: { covered: native.count.covered, notCovered: native.count.notCovered, evidenceRequested: native.count.evidenceRequested } },
    claim: { permitted: true },
    findings: { complete: native.complete, items: native.findings.map(finding => ({
      detectorId: finding.detectorId,
      subject: { kind: finding.subject.kind,
        ...(finding.subject.kind === 'MAILBOX' ? { mailboxRef: finding.subject.ref } : { userRef: finding.subject.ref }),
        correlation: { available: false, because: 'NO_SHARED_CORRELATION' } },
      displayName: finding.subject.displayName, userPrincipalName: finding.subject.userPrincipalName,
      signals: finding.signals,
    })) },
  }
}

test('native contracts N33: native triage uses factual fields and volume ordering without priority', () => {
  // N33: Legacy priority columns are not native facts; preserve triage fields and observable volume/recency ordering.

  const native = nativeRiskyUsersFixture()
  const low = structuredClone(native.findings[0]!)
  low.subject.ref = '00000000-0000-4000-8000-000000000033'
  low.subject.displayName = 'Lower volume user'
  low.signals = [nativeSignal('PASSWORD_REJECTED', 2)]
  native.findings.unshift(low)
  native.count.value = 2
  const result = renderNative(native)
  assert.deepEqual([...result.document.querySelectorAll('th')].map(cell => cell.textContent?.trim()), [
    'User', 'Why this user needs review', 'Found by', 'Latest evidence', 'Data state', 'Action',
  ])
  const rows = actionableRows(result.document)
  assert.equal(rows.length, 2)
  assert.match(rows[0]!.textContent ?? '', /Native fixture user/)
  assert.match(rows[1]!.textContent ?? '', /Lower volume user/)
  assert.doesNotMatch(result.text, /priority|priorities|most important/i)
  assert.ok([...result.document.querySelectorAll('select')].every(select => !/priority/i.test(select.textContent ?? '')))
  assert.ok(rows.every(row => /Investigate/.test(row.textContent ?? '')))
})
test('native contracts R34: raw native subject references stay private while findings remain reviewable', () => {
  // R34: Native subject refs are raw IDs, not the legacy displayable opaque handle; conceal full and shortened refs without hiding evidence.

  for (const subjectsNamed of [true, false]) {
    const native = nativeRiskyUsersFixture()
    native.subjectsNamed = subjectsNamed
    native.findings[0]!.subject.displayName = null
    native.findings[0]!.subject.userPrincipalName = null
    const ref = native.findings[0]!.subject.ref
    const result = renderNative(native)
    assert.equal(actionableRows(result.document).length, 1)
    for (const text of [result.text, result.openNativeDrawer().text]) {
      assert.ok(text.includes(subjectsNamed ? 'Identity not resolved' : 'Name not shown for your role'))
      assert.ok(!text.includes(ref))
      assert.ok(!text.includes(ref.slice(0, 10)))
      assert.match(text, /Repeated unsuccessful sign-in activity/)
    }
  }
})
test('native contracts P35: the P2 gap is shown once as a first-class state, not as an empty column', () => {
  // P35: The native compact summary replaces the legacy Microsoft panel; preserve the licensed-unavailable, never-zero boundary.

  const result = renderNative()
  const summary = compactSummary(result.document).textContent ?? ''
  assert.equal((summary.match(/Microsoft risk status unavailable/g) ?? []).length, 1)
  assert.doesNotMatch(summary, /0 active Microsoft risk/)
  assert.match(summary, /1 users requiring review/)
  assert.match(summary, /1 detected by HawkView/)
  assert.equal(actionableRows(result.document).length, 1)
  // Tooltip detail may explain licensing; it is not a repeated visible badge.
  for (const row of actionableRows(result.document)) {
    const badges = Array.from(row.querySelectorAll('td')[2]!.querySelectorAll('span'))
    for (const badge of badges) assert.doesNotMatch(badge.textContent ?? '', /Entra ID P2/)
  }
})
test('native contracts R36: every row still names which system reported it', () => {
  // R36: Native source badges and the real drawer replace the legacy detection cell sentence; unavailable is not a negative finding.

  const result = renderNative()
  const rows = actionableRows(result.document)
  assert.equal(rows.length, 1)
  assert.match(rows[0]!.querySelectorAll('td')[2]!.textContent ?? '', /HawkView.*Microsoft coverage partial/)
  const drawer = result.openNativeDrawer()
  assert.match(drawer.text, /Microsoft Entra risk data unavailable/)
  assert.doesNotMatch(drawer.text, /No active Microsoft risk reported|currently has no active risk record/)
})
test('native contracts C37: a zero is never rendered alone', () => {
  // C37: Native zero is event/detector-scoped, not the legacy assessed-identity population; preserve scope and gaps on both surfaces.

  const native = nativeZero()
  native.count.notCovered = [{ detectorId: 'external-mailbox-forwarding', because: 'NEVER_COLLECTED' }]
  const result = renderNative(native)
  const count = assertNativeCountCopy(native, result)
  assert.equal(count.value, 0)
  assert.match(result.text, /0 users requiring review/)
  for (const text of [result.text, result.cardText]) {
    assert.match(text, /investigation leads, not confirmed compromise/i)
    assert.match(text, /Not covered by this number/)
    assert.match(text, /Every event this run examined/)
  }
})
test('native contracts P38: Microsoft-only risk has a separate count and an explicit table limitation', () => {
  // P38: The native table does not display Microsoft-only rows; disclose that limitation beside the separate active-risk summary.

  const result = renderNative(nativeRiskyUsersFixture(), { microsoft: microsoftLive() })
  const summary = compactSummary(result.document).textContent ?? ''
  assert.match(summary, /1 active Microsoft risk/)
  assert.match(result.text, /This table lists HawkView findings/)
  assert.match(result.text, /Microsoft-only identities.*Entra ID Protection/)
  assert.doesNotMatch(nativeTable(result.document).textContent ?? '', /Synthetic finance user|Synthetic sales user/)
  assert.doesNotMatch(result.text, /requires Entra ID P2/)
})
test('native contracts R39: Microsoft records are never folded into the HawkView list or its count', () => {
  // R39: Correlated native and Microsoft facts replace legacy separate panels; neither count nor evidence is merged.
  assertIndependentPair()
})
test('native contracts R40: rows say Microsoft is not comparable rather than that it cleared anyone', () => {
  // R40: Structured NOT_COMPARABLE is incomplete evidence, not the legacy unmatched cell or a Microsoft clearance.

  assertNoMicrosoftConclusion()
  assertNoActiveMicrosoftControl()
})
test('native contracts P41: pagination never supplies or changes the server tenant total', () => {
  // P41: A bounded page remains record evidence only; the independent server summary owns the tenant total.

  const partial = renderNative(nativeRiskyUsersFixture(), { microsoft: microsoftLive(true) })
  assert.match(compactSummary(partial.document).textContent ?? '', /1 active Microsoft risk identity/)
  const emptyPage = { ...microsoftLive(true), users: [] }
  const empty = renderNative(nativeRiskyUsersFixture(), { microsoft: emptyPage })
  const summary = compactSummary(empty.document).textContent ?? ''
  assert.match(summary, /1 active Microsoft risk identity/)
  assert.doesNotMatch(summary, /0 active Microsoft|records on this page|at least 0/i)
  const complete = renderNative(nativeRiskyUsersFixture(), { microsoft: microsoftLive() })
  assert.match(compactSummary(complete.document).textContent ?? '', /1 active Microsoft risk/)
  assert.doesNotMatch(compactSummary(complete.document).textContent ?? '', /records on this page/)
})
test('native contracts C42: a withheld count reads as a decision, not as a blank or a breakage', () => {
  // C42: Native supplied withholding explanations replace the legacy reason literal; withholding is a decision, not a failed request.

  const native = nativeWithheld()
  const result = renderNative(native)
  const count = assertNativeCountCopy(native, result)
  assert.equal(count.accuracy, 'WITHHELD')
  assert.equal(count.value, null)
  for (const text of [result.text, result.cardText]) {
    assert.match(text, /Not counted/)
    assert.doesNotMatch(text, /Support code|try again|0 users requiring review/i)
  }
  assert.equal(result.document.querySelector('[role="alert"]'), null)
})
test('native contracts C43: an empty list never answers the question a withheld count refused', () => {
  // C43: A native withheld empty list must not borrow the exact-zero empty state; mailbox evidence remains independent.

  const native = nativeMailbox()
  const result = renderNative(native)
  assert.equal(actionableRows(result.document).length, 0)
  const count = nativeProjection.nativeRiskyUserCount(native)
  const expected = riskyUsersView.riskyUsersEmptyState(count, false)
  assert.ok(nativeTable(result.document).textContent?.includes(expected.sentence))
  assert.doesNotMatch(nativeTable(result.document).textContent ?? '', /No users requiring review found/)
  const zero = renderNative(nativeZero())
  assert.notEqual(riskyUsersView.riskyUsersEmptyState(nativeProjection.nativeRiskyUserCount(nativeZero()), false).sentence, expected.sentence)
  assert.match(zero.text, /0 users requiring review/)
})
test('native contracts N44: what HawkView did find is rendered beside a withheld count', () => {
  // N44/C known: Covered checks are not findings. Preserve actual finding titles, deduplicate safely, and never invent mailbox or identity totals.

  const clean = nativeZero()
  const cleanResult = renderNative(clean)
  assert.doesNotMatch(cleanResult.cardText, /What HawkView did find/)
  assert.deepEqual(nativeProjection.nativeRiskyUserCount(clean).known, [])
  const actual = nativeMailbox()
  actual.count.covered = ['repeated-credential-failure']
  const anotherMailbox = structuredClone(actual.findings[0]!)
  anotherMailbox.subject.ref = '00000000-0000-4000-8000-000000000099'
  actual.findings.push(anotherMailbox)
  const result = renderNative(actual)
  assert.deepEqual(nativeProjection.nativeRiskyUserCount(actual).known, ['External mailbox forwarding'])
  for (const text of [result.text, result.cardText]) {
    assert.match(text, /What HawkView did find/)
    assert.match(text, /External mailbox forwarding/)
    assert.doesNotMatch(text, /External mailbox forwarding: 3 mailboxes/)
  }
  const unknown = nativeWithheld()
  unknown.findings[0]!.detectorId = 'UNKNOWN_FUTURE_DETECTOR'
  assert.deepEqual(nativeProjection.nativeRiskyUserCount(unknown).known, ['A check this build of HawkView does not recognise'])
})
test('native contracts N45: a check that cannot run states its scope beside the number, not elsewhere', () => {
  // N45: Native detector/event coverage replaces legacy per-check identity counts; the number keeps its scope and uncovered checks.

  const native = nativeZero()
  native.count.notCovered = [{ detectorId: 'external-mailbox-forwarding', because: 'DETECTOR_FAILED' }]
  const result = renderNative(native)
  assertNativeCountCopy(native, result)
  assert.match(result.text, /Not covered by this number/)
  assert.doesNotMatch(result.text + result.cardText, /identities evaluated|tenant coverage: \d+/i)
})
test('native contracts C46: the four evidence states never share the same words', () => {
  // C46: Native absence, exact zero, unreadable response, and withheld evaluation retain distinct UI claims rather than legacy status copy.

  const missing = renderNative(null)
  const unreadable = renderNative(nativeRiskyUsersFixture(), { contractFailed: true })
  const zero = renderNative(nativeZero())
  const partial = renderNative(nativeWithheld('UNREADABLE_NOW'))
  assert.equal(missing.document.querySelector('[role="alert"]'), null)
  assert.match(missing.text, /No current assessment|has no assessment/)
  assert.match(unreadable.document.querySelector('[role="alert"]')?.textContent ?? '', /response could not be read/)
  assert.match(zero.text, /0 users requiring review/)
  assert.match(partial.text, /Not counted/)
  for (const result of [missing, unreadable, partial]) assert.doesNotMatch(result.text, /0 users requiring review/)
})
test('native contracts N47: unavailable native reads withhold rows and totals without a retained-cache claim', () => {
  // N47: The native hook deliberately discards unavailable reads; do not preserve the legacy retained-cache claim.

  for (const options of [{ requestFailed: true }, { contractFailed: true }]) {
    const result = renderNative(nativeRiskyUsersFixture(), options)
    assert.equal(actionableRows(result.document).length, 0)
    assert.match(result.text, /Not available/)
    assert.match(result.text, /No current result can be confirmed/)
    assert.doesNotMatch(result.text, /earlier read|remain open|0 users requiring review/)
  }
  assert.equal(actionableRows(renderNative().document).length, 1)
})
test('native contracts R48: mailbox evidence is shown but visibly excluded from the count', () => {
  // R48: Genuine native MAILBOX evidence uses the existing Supporting evidence region, not a counted legacy user row.

  const native = nativeMailbox()
  const result = renderNative(native)
  assert.equal(actionableRows(result.document).length, 0)
  const context = result.document.querySelector('[aria-labelledby="risky-users-context-heading"]')
  assert.ok(context)
  assert.match(context.textContent ?? '', /Supporting evidence/)
  assert.match(context.textContent ?? '', /not.*counted|not.*user count/i)
  assert.match(context.textContent ?? '', /Native mailbox fixture/)
  const drawer = result.openNativeDrawer(native.findings[0]!.subject.ref)
  assert.equal(findingItems(drawer.document).length, 1)
  assert.match(drawer.text, /3 external destinations/)
  assert.match(drawer.text, /Configuration read/)
  assert.doesNotMatch(drawer.text, /3 users/)
})
test('native contracts C49: the surface never claims a user is safe or that HawkView acted', () => {
  // C49: Native count and evidence copy must not assert safety or completed actions, even when its number is zero.

  for (const native of [nativeZero(), nativeRiskyUsersFixture(), nativeWithheld()]) {
    const result = renderNative(native)
    assertNativeCountCopy(native, result)
    for (const text of [result.visibleText, result.visibleCardText]) {
      assert.doesNotMatch(text, /tenant is safe|user is safe|account is safe|HawkView (?:blocked|disabled|remediated)/i)
    }
  }
})
test('native contracts N50: the coverage behind the number is available on the same screen', () => {
  // N50: The native scope is detector/event based; do not recreate the legacy assessed-identity table or a tenant coverage denominator.

  const native = nativeRiskyUsersFixture()
  native.coverage[0]!.notYetCitedEvents = 7
  native.coverage[0]!.uninterpretedEvents = 11
  native.count.notCovered = [{ detectorId: 'external-mailbox-forwarding', because: 'NEVER_COLLECTED' }]
  const result = renderNative(native)
  assertNativeCountCopy(native, result)
  for (const text of [result.text, result.cardText]) {
    assert.match(text, /7 events held pending a citation/)
    assert.match(text, /11 events could not be interpreted/)
    assert.doesNotMatch(text, /18 events|identities evaluated/)
  }
})
/* -------------------------------------------------------------------------- */
/* Microsoft verdict polarity, rendered                                        */
/* -------------------------------------------------------------------------- */

function microsoftPanel(document: any) {
  const panel = document.querySelector(
    '[aria-labelledby="microsoft-channel-heading"]'
  )
  assert.ok(panel)
  return panel
}

test('native contracts P51: a sign-in Microsoft cleared is never rendered among its detections', () => {
  // P51: Polarity helpers and a real matched drawer replace the removed legacy Microsoft record panel; a cleared sign-in is never active.

  const view = adapter.adaptMicrosoftRiskyUsersResponse(microsoftMixedVerdicts())
  const groups = riskyUsersView.microsoftRecordsByPolarity(view)
  assert.equal(groups.ACTIVE_RISK.length, 2)
  assert.equal(groups.CLEARED.length, 1)
  assert.equal(groups.CLOSED.length, 1)
  assert.equal(groups.UNRECOGNISED.length, 1)
  assert.ok(!groups.ACTIVE_RISK.some(user => user.riskDetail === 'aiConfirmedSigninSafe'))
  assert.match(riskyUsersView.microsoftVerdictDetail(groups.CLEARED[0]!), /automated assessment concluded this sign-in was safe/)
  assertIndependentPair()
})
test('native contracts P52: an unrecognised verdict renders as unrecognised, not as a risk', () => {
  // P52: Unknown Microsoft verdicts remain unrecognised in the grouping contract, never promoted to active risk by the native summary.

  const microsoft = microsoftMixedVerdicts()
  const view = adapter.adaptMicrosoftRiskyUsersResponse(microsoft)
  const groups = riskyUsersView.microsoftRecordsByPolarity(view)
  assert.equal(groups.UNRECOGNISED.length, 1)
  assert.equal(riskyUsersView.microsoftPolarityLabel.UNRECOGNISED, 'Verdict not recognised')
  assert.ok(!groups.ACTIVE_RISK.includes(groups.UNRECOGNISED[0]!))
  const result = renderNative(nativeRiskyUsersFixture(), { microsoft })
  assert.match(compactSummary(result.document).textContent ?? '', /2 identities have active Microsoft-risk evidence requiring review/)
  assertIndependentPair()
})
test('native contracts P53: Microsoft automatic remediation is not shown as human negligence', () => {
  // P53: Actor-aware Microsoft details replace old panel text; automatic outcomes must not imply administrator negligence.

  const view = adapter.adaptMicrosoftRiskyUsersResponse(microsoftMixedVerdicts())
  const groups = riskyUsersView.microsoftRecordsByPolarity(view)
  const automatic = { ...groups.CLOSED[0]!, riskDetail: 'aiConfirmedSigninSafe' }
  assert.equal(riskyUsersView.microsoftVerdictPolarity(automatic), 'CLEARED')
  assert.match(riskyUsersView.microsoftVerdictDetail(automatic), /automated assessment/)
  assert.doesNotMatch(riskyUsersView.microsoftVerdictDetail(automatic), /administrator/i)
  assert.match(riskyUsersView.microsoftVerdictDetail(groups.CLOSED[0]!), /administrator dismissed/i)
  assertIndependentPair()
})
test('native contracts P54: a withheld risk level says so instead of reading as no risk', () => {
  // P54: Withheld Microsoft levels stay active-but-undisclosed in helpers and separate native summary, never read as no risk.

  const microsoft = microsoftMixedVerdicts()
  const view = adapter.adaptMicrosoftRiskyUsersResponse(microsoft)
  const hidden = riskyUsersView.microsoftRecordsByPolarity(view).ACTIVE_RISK.find(user => user.riskLevel === 'hidden')
  assert.ok(hidden)
  assert.match(riskyUsersView.microsoftRiskLevelLabel(hidden.riskLevel), /Detected.*level requires Entra ID P2/)
  assert.equal(riskyUsersView.microsoftLevelsHidden(view), true)
  assert.match(compactSummary(renderNative(nativeRiskyUsersFixture(), { microsoft }).document).textContent ?? '', /2 identities have active Microsoft-risk evidence requiring review/)
  const pair = nativeMicrosoftPair()
  pair.microsoft.users[0]!.riskLevel = 'hidden'
  assert.match(renderNative(pair.native, { microsoft: pair.microsoft }).openNativeDrawer().text, /Active risk reported by Microsoft/)
})
test('native contracts P55: no raw Microsoft identifier is ever painted on screen', () => {
  // P55: Raw Microsoft provider IDs remain absent from the native table and real drawer, including an actually correlated active record.

  const pair = nativeMicrosoftPair()
  pair.microsoft.users[0]!.id = 'SYNTHETIC_PRIVATE_PROVIDER_RECORD'
  const result = renderNative(pair.native, { microsoft: pair.microsoft })
  for (const text of [result.text, result.openNativeDrawer().text]) {
    assert.doesNotMatch(text, /SYNTHETIC_PRIVATE_PROVIDER_RECORD/)
    assert.ok(!text.includes(pair.native.findings[0]!.subject.ref))
  }
  assert.match(result.openNativeDrawer().text, /Active risk reported by Microsoft/)
})
test('a count with no number is words, never a dash or a blank', () => {
  const withheld = assessmentFixture(false)
  withheld.summary.currentUsers = {
    value: null,
    accuracy: 'UNKNOWN',
    reason: 'UNRESOLVED_SUBJECT_IDENTITY',
  }
  for (const [label, rendered] of [
    ['withheld', render(withheld)],
    ['failed read', render(assessmentFixture(true), { requestFailed: true })],
  ] as const) {
    for (const text of [rendered.text, rendered.cardText]) {
      // A dash reads as zero to every technician who has used a dashboard.
      assert.doesNotMatch(text, /—s*(Not|$)/, label)
      assert.match(text, /Not counted|Not available/, label)
    }
  }
})

/* -------------------------------------------------------------------------- */
/* Naming discipline in the copy this surface owns                            */
/* -------------------------------------------------------------------------- */

test('our own copy never borrows Microsoft detection names', () => {
  // A technician who has read Microsoft's documentation reads these names as
  // Microsoft's claim, which is far stronger than ours: Microsoft's password
  // spray confirms credential validation from cross-tenant telemetry, its
  // impossible travel is a behavioural model with VPN suppression, and its
  // leaked credentials means the credential was validated against the tenant's
  // current password hashes. We do none of those things.
  //
  // Finding titles arrive from the server and cannot be policed here, but every
  // string this surface owns can be, and this is what stops them drifting.
  const owned = [
    '../../components/identity-risk/risky-users-section.tsx',
    '../../components/identity-risk/risky-users-count-card.tsx',
    './risky-users-view.ts',
  ].map((path) => readFileSync(new URL(path, import.meta.url), 'utf8'))

  for (const source of owned) {
    for (const borrowed of [
      /password spray/i,
      /impossible travel/i,
      /leaked credential/i,
      /anonymous IP address/i,
      /malware linked IP/i,
    ]) {
      assert.doesNotMatch(source, borrowed, String(borrowed))
    }
  }
})

test('the surface never offers to write back to Microsoft', () => {
  // Confirming a compromise in Entra alters Microsoft's ML training and sets
  // that user high-risk tenant-wide. That is a technician's deliberate
  // decision, never an automated consequence of one of our detectors firing.
  const owned = [
    '../../components/identity-risk/risky-users-section.tsx',
    '../../components/identity-risk/risky-users-count-card.tsx',
    '../api/risky-users-hooks.ts',
  ].map((path) => readFileSync(new URL(path, import.meta.url), 'utf8'))

  for (const source of owned) {
    for (const mutation of [
      /apiClient.(post|put|patch|delete)/,
      /useMutation/,
      /confirmCompromised/i,
      /dismissRisk/i,
    ]) {
      assert.doesNotMatch(source, mutation, String(mutation))
    }
  }
})

test('native contracts C59: a zero never renders as a clean tenant while findings sit below it', () => {
  // C59: A native person count does not erase mailbox findings; zero people is not an all-clear when supporting evidence exists.

  const native = nativeMailbox()
  native.count.accuracy = 'EXACT'
  native.count.value = 0
  native.withheld = []
  const result = renderNative(native)
  assert.equal(actionableRows(result.document).length, 0)
  assertNativeCountCopy(native, result)
  for (const text of [result.text, result.cardText]) {
    assert.match(text, /What HawkView did find/)
    assert.match(text, /External mailbox forwarding/)
    assert.doesNotMatch(text, /all users are safe|no findings anywhere/i)
  }
  assert.ok(result.document.querySelector('[aria-labelledby="risky-users-context-heading"]'))
})
test('native contracts R60: a user both systems reported shows both, and neither is folded in', () => {
  // R60: A correlated native user has independent source badges and a real drawer, not a legacy merged assessment row.
  assertIndependentPair()
})
test('native contracts R61: Microsoft looked and did not report this user is a distinct sentence', () => {
  // R61: NOT_REPORTED requires comparable Microsoft evidence; unlike NOT_COMPARABLE it may state no active record but never safety.

  assertNoActiveMicrosoftControl()
  assertNoMicrosoftConclusion()
})
test('native contracts N62: per-check identity counts cannot be read as tenant coverage', () => {
  // N62: Native detector/event scope cannot become a per-check identity population or tenant-wide denominator.

  const native = nativeZero()
  const result = renderNative(native)
  assertNativeCountCopy(native, result)
  for (const text of [result.text, result.cardText]) {
    assert.match(text, /Every event this run examined/)
    assert.doesNotMatch(text, /\d+ identities evaluated|of \d+ identities|all identities examined/i)
    assert.match(text, /investigation leads, not confirmed compromise/i)
  }
})
test('native contracts N63: a corroborated row never reads as a combined judgement', () => {
  // N63: Independent native/Microsoft signals replace a corroborated legacy judgement; no combined score is introduced.
  assertIndependentPair()
})
test('native contracts R64: a person and a mailbox sharing a name are visibly different subjects', () => {
  // R64: Native USER and MAILBOX subjects with one display name remain distinct regions and drawer evidence, never merged by label.

  const native = nativeRiskyUsersFixture()
  const mailbox = nativeMailbox().findings[0]!
  mailbox.subject.displayName = native.findings[0]!.subject.displayName
  native.findings.push(mailbox)
  const result = renderNative(native)
  assert.equal(actionableRows(result.document).length, 1)
  const context = result.document.querySelector('[aria-labelledby="risky-users-context-heading"]')
  assert.ok(context)
  assert.match(context.textContent ?? '', /Native fixture user/)
  assert.match(compactSummary(result.document).textContent ?? '', /1 users requiring review/)
  assert.match(result.openNativeDrawer(native.findings[0]!.subject.ref).text, /10 rejected sign-ins/)
  assert.match(result.openNativeDrawer(mailbox.subject.ref).text, /3 external destinations/)
})
test('native contracts C65: several withholding reasons all reach the screen', () => {
  // C65: Every supplied native withholding reason reaches both count surfaces, instead of selecting one legacy reason.

  const native = nativeWithheld()
  native.withheld.push({ stream: 'synthetic.sign-ins', because: 'UNINTERPRETED_EVENTS' })
  const result = renderNative(native)
  const count = assertNativeCountCopy(native, result)
  assert.equal(count.reasons.length, 2)
  for (const text of [result.text, result.cardText]) assert.ok(count.reasons.every(reason => text.includes(reason)))
  const healthy = renderNative()
  for (const reason of count.reasons) assert.ok(!healthy.text.includes(reason))
})
test('the no-safe-verdict boundary is on screen, not only announced', () => {
  // It is the product's central claim about what these numbers are. On the
  // overview card it lived in a visually-hidden label, so a sighted technician
  // never met it — and on a lower-bound count the visible caption says nothing
  // about leads versus confirmed compromise either.
  const bounded = assessmentFixture(true)
  bounded.meta.capability = 'PARTIAL'
  bounded.meta.freshness = 'UNKNOWN'
  bounded.meta.limitation = 'One evidence source is incomplete.'
  bounded.sources[1].status = 'PARTIAL'
  bounded.sources[1].reasonCode = 'INCOMPLETE_WINDOW'
  bounded.sources[1].freshness = 'UNKNOWN'
  bounded.rules[1].status = 'PARTIAL'
  bounded.rules[1].reasonCode = 'INCOMPLETE_WINDOW'
  bounded.summary.currentUsers = { value: 1, accuracy: 'AT_LEAST' }

  for (const [label, value] of [
    ['exact count', assessmentFixture(true)],
    ['lower bound', bounded],
  ] as const) {
    const { visibleCardText, visibleText } = render(value)
    assert.match(
      visibleCardText,
      /Investigation leads, not confirmed compromise/,
      label
    )
    assert.match(visibleText, /investigation lead/i, label)
  }
})

test('a hidden label does not repeat what its visible partner already says', () => {
  // The label stands in for a glyph a screen reader cannot voice. It used to
  // carry the headline as well, which the headline's own visible element
  // already announces — so a screen reader heard the headline twice.
  const { cardDocument } = render(assessmentFixture(true))
  const labels = [...cardDocument.querySelectorAll('.sr-only')].map(
    (label: any) => label.textContent?.trim() ?? ''
  )
  assert.ok(labels.length > 0, 'the card has something to check')
  for (const label of labels) {
    assert.doesNotMatch(label, /Risky user/, label)
  }
  // What it does carry is the number the glyph withholds.
  assert.ok(labels.includes('1'))
})

test('native contracts P68: the compact summary names active Microsoft risk without a combined score', () => {
  // P68: The compact summary answers active Microsoft risk with attribution, not the removed panel heading or a merged score.

  const result = assertIndependentPair()
  assert.match(compactSummary(result.document).textContent ?? '', /active Microsoft(?:-| )risk/)
  assert.match(result.openNativeDrawer().text, /Microsoft Entra ID Protection/)
  assert.match(result.text, /never combined into a single score/)
})
/* -------------------------------------------------------------------------- */
/* Tenant and session scoping                                                 */
/* -------------------------------------------------------------------------- */

/** Compiles the real channel hook and captures the query keys it builds. */
function capturedQueries(tenantId: string, cacheScope: string) {
  const queries: Record<string, any>[] = []
  const hooks = compile('../api/identity-risk-hooks.ts', {
    '@tanstack/react-query': {
      useQuery: (query: Record<string, any>) => {
        queries.push(query)
        return {
          data: undefined,
          isError: false,
          isLoading: true,
          refetch: async () => undefined,
        }
      },
    },
    '@/components/providers/auth-provider': { useAuth: () => ({ cacheScope }) },
    './client': {
      apiClient: {
        get: () => {
          throw new Error('No network requests in UI tests')
        },
      },
    },
    './mailbox-investigation': { parseInvestigationAccess: () => false },
    '@/lib/identity-risk/adapter': adapter,
    // The only real React hook this reads is useMemo, and the query keys are
    // built before it. Evaluating it eagerly is enough to collect them without
    // standing up a renderer for an assertion about cache keys.
    react: { ...React, useMemo: (factory: () => unknown) => factory() },
  })
  hooks.useIdentityRiskChannels(tenantId, true)
  return queries.map((query) => query.queryKey)
}

test('every read is keyed to the exact tenant and the authorised session', () => {
  // One MSP technician holds many customers open. A cache key that omits
  // either would serve one customer's assessment under another's heading —
  // and this surface exists to be acted on, so that is the worst failure it
  // has.
  //
  // This lived only in a test that renders the superseded section, which the
  // app no longer routes to. Deleting that dead component — which somebody
  // should — would have taken the guarantee's only coverage with it, silently.
  for (const key of capturedQueries('tenant-a', 'session-1')) {
    assert.deepEqual(key.slice(0, 3), [
      'identity-risk',
      'session-1',
      'tenant-a',
    ])
  }

  // Both halves are load-bearing: change either and the key changes.
  const [assessmentA] = capturedQueries('tenant-a', 'session-1')
  const [assessmentB] = capturedQueries('tenant-b', 'session-1')
  const [otherSession] = capturedQueries('tenant-a', 'session-2')
  assert.notDeepEqual(assessmentA, assessmentB)
  assert.notDeepEqual(assessmentA, otherSession)

  // And the two channels are not keyed alike, so one cannot serve the other.
  const keys = capturedQueries('tenant-a', 'session-1')
  assert.equal(keys.length, 2)
  assert.notDeepEqual(keys[0], keys[1])
})

test('native contracts P70: a reporting Microsoft channel with no records says so, rather than showing nothing', () => {
  // P70: A complete available empty Microsoft snapshot can report zero active risk, independently of HawkView and without a safety verdict.

  const pair = nativeMicrosoftPair()
  pair.microsoft.users = []
  pair.microsoft.microsoftRiskSummary = exactMicrosoftSummary(0, 0)
  const result = renderNative(pair.native, { microsoft: pair.microsoft })
  const summary = compactSummary(result.document).textContent ?? ''
  assert.match(summary, /0 active Microsoft risk/)
  assert.match(summary, /1 users requiring review/)
  assert.doesNotMatch(summary, /tenant is safe|all-clear/i)
  assertNoActiveMicrosoftControl()
})
test('native contracts P71: an unavailable Microsoft channel adds no empty-count line', () => {
  // P71: An unavailable Microsoft channel cannot earn a numeric empty count from an empty array.

  const result = renderNative(nativeRiskyUsersFixture(), { microsoft: microsoftWithoutP2() })
  const summary = compactSummary(result.document).textContent ?? ''
  assert.match(summary, /Microsoft risk status unavailable/)
  assert.doesNotMatch(summary, /0 active Microsoft risk/)
  assert.equal(actionableRows(result.document).length, 1)
})
test('native contracts P72: an unconfirmed empty Microsoft result never becomes an authoritative zero', () => {
  // P72: Unconfirmed empty Microsoft pages and unavailable reads never become authoritative zero, unlike a complete reporting control.

  for (const microsoft of [{ ...microsoftLive(true), users: [] }, microsoftWithoutP2()]) {
    const result = renderNative(nativeRiskyUsersFixture(), { microsoft })
    assert.doesNotMatch(compactSummary(result.document).textContent ?? '', /0 active Microsoft risk/)
  }
  const complete = renderNative(nativeRiskyUsersFixture(), {
    microsoft: {
      ...microsoftLive(),
      users: [],
      microsoftRiskSummary: exactMicrosoftSummary(0, 0),
    },
  })
  assert.match(compactSummary(complete.document).textContent ?? '', /0 active Microsoft risk/)
})
test('native contracts S73: two reasons with different dates never share one', () => {
  // S73: Real native drawer items replace collapsed legacy row text; each signal retains its own count and instant.

  const native = nativeRiskyUsersFixture()
  native.findings[0]!.signals = [
    nativeSignal('PASSWORD_REJECTED', 12, 'EVENT_OCCURRED', '2026-09-08T21:01:00.000Z'),
    nativeSignal('LOCKED_OUT_AFTER_REPEATED_FAILURES', 462, 'EVENT_OCCURRED', '2026-09-08T21:58:00.000Z'),
  ]
  const drawer = renderNative(native).openNativeDrawer()
  const items = findingItems(drawer.document)
  assert.equal(items.length, 2)
  assert.match(items[0]!.textContent ?? '', /12 rejected sign-ins/)
  assert.match(items[1]!.textContent ?? '', /462 matching events/)
  const dates = native.findings[0]!.signals.map(signal => new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(signal.latest!.at)))
  assert.notEqual(dates[0], dates[1])
  assert.ok(items[0]!.textContent?.includes(dates[0]!))
  assert.ok(!items[0]!.textContent?.includes(dates[1]!))
  assert.ok(items[1]!.textContent?.includes(dates[1]!))
  assert.ok(!items[1]!.textContent?.includes(dates[0]!))
  assert.doesNotMatch(drawer.text, /474/)
})
test('native contracts S74: a setting is never counted as though it were a sequence of events', () => {
  // S74: Native latest.kind determines configuration-read timing; the old rule-name heuristic is not carried forward.

  const native = nativeMailbox()
  const item = findingItems(renderNative(native).openNativeDrawer().document)[0]!
  assert.match(item.textContent ?? '', /3 external destinations/)
  assert.match(item.textContent ?? '', /Configuration read/)
  assert.doesNotMatch(item.textContent ?? '', /Last observed/)
})
test('native contracts N75: an event check keeps the event vocabulary', () => {
  // N75: Native event timing replaces the legacy collapsed event sentence, using the signal's own kind and volume.

  const drawer = renderNative().openNativeDrawer()
  const item = findingItems(drawer.document)[0]!
  assert.match(item.textContent ?? '', /10 rejected sign-ins/)
  assert.match(item.textContent ?? '', /Last observed/)
  assert.doesNotMatch(item.textContent ?? '', /Configuration read/)
})
test('native contracts N76: an unrecognised rule never lets its identifier become the description', () => {
  // N76: Unknown native detector codes are technical metadata only, not descriptions, guidance, or invented evidence units.

  const native = nativeRiskyUsersFixture()
  native.findings[0]!.detectorId = 'FUTURE_DETECTOR_<b>UNKNOWN</b>'
  native.findings[0]!.signals = [nativeSignal('FUTURE_SIGNAL', 9)]
  const result = renderNative(native)
  const drawer = result.openNativeDrawer()
  assert.match(primaryText(drawer.document), /Security activity needs review/)
  assert.doesNotMatch(primaryText(drawer.document), /FUTURE_DETECTOR|FUTURE_SIGNAL|9 records/)
  const technical = [...drawer.document.querySelectorAll('details')].find(detail => detail.querySelector('summary')?.textContent === 'Technical details')
  assert.ok(technical)
  assert.ok(technical.textContent?.includes(native.findings[0]!.detectorId))
  assert.equal(technical.querySelector('b'), null)
  assert.doesNotMatch(nativeTable(result.document).textContent ?? '', /FUTURE_DETECTOR|FUTURE_SIGNAL/)
})
test('native contracts S77: a check that ran without a time says so, and is not called unreported', () => {
  // S77: A genuine native dateless finding is evidence without a timestamp, not failed collection or an unreported finding.

  const native = nativeRiskyUsersFixture()
  native.findings[0]!.signals[0]!.latest = null
  const result = renderNative(native)
  assert.match(nativeTable(result.document).textContent ?? '', /No time recorded/)
  const drawer = result.openNativeDrawer()
  assert.match(drawer.text, /No evidence time recorded/)
  assert.match(drawer.text, /Dateless evidence/)
  assert.doesNotMatch(drawer.text, /Last observed.*Not reported|Latest evidence.*Not reported|Evaluated.*Not reported/)
  const dated = renderNative().openNativeDrawer()
  assert.match(dated.text, /Current evidence/)
  assert.doesNotMatch(dated.text, /No evidence time recorded/)
})
test('a row with no time sorts after dated rows rather than being coerced to one', () => {
  // Scope of this guard, stated because mutation testing narrowed it: the
  // empty-string fallback it replaced already produced this order, so reverting
  // to that does not fail here. What fails is any filler that puts the row at a
  // definite position — "now" or a forward date — and any change of sort
  // direction, which the old pairing of filler and direction would have
  // silently inverted.
  const value = assessmentFixture(true)
  value.users = [
    assessmentUser('HV-ID-AUTH-010.v1', 'a'),
    assessmentUser('HV-ID-AUTH-010.v1', 'b'),
  ]
  value.rules[0].assessedIdentities = 2
  value.rules[0].matchedIdentities = 2
  value.summary.currentUsers.value = 2
  const { document } = render(value, {
    afterAdapt: (adapted) => {
      // Same priority, so the date is the only key left. The first user loses
      // its time; a coerced empty string would sort it first, not last.
      for (const finding of adapted.users[0].findings) finding.lastSeen = null
    },
  })
  const names = (
    Array.from(
      document.querySelectorAll(
        '[aria-labelledby="risky-users-table-heading"] tbody tr'
      )
    ) as Element[]
  ).map((row) => row.textContent ?? '')
  assert.equal(names.length, 2)
  assert.ok(
    !names[0].includes('No time recorded'),
    'the undated row sorted ahead of a dated one'
  )
  assert.ok(names[1].includes('No time recorded'))
})

test('native contracts N79: an exact zero over a population never examined is not a clean tenant', () => {
  // N79: NOTHING_APPLICABLE or absent scope cannot become a clean tenant; native scope does not invent assessed-identity populations.

  const noApplicable = nativeWithheld('NOTHING_APPLICABLE')
  noApplicable.findings = []
  noApplicable.coverage = []
  const result = renderNative(noApplicable)
  assertNativeCountCopy(noApplicable, result)
  assert.match(result.text, /Not counted/)
  assert.doesNotMatch(result.text, /0 users requiring review|identities evaluated/)
  const emptyScope = nativeZero()
  emptyScope.coverage = []
  const missingScope = renderNative(emptyScope)
  assert.match(missingScope.text, /did not report what it examined/)
  assert.match(missingScope.cardText, /cannot be read as covering any particular scope/)
})
test('native contracts C80: a count with no findings behind it is a gap, never an all-clear', () => {
  // C80: A native positive count with no delivered findings remains a delivery gap, distinct from both an empty count and a partial list.

  const native = nativeZero()
  native.count.value = 4
  const result = renderNative(native)
  const count = nativeProjection.nativeRiskyUserCount(native)
  assert.equal(count.listCoverage, 'NONE_DELIVERED')
  assert.equal(actionableRows(result.document).length, 0)
  assert.ok(nativeTable(result.document).textContent?.includes(riskyUsersView.riskyUsersEmptyState(count, false).sentence))
  assert.match(result.cardText, /did not come back with it/)
  assert.doesNotMatch(result.text, /0 users requiring review|Showing 0 of 0/)
  const delivered = renderNative()
  assert.doesNotMatch(delivered.cardText, /did not come back with it/)
})
const withSignals = (signals: unknown) => {
  const value = assessmentFixture(true)
  value.users[0].findings[0].title = 'Repeated invalid credentials'
  value.users[0].findings[0].evidenceCount = 474
  ;(value.users[0].findings[0] as any).signals = signals
  return value
}

const rowText = (document: Document) =>
  document.querySelector(
    '[aria-labelledby="risky-users-table-heading"] tbody tr'
  )?.textContent ?? ''

test('native contracts S81: one finding resting on two signals renders two reasons, not one', () => {
  // S81: One native finding with two signals yields exactly two real drawer reasons, never a fabricated aggregate third reason.

  const native = nativeRiskyUsersFixture()
  native.findings[0]!.signals = [nativeSignal('LOCKED_OUT_AFTER_REPEATED_FAILURES', 462), nativeSignal('PASSWORD_REJECTED', 12, 'EVENT_OCCURRED', '2026-09-08T21:01:00.000Z')]
  const drawer = renderNative(native).openNativeDrawer()
  const items = findingItems(drawer.document)
  assert.equal(items.length, 2)
  assert.match(items[0]!.textContent ?? '', /462 matching events/)
  assert.match(items[1]!.textContent ?? '', /12 rejected sign-ins/)
  assert.doesNotMatch(drawer.text, /474/)
  assert.equal(drawer.document.querySelectorAll('h4').length, 2)
})
test('native contracts S82: a state signal is not described in the vocabulary of events', () => {
  // S82: Native state signals retain configured-state units and read timing in the opened drawer, not legacy event prose.

  const native = nativeMailbox()
  const drawer = renderNative(native).openNativeDrawer()
  const item = findingItems(drawer.document)[0]!
  assert.match(item.textContent ?? '', /3 external destinations/)
  assert.match(item.textContent ?? '', /Configuration read/)
  assert.doesNotMatch(item.textContent ?? '', /Last observed|3 events/)
})
test('native contracts S83: unknown signal codes stay in escaped technical details without invented units', () => {
  // S83: An unknown signal's bounded code may appear as escaped technical metadata, never as primary copy or an invented count unit.

  const native = nativeRiskyUsersFixture()
  native.findings[0]!.signals = [nativeSignal('UNKNOWN_SIGNAL_<b>FUTURE</b>', 9)]
  const drawer = renderNative(native).openNativeDrawer()
  assert.doesNotMatch(primaryText(drawer.document), /UNKNOWN_SIGNAL|9 records|9 rejected sign-ins/)
  const technical = [...drawer.document.querySelectorAll('details')].find(detail => detail.querySelector('summary')?.textContent === 'Technical details')
  assert.ok(technical)
  assert.ok(technical.textContent?.includes(native.findings[0]!.signals[0]!.signal))
  assert.equal(technical.querySelector('b'), null)
})
test('native contracts N84: missing empty duplicate or malformed native signals fail closed', () => {
  // N84: Unlike the legacy optional-signals fallback, native findings require nonempty, unique, valid signals and malformed input fails closed.

  const adapt = require('./native-assessment.ts').adaptNativeAssessment as typeof import('./native-assessment.ts').adaptNativeAssessment
  const native = nativeRiskyUsersFixture()
  assert.ok(adapt(nativeWire(native)), 'valid native wire is the non-vacuous control')
  for (const signals of [undefined, [], [nativeSignal(), nativeSignal()], [{ ...nativeSignal(), count: -1 }]]) {
    const wire = nativeWire(native)
    const item = wire.findings.items[0]! as Record<string, unknown>
    if (signals === undefined) delete item.signals
    else item.signals = signals
    const adapted = adapt(wire)
    assert.equal(adapted, null)
    const result = renderNative(adapted, { contractFailed: true })
    assert.equal(actionableRows(result.document).length, 0)
    assert.match(result.text, /Not available/)
    assert.doesNotMatch(result.text, /0 users requiring review/)
  }
})
test('native contracts S85: a signal evaluated and empty is distinguishable from one never evaluated', () => {
  // S85: Evaluated-zero native signals are not absent signals; render none recorded without fabricating an occurrence time or a third signal.

  const native = nativeRiskyUsersFixture()
  native.findings[0]!.signals = [
    nativeSignal('LOCKED_OUT_AFTER_REPEATED_FAILURES', 0, 'EVENT_OCCURRED', null),
    nativeSignal('PASSWORD_REJECTED', 7),
  ]
  const drawer = renderNative(native).openNativeDrawer()
  const items = findingItems(drawer.document)
  assert.equal(items.length, 2)
  assert.match(items[0]!.textContent ?? '', /none recorded/)
  assert.doesNotMatch(items[0]!.textContent ?? '', /0 lockouts|Sep|2026/)
  assert.match(items[1]!.textContent ?? '', /7 rejected sign-ins/)
  assert.doesNotMatch(drawer.text, /external destinations/)
})
test('native contracts S86: the kind comes off the value even when the name suggests otherwise', () => {
  // S86: Inverted signal names cannot override latest.kind; each real drawer reason keeps its own timing semantics.

  const native = nativeRiskyUsersFixture()
  native.findings[0]!.signals = [
    nativeSignal('EXTERNAL_FORWARDING_CONFIGURED', 3, 'EVENT_OCCURRED'),
    nativeSignal('PASSWORD_REJECTED', 5, 'STATE_OBSERVED'),
  ]
  const items = findingItems(renderNative(native).openNativeDrawer().document)
  assert.equal(items.length, 2)
  assert.match(items[0]!.textContent ?? '', /3 external destinations/)
  assert.match(items[0]!.textContent ?? '', /Last observed/)
  assert.doesNotMatch(items[0]!.textContent ?? '', /Configuration read/)
  assert.match(items[1]!.textContent ?? '', /5 rejected sign-ins/)
  assert.match(items[1]!.textContent ?? '', /Configuration read/)
  assert.doesNotMatch(items[1]!.textContent ?? '', /Last observed/)
})
test('native contracts C87: a page of a list is never presented as the list', () => {
  // C87: The native structured total and list coverage replace a row-length denominator; exact, lower-bound, withheld and missing lists remain distinct.

  for (const flag of [true, false]) {
    const native = nativeRiskyUsersFixture()
    native.count.value = 9
    native.complete = !flag
    const result = renderNative(native)
    assert.match(nativeTable(result.document).textContent ?? '', /Showing 1 of 9 reported users/)
    assert.match(compactSummary(result.document).textContent ?? '', /1 detected by HawkView shown; 9 reported users/)
    assert.doesNotMatch(compactSummary(result.document).textContent ?? '', /total that is not available/)
    assert.match(result.cardText, /longer than what came back with it/)
  }
  const lower = nativeRiskyUsersFixture()
  lower.count.accuracy = 'AT_LEAST'
  lower.count.value = 9
  lower.complete = false
  assert.match(nativeTable(renderNative(lower).document).textContent ?? '', /Showing 1; at least 9 reported users/)
  assert.match(nativeTable(renderNative(nativeWithheld()).document).textContent ?? '', /1 shown; complete total unavailable/)
  const complete = renderNative()
  assert.match(nativeTable(complete.document).textContent ?? '', /Showing 1 of 1 reported users/)
  assert.doesNotMatch(complete.cardText, /longer than what came back with it/)
})
test('native truthfulness: unavailable reads never claim retained rows', () => {
  for (const options of [{ requestFailed: true }, { contractFailed: true }]) {
    const result = render(assessmentFixture(true), options)
    const alert = result.document.querySelector('[role="alert"]')
    assert.ok(alert, 'a failed read must disclose its unavailable state')
    assert.match(alert.textContent ?? '', /No current result can be confirmed/)
    assert.doesNotMatch(alert.textContent ?? '', /Users below are from an earlier read/)
    const table = result.document.querySelector('[aria-labelledby="risky-users-table-heading"]')
    assert.ok(table)
    assert.equal(table.querySelectorAll('tbody tr button').length, 0,
      'the existing hook withholds rows; the banner must not promise cached rows')
    assert.match(result.text, /Not available/)
    assert.doesNotMatch(result.text, /\b0 (?:users requiring review|detected by HawkView)\b/)
  }

  const missing = render(assessmentFixture(true), { notReported: true })
  assert.match(missing.text, /Not available/)
  assert.doesNotMatch(missing.text, /\b0 (?:users requiring review|detected by HawkView)\b/)

  const healthy = render(assessmentFixture(true))
  assert.equal(healthy.document.querySelector('[role="alert"]'), null)
  assert.equal(healthy.document.querySelectorAll(
    '[aria-labelledby="risky-users-table-heading"] tbody tr button'
  ).length, 1, 'the healthy control must still render its actionable row')
  assert.match(healthy.text, /1 detected by HawkView/)
})

test('native truthfulness: compact summary shows supplied withholding explanations', () => {
  const value = assessmentFixture(false)
  value.summary.currentUsers = {
    value: null,
    accuracy: 'UNKNOWN',
    reasons: ['UNRESOLVED_SUBJECT_IDENTITY', 'UNINTERPRETABLE_EVIDENCE'],
  }
  const native = nativeAssessmentFixture(
    adapter.adaptRiskAssessmentResponse(value, assessmentNow)
  )
  const expected: riskyUsersView.RiskyUserCount =
    require('./native-view.ts').nativeRiskyUserCount(native)
  assert.equal(expected.value, null)
  assert.equal(expected.reasons.length, 2, 'two distinct supplied reasons are required')
  const result = render(value)
  for (const [label, text] of [['section', result.text], ['card', result.cardText]]) {
    assert.ok(text.includes(expected.caption), `${label}: supplied caption must be visible`)
    for (const reason of expected.reasons) {
      assert.ok(text.includes(reason), `${label}: every supplied reason must be visible`)
    }
    assert.doesNotMatch(text, /\b0 (?:users requiring review|detected by HawkView)\b/)
  }

  const healthyValue = assessmentFixture(true)
  const healthyCount: riskyUsersView.RiskyUserCount = require('./native-view.ts')
    .nativeRiskyUserCount(nativeAssessmentFixture(
      adapter.adaptRiskAssessmentResponse(healthyValue, assessmentNow)
    ))
  const healthy = render(healthyValue)
  assert.ok(healthy.text.includes(healthyCount.caption))
  assert.match(healthy.text, /1 detected by HawkView/)
  for (const reason of expected.reasons) {
    assert.ok(!healthy.text.includes(reason), 'a healthy control must not inherit a withheld reason')
  }
})
