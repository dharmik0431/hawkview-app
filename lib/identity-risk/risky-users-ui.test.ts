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
      sentence: /No assessment has been reported for this tenant yet/,
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
  assert.match(text, /Risky users could not be counted/)
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
