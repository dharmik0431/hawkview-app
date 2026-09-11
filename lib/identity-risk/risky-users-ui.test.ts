import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import test from 'node:test'
import * as adapter from './adapter.ts'
import * as presentation from './presentation.ts'
import * as riskyUsersView from './risky-users-view.ts'
import {
  assessmentFixture,
  assessmentNow,
  assessmentUser,
  at,
} from './assessment-test-fixtures.ts'
import { syntheticRiskResponses, unavailableMeta } from './test-fixtures.ts'

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
  }
}

function render(
  assessmentValue: unknown = assessmentFixture(true),
  options: {
    microsoft?: unknown
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

  const nativeViewModule = require('./native-view.ts')
  const riskPresentationMapper = require('./risk-presentation-mapper.ts')

  const uiMocks = {
    '@/lib/identity-risk/presentation': presentation,
    '@/lib/identity-risk/risky-users-view': riskyUsersView,
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
      useNativeRiskyUsersRead: () => identityRiskHooks.useIdentityRiskChannels(),
    },
  })
  const drawer = compile(
    '../../components/identity-risk/risk-assessment-drawer.tsx',
    { ...uiMocks, '@/lib/api/identity-risk-hooks': identityRiskHooks }
  )
  const section = compile(
    '../../components/identity-risk/risky-users-section.tsx',
    {
      ...uiMocks,
      '@/lib/api/risky-users-hooks': hooks,
      './risk-assessment-drawer': drawer,
      '@/components/identity-risk/fleet-risk-assessment-drawer': {
        FleetRiskAssessmentDrawer: () => null,
      },
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
  }
}

/* -------------------------------------------------------------------------- */

test('the list gives a technician the four things they triage on', () => {
  const { document, text } = render()
  const headers = [...document.querySelectorAll('th')].map(
    (cell) => cell.textContent?.trim() ?? ''
  )
  assert.deepEqual(headers.slice(0, 4), [
    'User',
    'Detected by',
    'HawkView priority',
    'Latest of any reason',
  ])
  assert.match(text, /Synthetic identity/)
  assert.match(text, /Repeated invalid credentials/)
  assert.match(text, /Low/)
  // And a way into the evidence for that user.
  assert.ok(
    [...document.querySelectorAll('button')].some((button) =>
      /Investigate/.test(button.textContent ?? '')
    )
  )
})

test('the opaque subject reference is shortened but stays available', () => {
  const { document } = render()
  const cell = document.querySelector('tbody tr td')
  assert.ok(cell)
  // Selected by its title attribute rather than by position, so adding a
  // line to the cell does not silently retarget the assertion.
  const reference = cell!.querySelector('p[title]')
  assert.ok(reference)
  // Shown short, so it does not crowd out the name and the reasons.
  assert.match(reference!.textContent ?? '', /^hvr1_subject_[0-9a-f]{10}…$/)
  // The full value is still there to copy or search on.
  assert.match(
    reference!.getAttribute('title') ?? '',
    /^hvr1_subject_[0-9a-f]{64}$/
  )
})

test('the P2 gap is shown once as a first-class state, not as an empty column', () => {
  const { document, text } = render()
  const panel = document.querySelector(
    '[aria-labelledby="microsoft-channel-heading"]'
  )
  assert.ok(panel, 'the Microsoft channel has its own panel')
  assert.match(panel!.textContent ?? '', /requires Entra ID P2/)
  assert.match(
    panel!.textContent ?? '',
    /does not mean Microsoft would also report zero/
  )
  // It also appears once in the count's disclosure, because a number shown
  // beside an unavailable Microsoft channel has to say so. What it must not do
  // is repeat down every row of the table.
  for (const row of document.querySelectorAll('tbody tr')) {
    assert.doesNotMatch(row.textContent ?? '', /Entra ID P2/)
  }
})

test('every row still names which system reported it', () => {
  const { document } = render()
  const detectedBy = [...document.querySelectorAll('tbody tr')].map(
    (row) => row.querySelectorAll('td')[1]?.textContent ?? ''
  )
  assert.ok(detectedBy.length > 0)
  for (const cell of detectedBy) {
    assert.match(cell, /HawkView/)
    // Microsoft could not be consulted, and the row says so rather than
    // implying Microsoft looked and found nothing.
    assert.match(cell, /Microsoft unavailable/)
    assert.doesNotMatch(cell, /Microsoft did not report/)
    // "Cannot report on this tenant" and "looked and found nothing" are
    // different claims and never share a sentence.
    assert.doesNotMatch(cell, /Not comparable/)
  }
})

test('a zero is never rendered alone', () => {
  const { text, cardText } = render(assessmentFixture(false))
  for (const [label, rendered] of [
    ['section', text],
    ['overview card', cardText],
  ] as const) {
    assert.match(rendered, /No findings in evaluated evidence/, label)
    assert.match(rendered, /does not establish that an identity is safe/, label)
    // The disclosure that stops the zero reading as "nothing is wrong".
    assert.match(rendered, /Not covered by this number/, label)
    assert.match(rendered, /requires Entra ID P2/, label)
  }
})

test('a live Microsoft channel shows its own records in its own vocabulary', () => {
  const { document, text } = render(assessmentFixture(true), {
    microsoft: microsoftLive(),
  })
  const panel = document.querySelector(
    '[aria-labelledby="microsoft-channel-heading"]'
  )
  assert.ok(panel)
  assert.match(panel!.textContent ?? '', /reporting on this tenant/)
  // Microsoft's records, under Microsoft's heading, using Microsoft's terms.
  assert.match(panel!.textContent ?? '', /Synthetic finance user/)
  assert.match(panel!.textContent ?? '', /At risk/)
  assert.match(panel!.textContent ?? '', /Dismissed/)
  // Never a licence pitch on a tenant that is already reporting.
  assert.doesNotMatch(text, /requires Entra ID P2/)
})

test('Microsoft records are never folded into the HawkView list or its count', () => {
  const { document } = render(assessmentFixture(true), {
    microsoft: microsoftLive(),
  })
  const hawkViewList = document.querySelector(
    '[aria-labelledby="risky-users-list-heading"]'
  )
  assert.ok(hawkViewList)
  // Microsoft's identities do not appear among HawkView's rows.
  assert.doesNotMatch(hawkViewList!.textContent ?? '', /Synthetic finance user/)

  // And the HawkView total is unchanged by Microsoft having two records.
  const summary = document.querySelector(
    '[aria-labelledby="risky-users-total-heading"]'
  )
  assert.ok(summary)
  assert.match(summary!.textContent ?? '', /Risky user/)
  assert.doesNotMatch(summary!.textContent ?? '', /3/)

  const panel = document.querySelector(
    '[aria-labelledby="microsoft-channel-heading"]'
  )
  assert.match(
    panel!.textContent ?? '',
    /never\s+added to, or subtracted from, the HawkView count/
  )
})

