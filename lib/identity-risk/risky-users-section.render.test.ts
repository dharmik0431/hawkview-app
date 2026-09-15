// TEMPORARY MEASUREMENT, not a test to keep. Drives the mounted section with a
// GENUINE native-shaped unavailable assessment -- nativeView: null, which is
// exactly what useNativeRiskyUsersRead yields when the assessment is
// unavailable -- and prints what the surface actually renders.
//
// This exists to convert one traced claim into an executed one: that
// nativeRiskyUserCount and nativeRiskyUserList branch on the identical
// condition, so "Users requiring review: Not available" and a derived
// "0 detected by HawkView" are guaranteed to co-occur rather than merely
// co-reachable. It supplies the REAL hook contract, not the legacy one the
// existing harness substitutes.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import test from 'node:test'
import * as adapter from './adapter.ts'
import * as presentation from './presentation.ts'
import * as riskyUsersView from './risky-users-view.ts'
import { syntheticRiskResponses, unavailableMeta } from './test-fixtures.ts'

const require = createRequire(import.meta.url)
const React = require('react')
const { renderToStaticMarkup } = require('react-dom/server')
const { JSDOM } = require('jsdom')
const ts = require('typescript')

function compile(path: string, mocks: Record<string, unknown>) {
  const exports: Record<string, unknown> = {}
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

const microsoftView = adapter.adaptMicrosoftRiskyUsersResponse({
  ...syntheticRiskResponses().microsoftRiskyUsers,
  ...unavailableMeta(
    'Microsoft Entra risky-user evidence is not available on this tenant.'
  ),
  reasonCode: 'LICENSE_REQUIRED',
})

const uiMocks: Record<string, unknown> = {
  '@/lib/identity-risk/presentation': presentation,
  '@/lib/identity-risk/risky-users-view': riskyUsersView,
  '@/lib/identity-risk/native-view': require('./native-view.ts'),
  '@/lib/identity-risk/risk-presentation-mapper': require('./risk-presentation-mapper.ts'),
  '@/lib/api/hooks': {
    useTenantOperationalProjection: () => ({
      tenant: { name: 'Synthetic Tenant', defaultDomainName: 'synthetic.com' },
    }),
  },
  '@/lib/utils': { cn: (...v: unknown[]) => v.filter(Boolean).join(' ') },
  '@/components/ui/input': { Input: (p: any) => React.createElement('input', p) },
  '@/components/ui/tooltip': {
    TooltipProvider: ({ children }: any) => React.createElement('div', null, children),
    Tooltip: ({ children }: any) => React.createElement('div', null, children),
    TooltipTrigger: ({ children }: any) => React.createElement('div', null, children),
    TooltipContent: ({ children }: any) => React.createElement('div', null, children),
  },
  '@/components/ui/table': {
    Table: ({ children, ...p }: any) => React.createElement('table', p, children),
    TableHeader: ({ children, ...p }: any) => React.createElement('thead', p, children),
    TableBody: ({ children, ...p }: any) => React.createElement('tbody', p, children),
    TableRow: ({ children, ...p }: any) => React.createElement('tr', p, children),
    TableHead: ({ children, ...p }: any) => React.createElement('th', p, children),
    TableCell: ({ children, ...p }: any) => React.createElement('td', p, children),
  },
  '@/components/ui/badge': {
    Badge: ({ variant: _v, ...p }: any) => React.createElement('span', p),
  },
  '@/components/ui/button': {
    Button: React.forwardRef(function B({ variant: _v, size: _s, ...p }: any, ref: any) {
      return React.createElement('button', { ...p, ref })
    }),
  },
}


/** One render of the real mounted section against a given hook state. */
function render(nativeView: unknown, microsoftView: unknown): string {
  const hooks = compile('../api/risky-users-hooks.ts', {
    ...uiMocks,
    './risky-users-assessment-hooks': {
      useNativeRiskyUsersRead: () => ({
        cacheScope: 'probe-session',
        nativeView,
        assessmentLoading: false,
        assessmentRequestError: false,
        assessmentContractError: false,
        microsoftView,
        microsoftLoading: false,
        retryAssessment: () => undefined,
        retryMicrosoft: () => undefined,
      }),
    },
  })

  const section = compile('../../components/identity-risk/risky-users-section.tsx', {
    ...uiMocks,
    '@/lib/api/risky-users-hooks': hooks,
    './risk-assessment-drawer': { RiskAssessmentDrawer: () => null },
    '@/components/identity-risk/fleet-risk-assessment-drawer': {
      FleetRiskAssessmentDrawer: () => null,
    },
  })

  const dom = new JSDOM(
    renderToStaticMarkup(
      React.createElement((section as any).default, { tenantId: 'synthetic-tenant' })
    )
  )
  return ((dom.window.document.body.textContent ?? '') as string).replace(/\s+/g, ' ')
}

/** An assessment that RAN, covered its scope, and found nobody. The honest zero. */
const assessedAndEmpty = {
  available: true,
  run: {
    windowStart: '2026-09-12T09:00:00.000Z',
    windowEnd: '2026-09-13T09:00:00.000Z',
    completedAt: '2026-09-13T09:00:00.000Z',
  },
  collectors: [],
  coverage: [],
  subjectsNamed: true,
  count: {
    accuracy: 'EXACT',
    value: 0,
    covered: ['HV-ID-AUTH-005'],
    notCovered: [],
    evidenceRequested: ['SIGN_INS'],
  },
  withheld: [],
  findings: [],
  complete: true,
}

test('AN UNAVAILABLE ASSESSMENT ASSERTS NO EMPTINESS, IN ANY VOICE', () => {
  // **THIS FILE ARRIVED ASSERTING THE DEFECT.** Its assertions were
  // `match(/Not available/)` and `match(/0 detected by HawkView/)`, so it passed while the bug
  // existed — a test pinning the wrong outcome as the specification. Run unmodified against the
  // repaired component it failed on the second assertion, which is how the repair was confirmed
  // before these assertions were written.
  //
  // The measured render was three derived zeroes — "0 detected by HawkView", "0 active Microsoft
  // risk", "Showing 0 of 0 users" — beside a count whose own caption says this is not a zero and
  // not an all-clear. **The surface asserted emptiness in three voices while saying it could not
  // tell.** Live for the two organisations with no collection configured.
  const text = render(null, microsoftView)

  assert.match(text, /Users requiring review: Not available/, 'the count still says it cannot tell')

  // EVERY VOICE, NAMED SEPARATELY. One assertion over the whole string would go green the moment
  // somebody reworded a line, and these are three independent sites that were fixed separately.
  //
  // **NO `\b` ANCHORS, AND THAT IS NOT A STYLE CHOICE.** The rendered text runs together without
  // spaces — `...Not available0 detected by HawkView` — so a leading `\b` has no boundary to match
  // and the assertion can never fire. Both of these were written with one and **survived a revert
  // of the code they were checking**; only the footer assertion, which had no anchor, caught its
  // revert. A negative regex passes by missing, and a negative regex is the whole of this test.
  assert.doesNotMatch(text, /0 detected by HawkView/, 'the HawkView zero')
  assert.doesNotMatch(text, /0 active Microsoft risk/, 'the Microsoft zero')
  assert.doesNotMatch(text, /Showing 0 of 0/, 'the footer zero')
  assert.doesNotMatch(text, /No users requiring review found/, 'the table zero')

  // And what it says instead is the disclosure, not merely the absence of a number.
  assert.match(text, /not a zero and it is not an all-clear/)
})

test('POSITIVE CONTROL: AN ASSESSED, EMPTY TENANT STILL RENDERS ITS ZERO', () => {
  // **WITHOUT THIS THE FIX IS INDISTINGUISHABLE FROM DELETING THE NUMBERS.** `nativeRiskyUserCount`
  // and `nativeRiskyUserList` branch on the IDENTICAL condition, so a fix keyed on that condition
  // would silence a tenant that genuinely has nobody — the opposite error, and the one this
  // product exists to prevent. The distinction has to come from `accuracy`, and this is the test
  // that proves it did.
  const text = render(assessedAndEmpty, microsoftView)

  assert.match(text, /0 detected by HawkView/, 'an assessed empty tenant must still show its zero')
  assert.doesNotMatch(text, /Users requiring review: Not available/, 'and must not read as unknown')
})
