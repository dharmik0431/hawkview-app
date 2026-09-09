import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import test from 'node:test'
import * as adapter from './adapter.ts'
import * as presentation from './presentation.ts'
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
function renderRisk(
  assessment: unknown = assessmentFixture(),
  options: { errors?: string[]; loading?: string[]; microsoft?: unknown } = {}
) {
  const queries: Record<string, any>[] = []
  const data: Record<string, unknown> = {
    'hawkview-assessment': assessment,
    'microsoft-risky-users':
      options.microsoft ?? syntheticRiskResponses().microsoftRiskyUsers,
  }
  const hooks = compile('../api/identity-risk-hooks.ts', {
    '@tanstack/react-query': {
      useQuery: (query: Record<string, any>) => {
        queries.push(query)
        const key = query.queryKey[3]
        return {
          data: data[key],
          isError: options.errors?.includes(key) ?? false,
          isLoading: options.loading?.includes(key) ?? false,
          refetch: async () => undefined,
        }
      },
    },
    '@/components/providers/auth-provider': {
      useAuth: () => ({ cacheScope: 'synthetic-msp-session' }),
    },
    './client': {
      apiClient: {
        get: () => {
          throw new Error('No network requests in UI tests')
        },
      },
    },
    './mailbox-investigation': { parseInvestigationAccess: () => false },
    '@/lib/identity-risk/adapter': adapter,
  })
  const mocks = {
    '@/lib/api/identity-risk-hooks': hooks,
    '@/lib/identity-risk/presentation': presentation,
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
  const drawer = compile(
    '../../components/identity-risk/risk-assessment-drawer.tsx',
    mocks
  )
  const card = compile(
    '../../components/identity-risk/risk-assessment-card.tsx',
    { ...mocks, './risk-assessment-drawer': drawer }
  )
  const section = compile(
    '../../components/identity-risk/identity-risk-section.tsx',
    { ...mocks, './risk-assessment-card': card }
  )
  const markup = renderToStaticMarkup(
    React.createElement(section.default, { tenantId: 'synthetic-tenant' })
  )
  const dom = new JSDOM(markup)
  const document = dom.window.document
  const hawkView = document.querySelector(
    '[aria-labelledby="hawkview-identity-signals-heading"]'
  )
  const microsoft = document.querySelector(
    '[aria-labelledby="microsoft-entra-risky-users-heading"]'
  )
  return {
    dom,
    document,
    queries,
    hawkView,
    microsoft,
    Component: section.default,
    CardComponent: card.RiskAssessmentCard,
    text: document.body.textContent ?? '',
  }
}

test('old servers keep findings visible but never derive a headline count from rows', (t) => {
  t.mock.method(Date, 'now', () => assessmentNow)
  const value = assessmentFixture(true)
  delete value.summary
  const rendered = renderRisk(value)
  const text = rendered.hawkView?.textContent ?? ''
  assert.match(text, /Risky user count unavailable/)
  assert.ok(rendered.hawkView?.querySelector('[aria-label="Not available"]'))
  assert.match(text, /Repeated invalid credentials/)
  assert.doesNotMatch(text, /1Risky users identified/)
  rendered.dom.window.close()
})

test('partial tenant summaries lead with a distinct-user lower bound', (t) => {
  t.mock.method(Date, 'now', () => assessmentNow)
  const value = assessmentFixture(true)
  Object.assign(value.meta, {
    capability: 'PARTIAL',
    freshness: 'UNKNOWN',
    limitation: 'Coverage is limited to individually reported evidence.',
  })
  Object.assign(value.rules[2], {
    status: 'PARTIAL',
    reasonCode: 'INCOMPLETE_WINDOW',
    countsCapped: true,
  })
  value.summary.currentUsers = { value: 1, accuracy: 'AT_LEAST' }
  const rendered = renderRisk(value)
  assert.ok(rendered.hawkView?.querySelector('[aria-label="At least 1"]'))
  assert.match(
    rendered.hawkView?.textContent ?? '',
    /distinct-user lower bound/
  )
  rendered.dom.window.close()
})

test('one user with multiple findings counts once and mailbox-only rows stay supporting context', (t) => {
  t.mock.method(Date, 'now', () => assessmentNow)
  const value = assessmentFixture(true)
  value.users[0].findings.push({
    ...value.users[0].findings[0],
    id: 'hvr1_contribution_' + 'b'.repeat(64),
  })
  const mailbox = assessmentUser('HV-ID-MBX-001.v1', 'c')
  mailbox.label = 'Synthetic mailbox context'
  value.users.push(mailbox)
  const rendered = renderRisk(value)
  assert.ok(rendered.hawkView?.querySelector('[aria-label="1"]'))
  const primary = rendered.hawkView?.querySelector(
    '[aria-label="HawkView identified risky users"]'
  )
  assert.doesNotMatch(primary?.textContent ?? '', /Synthetic mailbox context/)
  assert.match(
    rendered.hawkView?.textContent ?? '',
    /Mailbox and historical context/
  )
  assert.equal(
    rendered.hawkView?.querySelectorAll('button[aria-haspopup="dialog"]')
      .length,
    2
  )
  rendered.dom.window.close()
})

test('failed refresh and invalid cached contracts withhold the count but preserve explicitly previous evidence', (t) => {
  t.mock.method(Date, 'now', () => assessmentNow)
  const seed = renderRisk(assessmentFixture(true))
  const exact = assessmentFixture(true)
  const partial = assessmentFixture(true)
  Object.assign(partial.meta, {
    capability: 'PARTIAL',
    freshness: 'UNKNOWN',
    limitation: 'Coverage is limited to individually reported evidence.',
  })
  Object.assign(partial.rules[2], {
    status: 'PARTIAL',
    reasonCode: 'INCOMPLETE_WINDOW',
    countsCapped: true,
  })
  partial.summary.currentUsers = { value: 1, accuracy: 'AT_LEAST' }
  for (const value of [exact, partial]) {
    const adapted = adapter.adaptRiskAssessmentResponse(value, assessmentNow)
    assert.ok(adapted)
    for (const flags of [
      { requestError: true, contractError: false },
      { requestError: false, contractError: true },
    ]) {
      const markup = renderToStaticMarkup(
        React.createElement(seed.CardComponent, {
          assessment: adapted,
          ...flags,
          onRetry: () => undefined,
        })
      )
      const dom = new JSDOM(markup)
      const text = dom.window.document.body.textContent ?? ''
      assert.ok(
        dom.window.document.querySelector('[aria-label="Not available"]')
      )
      assert.match(text, /Previously reported user evidence/)
      assert.match(text, /current count withheld/)
      assert.match(text, /Repeated invalid credentials/)
      assert.doesNotMatch(
        text,
        /Current user finding|1Risky users identified|≥1/
      )
      assert.ok(
        dom.window.document.querySelector('button[aria-haspopup="dialog"]')
      )
      dom.window.close()
    }
  }
  seed.dom.window.close()
})

test('Microsoft channel count remains separate and never claims an active-risk total', (t) => {
  t.mock.method(Date, 'now', () => assessmentNow)
  const microsoft = syntheticRiskResponses().microsoftRiskyUsers
  microsoft.users = [
    {
      id: 'microsoft-risk-1',
      identityLabel: 'Microsoft-reported user',
      riskLevel: 'high',
      riskState: 'atRisk',
      riskDetail: 'adminConfirmedUserCompromised',
      observedAt: '2026-09-02T12:00:00.000Z',
    },
  ]
  const rendered = renderRisk(assessmentFixture(), { microsoft })
  const text = rendered.microsoft?.textContent ?? ''
  assert.match(text, /1Microsoft records shown/)
  assert.match(text, /not an active-risk total/)
  assert.doesNotMatch(
    rendered.hawkView?.textContent ?? '',
    /Microsoft records shown/
  )
  rendered.dom.window.close()
})

test('real screen/hooks/adapter render independent HawkView positives when Microsoft cannot load', (t) => {
  t.mock.method(Date, 'now', () => assessmentNow)
  for (const microsoft of [
    {
      ...syntheticRiskResponses().microsoftRiskyUsers,
      ...unavailableMeta(
        'Microsoft Entra ID P2 is required for this evidence.'
      ),
    },
    null,
  ]) {
    const rendered = renderRisk(assessmentFixture(true), {
      microsoft,
      errors: microsoft ? [] : ['microsoft-risky-users'],
    })
    assert.match(
      rendered.hawkView?.textContent ?? '',
      /HawkView Risky Users[\s\S]*Repeated invalid credentials/
    )
    assert.match(
      rendered.hawkView?.textContent ?? '',
      /low investigation priority/
    )
    assert.match(
      rendered.microsoft?.textContent ?? '',
      microsoft ? /P2 is required/ : /could not be loaded/
    )
    assert.doesNotMatch(
      rendered.microsoft?.textContent ?? '',
      /No current Microsoft risky users reported/
    )
    rendered.dom.window.close()
  }
})

test('partial coverage and each unavailable readiness remain distinct while supported findings render', (t) => {
  t.mock.method(Date, 'now', () => assessmentNow)
  for (const [status, label] of [
    ['PARTIAL', 'Partial coverage'],
    ['WAITING', 'Waiting for first collection'],
    ['INSUFFICIENT_FIELDS', 'Insufficient record fields'],
    ['MISSING_PERMISSION', 'Permission required'],
    ['LICENSE_REQUIRED', 'License required'],
    ['STALE', 'Stale collection'],
    ['FAILED', 'Collection failed'],
  ]) {
    const value = assessmentFixture(true)
    Object.assign(value.meta, {
      capability: 'PARTIAL',
      freshness: 'UNKNOWN',
      limitation: 'One source is unavailable.',
    })
    value.summary.currentUsers = { value: 1, accuracy: 'AT_LEAST' }
    value.rules[2].status = status
    value.sources[2].status = status
    const rendered = renderRisk(value)
    const text = rendered.hawkView?.textContent ?? ''
    assert.ok(text.includes(label))
    assert.match(text, /Repeated invalid credentials/)
    assert.doesNotMatch(text, /No findings in evaluated evidence/)
    assert.match(text, /Evidence window/)
    assert.match(text, /Latest event/)
    assert.match(text, /Latest ingestion/)
    rendered.dom.window.close()
  }
})

test('complete evaluated empty, waiting, malformed, absent and loading never share an empty success', (t) => {
  t.mock.method(Date, 'now', () => assessmentNow)
  const complete = renderRisk()
  assert.match(
    complete.hawkView?.textContent ?? '',
    /No findings in evaluated evidence/
  )
  complete.dom.window.close()
  for (const value of [null, { version: 100 }, undefined]) {
    const rendered = renderRisk(value === undefined ? null : value)
    assert.doesNotMatch(
      rendered.hawkView?.textContent ?? '',
      /No findings in evaluated evidence/
    )
    assert.ok(rendered.hawkView?.querySelector('[role="alert"]'))
    rendered.dom.window.close()
  }
  const loading = renderRisk(null, {
    loading: ['hawkview-assessment', 'microsoft-risky-users'],
  })
  assert.equal(
    loading.document.querySelectorAll('[aria-busy="true"]').length,
    2
  )
  loading.dom.window.close()
})

test('failed refresh preserves prior findings with warning but cannot reuse cached empty success', (t) => {
  t.mock.method(Date, 'now', () => assessmentNow)
  for (const positive of [false, true]) {
    const rendered = renderRisk(assessmentFixture(positive), {
      errors: ['hawkview-assessment'],
    })
    const text = rendered.hawkView?.textContent ?? ''
    assert.match(text, /Unable to refresh assessment/)
    assert.match(text, /Previously loaded/)
    assert.match(text, /RISK_ASSESSMENT_REQUEST_FAILED/)
    assert.doesNotMatch(text, /No findings in evaluated evidence/)
    if (positive) assert.match(text, /Repeated invalid credentials/)
    assert.match(
      rendered.microsoft?.textContent ?? '',
      /No current Microsoft risky users reported/
    )
    rendered.dom.window.close()
  }
})

test('outage preserves historical findings without calling them remediated or current', (t) => {
  t.mock.method(Date, 'now', () => assessmentNow)
  const value = assessmentFixture(true)
  value.users[0].priority = null
  value.users[0].findings[0].activityState = 'HISTORICAL'
  value.summary.currentUsers = { value: null, accuracy: 'UNKNOWN' }
  Object.assign(value.meta, {
    capability: 'UNAVAILABLE',
    status: 'STALE',
    freshness: 'STALE',
    limitation: 'Collection is stale.',
  })
  const rendered = renderRisk(value)
  assert.match(rendered.hawkView?.textContent ?? '', /historical/)
  assert.match(rendered.hawkView?.textContent ?? '', /Stale assessment/)
  assert.doesNotMatch(
    rendered.hawkView?.textContent ?? '',
    /low investigation priority|No findings in evaluated evidence/
  )
  rendered.dom.window.close()
})

test('queries and row-detail state are scoped by authorized session and exact tenant', (t) => {
  t.mock.method(Date, 'now', () => assessmentNow)
  const rendered = renderRisk(assessmentFixture(true))
  for (const query of rendered.queries)
    assert.deepEqual(query.queryKey.slice(0, 3), [
      'identity-risk',
      'synthetic-msp-session',
      'synthetic-tenant',
    ])
  assert.equal(rendered.queries.length, 2)
  assert.ok(rendered.document.querySelector('button[aria-haspopup="dialog"]'))
  assert.doesNotMatch(
    rendered.text,
    /Current implemented check: mailbox forwarding|CRITICAL|HV-ID-AUTH-009/
  )
  rendered.dom.window.close()
})

test('real drawer opens, traps keyboard focus, closes with Escape and restores the trigger', async (t) => {
  t.mock.method(Date, 'now', () => assessmentNow)
  const rendered = renderRisk(assessmentFixture(true))
  const taskGlobals = globalThis as any
  const previous = {
    window: taskGlobals.window,
    document: taskGlobals.document,
    act: taskGlobals.IS_REACT_ACT_ENVIRONMENT,
  }
  taskGlobals.window = rendered.dom.window
  taskGlobals.document = rendered.document
  taskGlobals.IS_REACT_ACT_ENVIRONMENT = true
  const container = rendered.document.createElement('div')
  rendered.document.body.replaceChildren(container)
  const root = require('react-dom/client').createRoot(container)
  try {
    await React.act(async () =>
      root.render(
        React.createElement(rendered.Component, {
          tenantId: 'synthetic-tenant',
        })
      )
    )
    const trigger = container.querySelector(
      'button[aria-haspopup="dialog"]'
    ) as HTMLButtonElement
    trigger.focus()
    await React.act(async () => trigger.click())
    const dialog = rendered.document.querySelector('[role="dialog"]')!
    assert.ok(dialog)
    assert.match(dialog.textContent ?? '', /Synthetic identity/)
    const close = dialog.querySelector(
      'button[aria-label="Close investigation details"]'
    ) as HTMLButtonElement
    assert.equal(rendered.document.activeElement, close)
    rendered.document.dispatchEvent(
      new rendered.dom.window.KeyboardEvent('keydown', {
        key: 'Tab',
        shiftKey: true,
        bubbles: true,
      })
    )
    assert.ok(dialog.contains(rendered.document.activeElement))
    await React.act(async () =>
      rendered.document.dispatchEvent(
        new rendered.dom.window.KeyboardEvent('keydown', {
          key: 'Escape',
          bubbles: true,
        })
      )
    )
    assert.equal(rendered.document.querySelector('[role="dialog"]'), null)
    assert.equal(rendered.document.activeElement, trigger)
    await React.act(async () => trigger.click())
    await React.act(async () =>
      root.render(
        React.createElement(rendered.Component, { tenantId: 'other-tenant' })
      )
    )
    assert.equal(rendered.document.querySelector('[role="dialog"]'), null)
  } finally {
    await React.act(async () => root.unmount())
    taskGlobals.window = previous.window
    taskGlobals.document = previous.document
    taskGlobals.IS_REACT_ACT_ENVIRONMENT = previous.act
    rendered.dom.window.close()
  }
})