test('rows say Microsoft is not comparable rather than that it cleared anyone', () => {
  // Microsoft is live, but nothing correlates its directory objects to
  // HawkView's tenant-keyed pseudonyms. "Microsoft did not report this user"
  // would be a claim no evidence supports.
  const { document } = render(assessmentFixture(true), {
    microsoft: microsoftLive(),
  })
  // Non-vacuity guard. This assertion is a loop over rows, so zero rows makes
  // it pass while testing nothing -- and that is exactly what happened when the
  // harness began mocking useNativeRiskyUsersRead with the OLD hook's return
  // shape: the component receives no nativeView, renders no rows, and a test
  // named for the safety property most worth keeping goes green by asserting
  // nothing at all.
  //
  // It stays red until the fixtures are rewritten against the native shape,
  // which is owed work. Red for a known reason is worth more than green for an
  // unknown one.
  const rows = document.querySelectorAll(
    '[aria-labelledby="risky-users-list-heading"] tbody tr'
  )
  assert.ok(
    rows.length > 0,
    'no rows rendered, so the per-row assertions below check nothing'
  )
  for (const row of rows) {
    const detectedBy = row.querySelectorAll('td')[1]?.textContent ?? ''
    assert.match(detectedBy, /HawkView/)
    assert.match(detectedBy, /Not comparable/)
    assert.doesNotMatch(detectedBy, /Microsoft did not report/)
  }
})

test('a bounded Microsoft page says so instead of implying a full total', () => {
  const { document } = render(assessmentFixture(true), {
    microsoft: microsoftLive(true),
  })
  const panel = document.querySelector(
    '[aria-labelledby="microsoft-channel-heading"]'
  )
  assert.match(panel!.textContent ?? '', /More Microsoft records exist/)
  assert.match(panel!.textContent ?? '', /incomplete result set/)
})

test('a withheld count reads as a decision, not as a blank or a breakage', () => {
  const value = assessmentFixture(false)
  value.summary.currentUsers = {
    value: null,
    accuracy: 'UNKNOWN',
    reason: 'UNRESOLVED_SUBJECT_IDENTITY',
  }
  const { text, cardText } = render(value)

  for (const [label, rendered] of [
    ['section', text],
    ['overview card', cardText],
  ] as const) {
    // The slot where the number belongs says what happened, rather than
    // showing a glyph a technician would read as an empty or broken state.
    assert.match(rendered, /Not counted/, label)
    assert.match(rendered, /could not be tied to people/, label)
    assert.match(rendered, /belongs to a person/, label)
    // Nothing invites a retry, because no retry would help.
    assert.doesNotMatch(rendered, /Support code/, label)
    assert.doesNotMatch(rendered, /try again/i, label)
  }
})

test('an empty list never answers the question a withheld count refused', () => {
  const value = assessmentFixture(true)
  value.users = ['a', 'b', 'c'].map((character) =>
    assessmentUser('HV-ID-MBX-001.v1', character)
  )
  value.rules[0].matchedIdentities = 0
  value.rules[2].assessedIdentities = 3
  value.rules[2].matchedIdentities = 3
  value.summary.currentUsers = {
    value: null,
    accuracy: 'UNKNOWN',
    reason: 'UNRESOLVED_SUBJECT_IDENTITY',
  }
  const { document } = render(value)
  const list = document.querySelector(
    '[aria-labelledby="risky-users-list-heading"]'
  )
  assert.ok(list)
  // Three mailboxes are forwarding externally and HawkView has just said it
  // cannot tell how many belong to people. "No user needs attention" would
  // answer that question anyway.
  assert.doesNotMatch(
    list!.textContent ?? '',
    /No user is listed as needing attention/
  )
  assert.match(
    list!.textContent ?? '',
    /not the same as no user needing attention/
  )

  // Where HawkView did count, the plain sentence is still the right one.
  const counted = render(assessmentFixture(false))
  assert.match(
    counted.document.querySelector(
      '[aria-labelledby="risky-users-list-heading"]'
    )?.textContent ?? '',
    /No user is listed as needing attention/
  )
})

test('what HawkView did find is rendered beside a withheld count', () => {
  // Three mailboxes forwarding externally, none attributable to a person.
  const value = assessmentFixture(true)
  value.users = ['a', 'b', 'c'].map((character) =>
    assessmentUser('HV-ID-MBX-001.v1', character)
  )
  value.rules[0].matchedIdentities = 0
  value.rules[2].assessedIdentities = 3
  value.rules[2].matchedIdentities = 3
  value.summary.currentUsers = {
    value: null,
    accuracy: 'UNKNOWN',
    reason: 'UNRESOLVED_SUBJECT_IDENTITY',
  }
  const { text, cardText } = render(value)

  for (const [label, rendered] of [
    ['section', text],
    ['overview card', cardText],
  ] as const) {
    assert.match(rendered, /What HawkView did find/, label)
    assert.match(rendered, /External mailbox forwarding: 3 mailboxes/, label)
  }
})

test('a check that cannot run states its scope beside the number, not elsewhere', () => {
  const value = assessmentFixture(false)
  value.rules[2].status = 'INAPPLICABLE'
  value.rules[2].reasonCode = 'CHECK_NOT_APPLICABLE'
  value.rules[2].assessedIdentities = null
  value.rules[2].matchedIdentities = null
  value.rules[2].evaluatedAt = null
  value.rules[2].window = { start: null, end: null }
  const { document, cardText } = render(value)

  // The overview card carries the whole claim on its own, because that is
  // often the only Risky Users surface a technician sees.
  assert.match(cardText, /2 checks this tenant/)
  assert.match(cardText, /1 further check cannot run/)
  assert.match(cardText, /cannot run on this tenant/)
  assert.match(cardText, /External mailbox forwarding/)

  // In the section, the scope sits inside the same block as the number rather
  // than in the coverage panel further down the page. A scoped zero whose
  // scope lives one component away is a bare zero in practice.
  const summary = document.querySelector(
    '[aria-labelledby="risky-users-total-heading"]'
  )
  assert.ok(summary)
  assert.match(summary!.textContent ?? '', /2 checks this tenant/)
  assert.match(summary!.textContent ?? '', /1 further check cannot run/)
  assert.match(summary!.textContent ?? '', /External mailbox forwarding/)

  // And the check is labelled as unable to run, not as a failure.
  assert.match(document.body.textContent ?? '', /Cannot run on this tenant/)
})

