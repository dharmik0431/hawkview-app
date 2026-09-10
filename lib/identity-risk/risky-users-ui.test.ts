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

function render(
  assessmentValue: unknown = assessmentFixture(true),
  options: {
    microsoft?: unknown
    requestFailed?: boolean
    contractFailed?: boolean
    notReported?: boolean
    loading?: boolean
  } = {}
) {
  const assessment = adapter.adaptRiskAssessmentResponse(
    assessmentValue,
    assessmentNow
  )
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

  const uiMocks = {
    '@/lib/identity-risk/presentation': presentation,
    '@/lib/identity-risk/risky-users-view': riskyUsersView,
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
  return {
    document: dom.window.document,
    text: dom.window.document.body.textContent ?? '',
    cardText: cardDom.window.document.body.textContent ?? '',
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
    'Priority',
    'Last seen',
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
  const reference = cell!.querySelectorAll('p')[1]
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
  for (const row of document.querySelectorAll(
    '[aria-labelledby="risky-users-list-heading"] tbody tr'
  )) {
    const detectedBy = row.querySelectorAll('td')[1]?.textContent ?? ''
    assert.match(detectedBy, /HawkView/)
    assert.match(detectedBy, /Microsoft not comparable/)
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
  assert.match(text, /identities assessed/)
  assert.match(text, /Microsoft 365 audit sign-ins/)
})