test('the four evidence states never share the same words', () => {
  const partial = assessmentFixture(false)
  delete partial.summary
  partial.meta.capability = 'PARTIAL'
  partial.meta.freshness = 'UNKNOWN'
  partial.meta.limitation = 'One check did not complete.'
  partial.rules[1].status = 'PARTIAL'
  partial.rules[1].reasonCode = 'INCOMPLETE_WINDOW'

  // Every serious bug found on the old surface was two of these four wearing
  // the same clothes, so each one has to reach the screen saying something the
  // others do not.
  const states = {
    'never collected': {
      rendered: render(assessmentFixture(false), { notReported: true }).text,
      sentence: /HawkView has not evaluated this tenant yet/,
    },
    'genuinely clean': {
      rendered: render(assessmentFixture(false)).text,
      sentence: /No findings in evaluated evidence/,
    },
    unreadable: {
      rendered: render(assessmentFixture(false), { contractFailed: true }).text,
      sentence: /A response arrived that HawkView could not read/,
    },
    'partly evaluated': {
      rendered: render(partial).text,
      sentence: /did not complete over current evidence/,
    },
  }

  for (const [state, { rendered, sentence }] of Object.entries(states)) {
    assert.match(rendered, sentence, state)
    // And no state borrows another's wording.
    for (const [other, { sentence: otherSentence }] of Object.entries(states)) {
      if (other === state) continue
      assert.doesNotMatch(rendered, otherSentence, `${state} vs ${other}`)
    }
  }

  // None of the three non-clean states is allowed to print a bare zero.
  for (const state of ['never collected', 'unreadable', 'partly evaluated']) {
    assert.doesNotMatch(
      states[state as keyof typeof states].rendered,
      /No findings in evaluated evidence/,
      state
    )
  }
})

test('a failed read keeps prior findings on screen and withdraws only the total', () => {
  const { text } = render(assessmentFixture(true), { requestFailed: true })
  assert.match(text, /The latest assessment could not be loaded/)
  assert.match(text, /has not resolved or dismissed any of them/)
  // The user is still listed.
  assert.match(text, /Synthetic identity/)
  assert.match(text, /The latest assessment could not be loaded/)
})

test('mailbox evidence is shown but visibly excluded from the count', () => {
  const value = assessmentFixture(true)
  value.users.push(assessmentUser('HV-ID-MBX-001.v1', 'b'))
  value.rules[2].matchedIdentities = 1
  const { document, text } = render(value)

  const context = document.querySelector(
    '[aria-labelledby="risky-users-context-heading"]'
  )
  assert.ok(context, 'supporting evidence has its own section')
  assert.match(
    context!.textContent ?? '',
    /deliberately not counted above|would overstate/
  )
  assert.match(text, /External mailbox forwarding/)
})

test('the surface never claims a user is safe or that HawkView acted', () => {
  const { text } = render()
  assert.match(text, /investigation lead/i)
  assert.match(text, /does not establish that a user is safe/)
  assert.match(text, /HawkView makes no changes to Microsoft/)
  assert.doesNotMatch(text, /compromised account confirmed/i)
  assert.doesNotMatch(text, /remediated by HawkView/i)
})

test('the coverage behind the number is available on the same screen', () => {
  const { text } = render()
  assert.match(text, /What HawkView checked/)
  assert.match(text, /identities evaluated by this check/)
  assert.match(text, /Microsoft 365 audit sign-ins/)
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

test('a sign-in Microsoft cleared is never rendered among its detections', () => {
  const { document } = render(assessmentFixture(true), {
    microsoft: microsoftMixedVerdicts(),
  })
  const panel = microsoftPanel(document)
  const sections = [...panel.querySelectorAll('section')]
  const risk = sections.find((section: any) =>
    /currently considers at risk/.test(section.textContent ?? '')
  )
  const cleared = sections.find((section: any) =>
    /currently considers safe/.test(section.textContent ?? '')
  )
  assert.ok(risk, 'active risk has its own group')
  assert.ok(cleared, 'clearances have their own group')

  // The machine-cleared identity sits under "safe", not under "reports risk",
  // even though its state still reads atRisk.
  assert.match(cleared!.textContent ?? '', /Machine cleared user/)
  assert.doesNotMatch(risk!.textContent ?? '', /Machine cleared user/)
  assert.match(risk!.textContent ?? '', /Flagged user/)
  assert.match(cleared!.textContent ?? '', /not Microsoft flagging one/)
  // Microsoft can carry a risk state and a superseding safe conclusion on the
  // same record; the row says which governs rather than printing a state that
  // contradicts the heading above it.
  assert.match(cleared!.textContent ?? '', /superseded by the conclusion below/)
})

test('an unrecognised verdict renders as unrecognised, not as a risk', () => {
  const { document } = render(assessmentFixture(true), {
    microsoft: microsoftMixedVerdicts(),
  })
  const panel = microsoftPanel(document)
  const sections = [...panel.querySelectorAll('section')]
  const unrecognised = sections.find((section: any) =>
    /does not recognise/.test(section.textContent ?? '')
  )
  const risk = sections.find((section: any) =>
    /currently considers at risk/.test(section.textContent ?? '')
  )
  assert.ok(unrecognised)
  assert.match(unrecognised!.textContent ?? '', /Unrecognised verdict user/)
  assert.doesNotMatch(risk!.textContent ?? '', /Unrecognised verdict user/)
})

test('Microsoft automatic remediation is not shown as human negligence', () => {
  const { document } = render(assessmentFixture(true), {
    microsoft: microsoftMixedVerdicts(),
  })
  const panel = microsoftPanel(document)
  assert.match(panel.textContent ?? '', /An administrator dismissed all risk/)
  assert.match(
    panel.textContent ?? '',
    /automatic remediation lands in the dismissed state/
  )
})

test('a withheld risk level says so instead of reading as no risk', () => {
  const { document } = render(assessmentFixture(true), {
    microsoft: microsoftMixedVerdicts(),
  })
  const panel = microsoftPanel(document)
  assert.match(panel.textContent ?? '', /level requires Entra ID P2/)
  assert.match(panel.textContent ?? '', /not an absence of risk/)
  // And the level is named as confidence, not severity.
  assert.match(panel.textContent ?? '', /Microsoft confidence/)
  assert.match(
    panel.textContent ?? '',
    /confidence scale rather than a severity/
  )
})

test('no raw Microsoft identifier is ever painted on screen', () => {
  const { document } = render(assessmentFixture(true), {
    microsoft: microsoftMixedVerdicts(),
  })
  const panel = microsoftPanel(document)
  for (const identifier of [
    'aiConfirmedSigninSafe',
    'adminDismissedAllRiskForUser',
    'unknownFutureValue',
  ]) {
    assert.doesNotMatch(panel.textContent ?? '', new RegExp(identifier))
  }
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

test('a zero never renders as a clean tenant while findings sit below it', () => {
  const value = assessmentFixture(true)
  value.users = ['a', 'b', 'c'].map((character) =>
    assessmentUser('HV-ID-MBX-001.v1', character)
  )
  value.rules[0].matchedIdentities = 0
  value.rules[2].assessedIdentities = 3
  value.rules[2].matchedIdentities = 3
  value.summary.currentUsers = { value: 0, accuracy: 'EXACT' }
  const { document, text, cardText } = render(value)

  for (const [label, rendered] of [
    ['section', text],
    ['overview card', cardText],
  ] as const) {
    assert.match(rendered, /but there are findings/, label)
    // What was found is beside the number, not only further down the page.
    assert.match(rendered, /External mailbox forwarding: 3 mailboxes/, label)
  }

  // The empty user list must not answer the question the zero did not.
  const list = document.querySelector(
    '[aria-labelledby="risky-users-list-heading"]'
  )
  assert.ok(list)
  assert.doesNotMatch(
    list!.textContent ?? '',
    /No user is listed as needing attention/
  )
  assert.match(list!.textContent ?? '', /it is not an all-clear/)

  // A genuinely clean tenant still gets the plain sentence.
  const clean = render(assessmentFixture(false))
  assert.match(
    clean.document.querySelector('[aria-labelledby="risky-users-list-heading"]')
      ?.textContent ?? '',
    /No user is listed as needing attention/
  )
  assert.doesNotMatch(clean.text, /but there are findings/)
})

test('a user both systems reported shows both, and neither is folded in', () => {
  // The strongest signal this product can produce, and the reason the join was
  // worth waiting for rather than faking.
  const key = {
    available: true,
    shape: 'DIRECTORY_OBJECT_ID',
    ref: '11111111-2222-3333-4444-555555555555',
  }
  const value = assessmentFixture(true)
  value.users[0].correlation = key
  value.users[0].displayName = 'Alice Chen'
  value.users[0].userPrincipalName = 'alice.chen@synthetic.invalid'

  const envelope = syntheticRiskResponses().microsoftRiskyUsers
  const microsoft = {
    ...envelope,
    users: [
      {
        id: 'ms-1',
        identityLabel: 'Alice Chen',
        correlation: key,
        riskLevel: 'high',
        riskState: 'atRisk',
        riskDetail: null,
        observedAt: envelope.observedAt,
      },
    ],
    pageInfo: { hasMore: false, nextCursor: null },
  }

  const { document } = render(value, { microsoft })
  const row = document.querySelector(
    '[aria-labelledby="risky-users-list-heading"] tbody tr'
  )
  assert.ok(row)
  const detectedBy = row!.querySelectorAll('td')[1]?.textContent ?? ''
  assert.match(detectedBy, /HawkView/)
  assert.match(detectedBy, /Microsoft/)
  assert.match(detectedBy, /HawkView and Microsoft/)
  assert.doesNotMatch(detectedBy, /Not comparable|did not report|unavailable/)

  // The resolved identity is shown rather than the opaque reference.
  const identity = row!.querySelectorAll('td')[0]?.textContent ?? ''
  assert.match(identity, /Alice Chen/)
  assert.match(identity, /alice.chen@synthetic.invalid/)
  assert.doesNotMatch(identity, /hvr1_subject_/)

  // Microsoft's record still lives in Microsoft's own panel, and the HawkView
  // count is unchanged by it.
  const summary = document.querySelector(
    '[aria-labelledby="risky-users-total-heading"]'
  )
  assert.match(summary?.textContent ?? '', /Risky user/)
})

test('Microsoft looked and did not report this user is a distinct sentence', () => {
  const value = assessmentFixture(true)
  value.users[0].correlation = {
    available: true,
    shape: 'DIRECTORY_OBJECT_ID',
    ref: 'aaaa-user',
  }
  const envelope = syntheticRiskResponses().microsoftRiskyUsers
  const microsoft = {
    ...envelope,
    users: [
      {
        id: 'ms-other',
        identityLabel: 'Someone else',
        correlation: {
          available: true,
          shape: 'DIRECTORY_OBJECT_ID',
          ref: 'bbbb-other',
        },
        riskLevel: 'high',
        riskState: 'atRisk',
        riskDetail: null,
        observedAt: envelope.observedAt,
      },
    ],
    pageInfo: { hasMore: false, nextCursor: null },
  }
  const { document } = render(value, { microsoft })
  const detectedBy =
    document
      .querySelector('[aria-labelledby="risky-users-list-heading"] tbody tr')
      ?.querySelectorAll('td')[1]?.textContent ?? ''
  assert.match(detectedBy, /Microsoft did not report this user/)
  assert.doesNotMatch(detectedBy, /Not comparable/)
})

test('per-check identity counts cannot be read as tenant coverage', () => {
  const { text } = render(assessmentFixture(false))
  // Labelled as what the check evaluated, never as a share of the tenant.
  assert.match(text, /identities evaluated by this check/)
  assert.match(text, /does not report how many identities exist in this tenant/)
  assert.match(text, /two checks may have evaluated different populations/)
  // And the zero carries the same admission beside the number itself.
  assert.match(text, /not a proportion of your people/)
})

test('a corroborated row never reads as a combined judgement', () => {
  // Microsoft calls this person at risk with high confidence in its own panel.
  // HawkView rates its own finding Low. Both are true; a row labelled
  // "HawkView and Microsoft" carrying a bare "Low" reads as the verdict of
  // both, and a technician triaging by that column works the one row where two
  // systems agree last.
  const key = {
    available: true,
    shape: 'DIRECTORY_OBJECT_ID',
    ref: 'shared-guid',
  }
  const value = assessmentFixture(true)
  value.users[0].correlation = key
  value.users[0].displayName = 'Alice Chen'
  // A second, uncorroborated user that HawkView rates higher.
  const louder = assessmentUser('HV-ID-AUTH-005.v2', 'b')
  louder.label = 'Higher priority, one source'
  value.users.push(louder)
  value.rules[1].matchedIdentities = 1
  value.summary.currentUsers = { value: 2, accuracy: 'EXACT' }

  const envelope = syntheticRiskResponses().microsoftRiskyUsers
  const microsoft = {
    ...envelope,
    users: [
      {
        id: 'ms-1',
        identityLabel: 'Alice Chen',
        correlation: key,
        riskLevel: 'high',
        riskState: 'atRisk',
        riskDetail: null,
        observedAt: envelope.observedAt,
      },
    ],
    pageInfo: { hasMore: false, nextCursor: null },
  }

  const { document } = render(value, { microsoft })
  const rows = [
    ...document.querySelectorAll(
      '[aria-labelledby="risky-users-list-heading"] tbody tr'
    ),
  ]
  assert.equal(rows.length, 2)

  // The column names whose rating it is.
  const headers = [...document.querySelectorAll('th')].map((cell: any) =>
    cell.textContent?.trim()
  )
  assert.ok(headers.includes('HawkView priority'))

  // Microsoft's own verdict travels with the row rather than living only in
  // the panel above, so the two are read together.
  const alice = rows.find((row: any) =>
    /Alice Chen/.test(row.textContent ?? '')
  )
  assert.ok(alice)
  assert.match(alice!.textContent ?? '', /Microsoft says/)
  assert.match(alice!.textContent ?? '', /At risk/)
  assert.match(alice!.textContent ?? '', /High confidence/)
  // And the cell says the rating is HawkView's alone.
  assert.match(alice!.textContent ?? '', /rating of its own finding/)

  // HawkView's own priority still orders HawkView's list: the Medium leads the
  // corroborated Low. Ordering on corroboration would have made the position
  // of a HawkView finding depend on the customer's Microsoft licensing, which
  // is a rule that changes per tenant without saying so.
  assert.match(rows[0].textContent ?? '', /Higher priority, one source/)
  assert.match(rows[1].textContent ?? '', /Alice Chen/)
  // The ordering is stated rather than left to be inferred.
  const list = document.querySelector(
    '[aria-labelledby="risky-users-list-heading"]'
  )
  assert.match(list!.textContent ?? '', /whatever its Microsoft licensing/)
  assert.match(list!.textContent ?? '', /never combined into one score/)
})

test('a person and a mailbox sharing a name are visibly different subjects', () => {
  // A shared mailbox named after its owner is ordinary in Microsoft 365. Two
  // rows reading "Alice Chen" with different priorities look like the page
  // contradicting itself unless each says what it is a row about.
  const value = assessmentFixture(true)
  value.users[0].displayName = 'Alice Chen'
  const mailbox = assessmentUser('HV-ID-MBX-001.v1', 'd')
  mailbox.label = 'Alice Chen'
  value.users.push(mailbox)
  value.rules[2].assessedIdentities = 2
  value.rules[2].matchedIdentities = 1

  const { document } = render(value)
  const counted = document.querySelector(
    '[aria-labelledby="risky-users-list-heading"] tbody tr'
  )
  const supporting = document.querySelector(
    '[aria-labelledby="risky-users-context-heading"] tbody tr'
  )
  assert.ok(counted)
  assert.ok(supporting)
  assert.match(counted!.textContent ?? '', /Alice Chen/)
  assert.match(supporting!.textContent ?? '', /Alice Chen/)
  // Each row says which kind of subject it is, so the two are not read as one
  // person the page cannot make its mind up about.
  assert.match(counted!.textContent ?? '', /User account/)
  assert.match(supporting!.textContent ?? '', /Mailbox/)
})

test('several withholding reasons all reach the screen', () => {
  const value = assessmentFixture(false)
  value.summary.currentUsers = {
    value: null,
    accuracy: 'UNKNOWN',
    reasons: ['UNRESOLVED_SUBJECT_IDENTITY', 'UNINTERPRETABLE_EVIDENCE'],
  }
  const { text, cardText } = render(value)
  for (const [label, rendered] of [
    ['section', text],
    ['overview card', cardText],
  ] as const) {
    assert.match(rendered, /2 reasons/, label)
    assert.match(rendered, /belongs to a person/, label)
    assert.match(rendered, /does not recognise/, label)
  }
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

test('the Microsoft panel names the question it answers, not just its source', () => {
  // Microsoft answers two different questions by two different roads: this
  // API gives its current assessment of a person, and sign-in verdicts give
  // its reading of one event as logged. They can disagree without either being
  // wrong. A heading that says only "Microsoft" invites that disagreement to
  // read as Microsoft contradicting itself, and makes it possible to drop
  // event-level rows into a user-level group without anyone noticing.
  const { document } = render(assessmentFixture(true), {
    microsoft: microsoftMixedVerdicts(),
  })
  const panel = microsoftPanel(document)

  // Every group names its subject as a user.
  for (const heading of [...panel.querySelectorAll('h5')]) {
    assert.match(
      heading.textContent ?? '',
      /^Users /,
      heading.textContent ?? ''
    )
  }
  // And the panel names the tense and the evidence base.
  assert.match(panel.textContent ?? '', /considers at risk now/)
  assert.match(panel.textContent ?? '', /telemetry HawkView cannot see/)
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

test('a reporting Microsoft channel with no records says so, rather than showing nothing', () => {
  // "Microsoft is looking and currently lists nobody at risk" is a result and
  // is worth having. Rendering nothing made it indistinguishable from having
  // failed to fetch Microsoft's records, and hid the one statement that
  // separates an authoritative empty snapshot from an unconfirmed one.
  const { document } = render(assessmentFixture(true), {
    microsoft: syntheticRiskResponses().microsoftRiskyUsers,
  })
  const panel = document.querySelector(
    '[aria-labelledby="microsoft-channel-heading"]'
  )
  assert.ok(panel)
  assert.match(panel!.textContent ?? '', /reporting on this tenant/)
  assert.match(panel!.textContent ?? '', /Microsoft records reported/)
  assert.match(
    panel!.textContent ?? '',
    /latest complete, current Microsoft snapshot is empty/
  )
  // And it does not become a HawkView safety verdict on the way.
  assert.match(panel!.textContent ?? '', /not a HawkView safety verdict/)
})

test('an unavailable Microsoft channel adds no empty-count line', () => {
  // There the panel already explains itself, and a second "no records" line
  // would be noise that competes with the licence statement.
  const { document } = render(assessmentFixture(true))
  const panel = document.querySelector(
    '[aria-labelledby="microsoft-channel-heading"]'
  )
  assert.match(panel!.textContent ?? '', /requires Entra ID P2/)
  assert.doesNotMatch(panel!.textContent ?? '', /Microsoft records reported/)
})

test('an unconfirmed empty Microsoft result never becomes an authoritative zero', () => {
  // The distinction microsoftHasConfirmedEmptySnapshot exists to make. An
  // empty page while Microsoft reports further pages is not a clean tenant,
  // and it must not borrow the wording of one.
  const envelope = syntheticRiskResponses().microsoftRiskyUsers
  const { document } = render(assessmentFixture(true), {
    microsoft: {
      ...envelope,
      users: [],
      pageInfo: { hasMore: true, nextCursor: 'cursor.abc' },
    },
  })
  const panel = document.querySelector(
    '[aria-labelledby="microsoft-channel-heading"]'
  )
  assert.ok(panel)
  assert.match(panel!.textContent ?? '', /Microsoft count unavailable/)
  assert.match(panel!.textContent ?? '', /It is not zero/)
  // Never the confirmed-empty wording, and never a zero lower bound.
  assert.doesNotMatch(panel!.textContent ?? '', /snapshot is empty/)
  assert.doesNotMatch(panel!.textContent ?? '', /At least 0/)
  assert.doesNotMatch(panel!.textContent ?? '', /≥0/)
})

test('two reasons with different dates never share one', () => {
  // Real shape from the fleet: an account with 467 lockouts that stopped six
  // days before its last password rejection. A row listing both titles beside
  // a single "last seen" describes the quieter signal and makes the louder one
  // look current — two true facts implying a false third.
  const value = assessmentFixture(true)
  const older = JSON.parse(JSON.stringify(value.users[0].findings[0]))
  older.id = older.id.replace(/a{4}$/, 'bbbb')
  older.ruleId = 'HV-ID-AUTH-005.v2'
  older.ruleVersion = 'v2'
  older.priority = 'MEDIUM'
  older.title = 'Failures followed by successful sign-in'
  older.firstSeen = at(-14)
  older.lastSeen = at(-12)
  older.activityWindowEndsAt = at(-11)
  older.window = { start: at(-15), end: at() }
  older.evidenceCount = 467
  older.clientSource = {
    reference: 'hvr1_context_' + 'a'.repeat(64),
    qualification: 'QUALIFIED',
  }
  value.users[0].findings.push(older)
  value.users[0].priority = 'MEDIUM'
  value.rules[1].matchedIdentities = 1

  const { document } = render(value)
  const cell =
    document.querySelector(
      '[aria-labelledby="risky-users-list-heading"] tbody tr td'
    )?.textContent ?? ''

  // Each reason states its own volume and its own recency.
  assert.match(cell, /Repeated invalid credentials/)
  assert.match(cell, /Failures followed by successful sign-in/)
  assert.match(cell, /467 records/)
  assert.match(cell, /10 records/)
  // Two different dates are present, so neither number sits beside the
  // other's. Split on the label rather than pattern-matching a locale date.
  const afterLast = cell
    .split('last ')
    .slice(1)
    .map((part: string) => part.trim())
  assert.equal(afterLast.length, 2, cell)
  assert.notEqual(afterLast[0], afterLast[1], cell)

  // And the column that aggregates says that is what it does.
  const headers = [...document.querySelectorAll('th')].map((h: any) =>
    h.textContent?.trim()
  )
  assert.ok(headers.includes('Latest of any reason'))
  assert.ok(!headers.includes('Last seen'))
})

test('a setting is never counted as though it were a sequence of events', () => {
  // The mailbox check counts the external destinations a mailbox is currently
  // configured to forward to, and its timestamp is when HawkView read that
  // configuration. Every other check counts events that happened, and its
  // timestamp is when the last one happened. Both arrive in the same two
  // fields, so one phrase for both is false for one of them.
  //
  // "10 records, last 4:12 p.m." says ten things happened and the newest was
  // minutes ago. The truth is that one setting names ten destinations and
  // 4:12 p.m. is when we looked. The read time is always recent, which makes
  // every forwarding finding read as though it were unfolding right now --
  // backwards, since a rule set six months ago is the worse case.
  const value = assessmentFixture(true)
  value.users = [assessmentUser('HV-ID-MBX-001.v1', 'a')]
  value.rules[0].matchedIdentities = 0
  value.rules[2].assessedIdentities = 1
  value.rules[2].matchedIdentities = 1
  const { document } = render(value)
  // Mailbox evidence is never counted as a person, so the row lives in the
  // context region rather than the user list.
  const list =
    document.querySelector('[aria-labelledby="risky-users-context-heading"]')
      ?.textContent ?? ''

  assert.match(list, /10 external destinations/)
  assert.match(list, /configuration read/)
  // The row must not describe the setting in the vocabulary of events.
  assert.ok(!/10 records/.test(list), 'destinations rendered as event records')
  assert.ok(
    !/configured to forward[^.]*, last /.test(list),
    'a read time rendered as an occurrence time'
  )

  // The aggregate beside the reason is the half that survives a per-reason fix.
  // "Latest of any reason" is a maximum over timestamps that do not all mean
  // the same thing, and a read time is always the most recent thing on the
  // page, so an unlabelled column puts every forwarding row at the top and
  // tells the reader it just happened.
  assert.match(list, /when HawkView read a setting, not when anything happened/)
})

test('an event check keeps the event vocabulary', () => {
  // The guard above must not have been bought by flattening every check into
  // the cautious wording. A check that really does count events still says so.
  const { document } = render(assessmentFixture(true))
  const list =
    document.querySelector('[aria-labelledby="risky-users-list-heading"]')
      ?.textContent ?? ''
  assert.match(list, /10 records, last /)
  assert.ok(
    !/external destinations/.test(list),
    'an event check borrowed the state vocabulary'
  )
  assert.ok(
    !/read a setting/.test(list),
    'an event row was told its own timestamp was a read time'
  )
})

test('an unrecognised rule never lets its identifier become the description', () => {
  // Backend rule catalogues move on their own schedule, so a check this build
  // has never seen will appear in a row eventually. The row has to say
  // something, and the two tempting options are both wrong: "10 records"
  // guesses a unit the mailbox check has already proved can be wrong, and the
  // identifier is not a sentence a technician can act on.
  const value = assessmentFixture(true)
  const subject = assessmentUser('HV-ID-AUTH-005.v2', 'a')
  subject.findings[0].ruleId = 'HV-ID-NEW-777.v1'
  value.users = [subject]
  // The server publishes the new check in its readiness list; only this build's
  // own catalogue is behind. That is the case worth covering, because it is the
  // one that happens on every backend release.
  value.rules.push({
    ...value.rules[1],
    ruleId: 'HV-ID-NEW-777.v1',
    ruleVersion: 'v1',
    title: 'A check released after this build',
    matchedIdentities: 1,
  })
  value.rules[0].matchedIdentities = 0
  const { document } = render(value)
  const list =
    document.querySelector('[aria-labelledby="risky-users-list-heading"]')
      ?.textContent ?? ''

  assert.match(list, /does not know this check/)
  assert.ok(!/10 records/.test(list), 'a unit was guessed for an unknown rule')
  assert.ok(
    !/HV-ID-NEW-777/.test(list),
    'an identifier was rendered where a description belongs'
  )
})

test('a check that ran without a time says so, and is not called unreported', () => {
  // No detector emits a dateless finding today, and that is a fact about the
  // two detectors that exist rather than about the contract. The alternative to
  // handling it is a default — now, the epoch, the empty string — which would
  // place the row somewhere specific in the one column that means recency, on
  // the strength of a value nobody supplied.
  //
  // The words matter as much as the handling. "Not reported" describes a gap in
  // collection. A check that ran and produced evidence carrying no time is a
  // gap in the evidence, and sending a technician to look at collection for it
  // is this surface's standing mistake in miniature.
  const { document } = render(assessmentFixture(true), {
    afterAdapt: (value) => {
      for (const finding of value.users[0].findings) finding.lastSeen = null
    },
  })
  const rows = Array.from(
    document.querySelectorAll(
      '[aria-labelledby="risky-users-list-heading"] tbody tr'
    )
  ) as Element[]
  const dateless = rows.find((row) =>
    row.textContent?.includes('No time recorded')
  )
  assert.ok(dateless, 'the dateless row rendered no distinct state')
  assert.match(
    dateless!.textContent ?? '',
    /the checks ran; their evidence carries no time/
  )
  assert.ok(
    !/Not reported/.test(dateless!.textContent ?? ''),
    'an evidence gap was reported as a collection gap'
  )
  // The reason line beside it must not invent one either.
  assert.ok(
    !/, last /.test(dateless!.textContent ?? ''),
    'a reason without a time was given one'
  )
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
        '[aria-labelledby="risky-users-list-heading"] tbody tr'
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

test('an exact zero over a population never examined is not a clean tenant', () => {
  // This is the live engine's output on all five tenants right now: an exact
  // zero, with zero eligible subjects, on three tenants that are under attack.
  // It is the state this surface is most likely to be asked to render today,
  // and until the wire exists it is also the state it has never met.
  //
  // Both cohorts are asserted together on purpose. A gate that fires on the
  // unexamined tenant proves nothing on its own — it has to be shown not to
  // fire on the tenant that really was checked and really was clean, or it is
  // a warning that is always on, which a technician learns to skim past.
  const tenant = (assessedIdentities: number) => {
    const value = assessmentFixture(false)
    value.users = []
    value.summary.currentUsers = { value: 0, accuracy: 'EXACT' }
    for (const rule of value.rules) {
      rule.assessedIdentities = assessedIdentities
      rule.matchedIdentities = 0
    }
    return render(value)
  }

  const neverExamined = tenant(0)
  assert.match(neverExamined.cardText, /No findings can be confirmed yet/)
  assert.match(neverExamined.cardText, /lack a complete evaluated scope/)
  assert.ok(
    !/reported no matches/.test(neverExamined.cardText),
    'a tenant nothing was examined on was described as having been checked'
  )

  // The coverage panel must not describe the check as having run over a
  // population either. "0 identities evaluated" reads as a check that examined
  // people and found none; the truth is that it had nobody to examine, and one
  // of those is a quiet tenant while the other is a broken pipeline.
  assert.match(neverExamined.text, /no identities were in scope for this check/)
  assert.ok(
    !/0 identities evaluated/.test(neverExamined.text),
    'an empty population was rendered as an evaluated one'
  )

  // The control: a tenant that really was checked keeps its clean-sweep
  // sentence, so the gate above is discriminating rather than always on.
  const clean = tenant(5)
  assert.match(clean.cardText, /No findings in evaluated evidence/)
  assert.match(clean.cardText, /reported no matches/)
  assert.match(clean.text, /5 identities evaluated by this check/)
  assert.ok(
    !/No findings can be confirmed yet/.test(clean.cardText),
    'the unexamined-tenant gate fired on a tenant that was examined'
  )
})

test('a count with no findings behind it is a gap, never an all-clear', () => {
  // The first shape a real assessment will take. The read path can serve
  // coverage, count and claim while findings have nowhere to persist, so a
  // response that states four users and carries no finding is not a defensive
  // branch — it is the state the wire produces on its first day.
  //
  // Each component on its own sees something coherent: the tile a number, the
  // list an emptiness. The contradiction lives only in the pair, and the
  // sentence the list used to fall through to made it worse by pointing the
  // reader up at the summary — which confidently says four.
  const value = assessmentFixture(false)
  value.users = []
  value.summary.currentUsers = { value: 4, accuracy: 'EXACT' }
  value.rules[0].assessedIdentities = 12
  value.rules[0].matchedIdentities = 4
  const { document, cardText } = render(value)
  const list =
    document.querySelector('[aria-labelledby="risky-users-list-heading"]')
      ?.textContent ?? ''

  assert.match(list, /reports 4 users with current findings/)
  assert.match(list, /gap in what this response delivered/)
  assert.ok(
    !/No user is listed as needing attention/.test(list),
    'a number of users was rendered beside a sentence saying none need attention'
  )

  // The card carries the whole claim on its own, because it is often the only
  // Risky Users surface a technician sees.
  assert.match(cardText, /did not come back with it/)
  assert.ok(
    !/No user is listed as needing attention/.test(cardText),
    'the standalone card left the contradiction to the section'
  )

  // Control: a count with its findings behind it says none of this. Without
  // this half the guard would pass just as well if the disclosure were always
  // on, which is a warning a technician learns to skim.
  const delivered = render(assessmentFixture(true))
  assert.ok(
    !/did not come back with it/.test(delivered.cardText),
    'the disclosure fired on a response that delivered its findings'
  )
  assert.ok(
    !/gap in what this response delivered/.test(delivered.text),
    'the disclosure fired on a response that delivered its findings'
  )
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
    '[aria-labelledby="risky-users-list-heading"] tbody tr'
  )?.textContent ?? ''

test('one finding resting on two signals renders two reasons, not one', () => {
  // Raymonds, as the contract now delivers it: a single credential-failure
  // finding carrying 462 lockouts that stopped on the 3rd and 12 password
  // rejections from the 9th. Mapping a finding to a reason would show one
  // count and one date for both -- the collapse the contract was changed to
  // remove, re-created one level up in the layer that renders it.
  const { document } = render(
    withSignals([
      {
        signal: 'LOCKED_OUT_AFTER_REPEATED_FAILURES',
        count: 462,
        capped: false,
        latest: { at: at(-14), kind: 'EVENT_OCCURRED' },
      },
      {
        signal: 'PASSWORD_REJECTED',
        count: 12,
        capped: false,
        latest: { at: at(-1), kind: 'EVENT_OCCURRED' },
      },
    ])
  )
  const row = rowText(document)

  // Each signal keeps its own volume, in its own unit, with its own date.
  assert.match(row, /Locked out after repeated failures/)
  assert.match(row, /462 lockouts, last /)
  assert.match(row, /Password rejected/)
  assert.match(row, /12 rejected sign-ins, last /)

  // And the two dates are different, so neither count sits beside the other's.
  const dates = row
    .split('last ')
    .slice(1)
    .map((part: string) => part.slice(0, 24))
  assert.equal(dates.length, 2, row)
  assert.notEqual(dates[0], dates[1], row)

  // The finding's own aggregate count is never printed beside the signals it
  // was summed from; 474 would read as a third reason.
  assert.ok(!/474/.test(row), 'the finding total was rendered beside its parts')
})

test('a state signal is not described in the vocabulary of events', () => {
  // The kind comes off the value. Nothing here consults the signal's name to
  // decide it, which is the point of the contract change: a name is a proxy
  // for the kind in exactly the way a rule id is.
  const { document } = render(
    withSignals([
      {
        signal: 'EXTERNAL_FORWARDING_CONFIGURED',
        count: 3,
        capped: false,
        latest: { at: at(-1), kind: 'STATE_OBSERVED' },
      },
    ])
  )
  const row = rowText(document)
  assert.match(row, /3 external destinations/)
  assert.match(row, /configuration read /)
  assert.ok(!/, last /.test(row), 'a read time was rendered as an occurrence')
})

test('an unrecognised signal says so and never shows its identifier', () => {
  // The closed set lives in the wiring layer and the core's type is a plain
  // string, so a fourth signal can appear without anything failing to compile.
  const { document } = render(
    withSignals([
      {
        signal: 'SOMETHING_SHIPPED_AFTER_THIS_BUILD',
        count: 9,
        capped: false,
        latest: { at: at(-1), kind: 'EVENT_OCCURRED' },
      },
    ])
  )
  const row = rowText(document)
  assert.match(row, /does not recognise/)
  assert.match(row, /does not know this check/)
  assert.ok(!/9 records/.test(row), 'a unit was guessed for an unknown signal')
  assert.ok(
    !/SOMETHING_SHIPPED_AFTER_THIS_BUILD/.test(row),
    'an identifier was rendered where a description belongs'
  )
})

test('a response without signals still renders, and one with an empty array does not', () => {
  // Frontend and backend ship through separate systems, so every release has a
  // window where one side is old. Absence has to be survivable; the key simply
  // missing is what an old server sends.
  const older = render(withSignals(undefined))
  assert.match(rowText(older.document), /Repeated invalid credentials/)
  assert.match(rowText(older.document), /474 records, last /)

  // An empty array is not the same thing and must not be tolerated as though
  // it were. Under the contract a signal missing from the array was never
  // evaluated, so an empty one says every signal was never evaluated -- a
  // finding resting on nothing. Accepting it as an old-server sentinel would
  // drop every finding in the tenant for the length of a deploy, which fails
  // silently and reads exactly like a clean tenant.
  const empty = adapter.adaptRiskAssessmentResponse(
    withSignals([]),
    assessmentNow
  )
  assert.equal(empty, null)

  // Two entries for one signal make every count ambiguous.
  const duplicated = adapter.adaptRiskAssessmentResponse(
    withSignals([
      {
        signal: 'PASSWORD_REJECTED',
        count: 1,
        capped: false,
        latest: { at: at(-1), kind: 'EVENT_OCCURRED' },
      },
      {
        signal: 'PASSWORD_REJECTED',
        count: 2,
        capped: false,
        latest: { at: at(-2), kind: 'EVENT_OCCURRED' },
      },
    ]),
    assessmentNow
  )
  assert.equal(duplicated, null)
})

test('a signal evaluated and empty is distinguishable from one never evaluated', () => {
  // Two of the nine findings on the fleet carry a zero lockout count beside a
  // real rejection count. The zero is a result and reads as one; the signal
  // that is simply absent renders nothing at all.
  const { document } = render(
    withSignals([
      {
        signal: 'LOCKED_OUT_AFTER_REPEATED_FAILURES',
        count: 0,
        capped: false,
        latest: null,
      },
      {
        signal: 'PASSWORD_REJECTED',
        count: 7,
        capped: false,
        latest: { at: at(-1), kind: 'EVENT_OCCURRED' },
      },
    ])
  )
  const row = rowText(document)
  assert.match(row, /Locked out after repeated failures/)
  assert.match(row, /none recorded/)
  assert.match(row, /7 rejected sign-ins, last /)
  assert.ok(
    !/0 lockouts/.test(row),
    'an evaluated zero was rendered as a count'
  )
  // Nothing invents a forwarding line for a signal that was never sent.
  assert.ok(!/external destination/.test(row))
})

test('the kind comes off the value even when the name suggests otherwise', () => {
  // The guard the contract change exists for, and it was not guarded until a
  // mutation said so: replacing "read the kind" with "infer it from the signal
  // name" broke none of the tests above, because in every fixture the name and
  // the kind agree. A test that cannot tell the two apart is not testing the
  // thing the field was added for.
  //
  // So both are inverted here. A forwarding signal whose instant marks an
  // event is a legitimate payload -- a future detector could watch forwarding
  // being changed rather than read its current state -- and the client must
  // not overrule it from the name. That is the whole reason the kind travels
  // on the value: a name is a proxy for it in exactly the way a rule id is.
  const { document } = render(
    withSignals([
      {
        signal: 'EXTERNAL_FORWARDING_CONFIGURED',
        count: 3,
        capped: false,
        latest: { at: at(-14), kind: 'EVENT_OCCURRED' },
      },
      {
        signal: 'PASSWORD_REJECTED',
        count: 5,
        capped: false,
        latest: { at: at(-1), kind: 'STATE_OBSERVED' },
      },
    ])
  )
  const row = rowText(document)

  // The forwarding signal keeps its own unit and takes the event wording.
  assert.match(row, /3 external destinations, last /)
  // The rejection signal keeps its own unit and takes the observation wording.
  assert.match(row, /5 rejected sign-ins, configuration read /)

  // Neither borrowed the reading its name would have implied.
  assert.ok(
    !/3 external destinations, configuration read /.test(row),
    'the kind was inferred from the signal name rather than read from the value'
  )
  assert.ok(
    !/5 rejected sign-ins, last /.test(row),
    'the kind was inferred from the signal name rather than read from the value'
  )
})

test('a page of a list is never presented as the list', () => {
  // The count counts the tenant; the rows are what this response returned.
  // Both true, and a reader who counts the rows and compares gets a different
  // answer with nothing on screen to reconcile them. Eight people go missing
  // and the page reads as though they were cleared.
  //
  // Reachable at scale rather than in principle: a tenant with nine findings
  // returns a first page, and the collector fix means tenants that reported
  // none now report nine.
  const paged = () => {
    const value = assessmentFixture(true)
    value.summary.currentUsers = { value: 9, accuracy: 'EXACT' }
    value.rules[0].assessedIdentities = 12
    value.rules[0].matchedIdentities = 9
    value.page = { hasMore: true, nextCursor: 'abc123.def456' }
    return value
  }
  const { document, cardText } = render(paged())
  const list =
    document.querySelector('[aria-labelledby="risky-users-list-heading"]')
      ?.textContent ?? ''

  assert.match(list, /part of the list, not all of it/)
  assert.match(list, /have not been checked and cleared/)
  // The card travels alone, so it carries the fact too.
  assert.match(cardText, /longer than what came back with it/)

  // Arithmetic alone is enough, without the server saying so. A response that
  // sets one signal and not the other is still a list that does not account
  // for its own number.
  const noFlag = paged()
  noFlag.page = { hasMore: false, nextCursor: null }
  const arithmetic = render(noFlag)
  assert.match(
    arithmetic.document.querySelector(
      '[aria-labelledby="risky-users-list-heading"]'
    )?.textContent ?? '',
    /part of the list, not all of it/
  )

  // Control: a complete list says none of this. Without this half the guard
  // passes just as well if the notice is always on, which is a warning a
  // technician learns to skim past.
  const complete = render(assessmentFixture(true))
  assert.ok(
    !/part of the list, not all of it/.test(complete.text),
    'the partial notice fired on a list that was complete'
  )
  assert.ok(
    !/longer than what came back with it/.test(complete.cardText),
    'the partial notice fired on a list that was complete'
  )

  // And the two gaps stay distinct: nothing delivered is not the same as some
  // delivered, and each has its own sentence.
  const none = assessmentFixture(false)
  none.users = []
  none.summary.currentUsers = { value: 4, accuracy: 'EXACT' }
  none.rules[0].assessedIdentities = 12
  none.rules[0].matchedIdentities = 4
  const undelivered = render(none)
  assert.match(undelivered.text, /gap in what this response delivered/)
  assert.ok(
    !/part of the list, not all of it/.test(undelivered.text),
    'an empty list borrowed the partial-list wording'
  )
})
