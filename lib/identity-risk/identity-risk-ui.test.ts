import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import test from 'node:test'
import * as adapter from './adapter.ts'
import * as presentation from './presentation.ts'
import { parseInvestigationAccess } from '../api/mailbox-investigation.ts'
import { addSyntheticFinding, boundedCount, evaluatedAt, observedAt, receiptTime, setHawkViewMeta, syntheticRiskResponses, unavailableMeta } from './test-fixtures.ts'

const require = createRequire(import.meta.url)
const React = require('react')
const { renderToStaticMarkup } = require('react-dom/server')
const { JSDOM } = require('jsdom')
const ts = require('typescript')

function compile(relativePath: string, mocks: Record<string, unknown>) {
  const exports: Record<string, any> = {}
  const source = readFileSync(new URL(relativePath, import.meta.url), 'utf8')
  const compiled = ts.transpileModule(source, { compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
  new Function('require', 'exports', compiled)((name: string) => mocks[name] ?? require(name), exports)
  return exports
}

// Render the real section + real hooks + real strict DTO adapter. Only external
// requests/auth and the separately tested explicit mailbox lookup are substituted.
function renderRisk(responses = syntheticRiskResponses(), options: {
  errors?: string[]; loading?: string[]; access?: unknown; tenantId?: string; cacheScope?: string
} = {}) {
  const queries: Record<string, any>[] = []
  const data: Record<string, unknown> = {
    'hawkview-summary': responses.hawkViewSummary,
    'hawkview-findings': responses.hawkViewFindings,
    'microsoft-risky-users': responses.microsoftRiskyUsers,
    'investigation-access': options.access ?? { version: 1, allowed: false },
  }
  const hooks = compile('../api/identity-risk-hooks.ts', {
    '@tanstack/react-query': { useQuery: (query: Record<string, any>) => {
      queries.push(query)
      const channel = query.queryKey[3]
      return { data: data[channel], isError: options.errors?.includes(channel) ?? false, isLoading: options.loading?.includes(channel) ?? false, refetch: async () => undefined }
    } },
    '@/components/providers/auth-provider': { useAuth: () => ({ cacheScope: options.cacheScope ?? 'synthetic-msp-owner-session' }) },
    './client': { apiClient: { get: () => { throw new Error('No network calls are allowed in synthetic UI tests') } } },
    './mailbox-investigation': { parseInvestigationAccess },
    '@/lib/identity-risk/adapter': adapter,
  })
  const section = compile('../../components/identity-risk/identity-risk-section.tsx', {
    '@/lib/api/identity-risk-hooks': hooks,
    '@/lib/identity-risk/presentation': presentation,
    '@/lib/utils': { cn: (...values: string[]) => values.filter(Boolean).join(' ') },
    '@/components/ui/badge': { Badge: ({ variant: _variant, ...props }: any) => React.createElement('span', props) },
    '@/components/ui/button': { Button: ({ variant: _variant, size: _size, ...props }: any) => React.createElement('button', props) },
    './mailbox-investigation': { MailboxInvestigation: () => React.createElement('button', { 'data-investigation': true }, 'Investigate affected mailbox') },
  })
  const markup = renderToStaticMarkup(React.createElement(section.default, { tenantId: options.tenantId ?? 'synthetic-tenant-1' }))
  const dom = new JSDOM(markup)
  const document = dom.window.document
  const hawkView = document.querySelector('[aria-labelledby="hawkview-identity-signals-heading"]')
  const microsoft = document.querySelector('[aria-labelledby="microsoft-entra-risky-users-heading"]')
  return { queries, dom, document, hawkView, microsoft, text: document.body.textContent ?? '' }
}

test('renders independent HawkView findings when Microsoft is unlicensed, unavailable, or fails to load', (t) => {
  t.mock.method(Date, 'now', () => receiptTime)
  for (const limitation of ['Microsoft Entra ID P2 is required for this evidence.', 'Current Microsoft Identity Protection evidence is unavailable.']) {
    const responses = syntheticRiskResponses()
    addSyntheticFinding(responses)
    Object.assign(responses.microsoftRiskyUsers, unavailableMeta(limitation))
    const rendered = renderRisk(responses)
    assert.match(rendered.hawkView?.textContent ?? '', /Mailbox forwarding outside verified domains requires review/)
    assert.match(rendered.microsoft?.textContent ?? '', new RegExp(limitation.replaceAll('.', '\\.')))
    assert.doesNotMatch(rendered.microsoft?.textContent ?? '', /No current Microsoft risky users reported/)
    assert.doesNotMatch(rendered.text, /APPROVED_EXTERNAL_FORWARDING|REVIEW_MAILBOX_RULE|EXCHANGE_ACCEPTED_DOMAINS|HAWKVIEW_IDENTITY_RISK/)
    assert.match(rendered.text, /Authorized external forwarding/)
    rendered.dom.window.close()
  }
  const responses = syntheticRiskResponses()
  addSyntheticFinding(responses)
  const rendered = renderRisk(responses, { errors: ['microsoft-risky-users'] })
  assert.match(rendered.hawkView?.textContent ?? '', /Reported mailbox/)
  assert.match(rendered.microsoft?.querySelector('[role="alert"]')?.textContent ?? '', /could not be loaded/)
  assert.match(rendered.microsoft?.textContent ?? '', /Retry Microsoft evidence/)
  rendered.dom.window.close()
})

test('disabled/no evaluation/current empty are distinct, with no invented gate diagnosis or green zero', (t) => {
  t.mock.method(Date, 'now', () => receiptTime)
  for (const limitation of ['HawkView identity signal evaluation is not enabled.', 'No completed shadow evaluation is available.']) {
    const responses = syntheticRiskResponses()
    setHawkViewMeta(responses, unavailableMeta(limitation, limitation.startsWith('No completed') ? 'NOT_EVALUATED' : 'UNAVAILABLE'))
    for (const key of Object.keys(responses.hawkViewSummary.counts)) responses.hawkViewSummary.counts[key] = boundedCount(0, false)
    const rendered = renderRisk(responses)
    assert.ok(rendered.hawkView?.textContent?.includes(limitation))
    assert.doesNotMatch(rendered.hawkView?.textContent ?? '', /No findings in evaluated evidence|Rules with reported outcomes|tenant opt|license|not opted/i)
    assert.equal(rendered.hawkView?.querySelector('[class*="emerald"]'), null)
    assert.match(rendered.microsoft?.textContent ?? '', /No current Microsoft risky users reported/)
    rendered.dom.window.close()
  }
  const rendered = renderRisk()
  assert.match(rendered.hawkView?.textContent ?? '', /No findings in evaluated evidence/)
  assert.match(rendered.hawkView?.textContent ?? '', /does not establish that any identity is safe/)
  assert.equal(rendered.hawkView?.querySelector('[class*="emerald"]'), null)
  rendered.dom.window.close()
})

test('partial and stale evidence retain findings and timestamps without hiding the caveat behind server context', (t) => {
  t.mock.method(Date, 'now', () => receiptTime)
  for (const meta of [
    { capability: 'PARTIAL', limitation: 'Shadow-mode findings are investigation leads; customer alert delivery is disabled.' },
    { status: 'STALE', freshness: 'STALE', limitation: 'Shadow-mode findings are investigation leads; customer alert delivery is disabled.' },
  ]) {
    const responses = syntheticRiskResponses()
    addSyntheticFinding(responses)
    setHawkViewMeta(responses, meta)
    const rendered = renderRisk(responses)
    const text = rendered.hawkView?.textContent ?? ''
    assert.match(text, /Reported mailbox/)
    assert.match(text, /Shadow-mode findings/)
    assert.match(text, meta.status === 'STALE' ? /must not be treated as current/ : /Missing coverage must not be treated as a zero/)
    assert.equal(rendered.hawkView?.querySelector('[class*="emerald"]'), null)
    for (const timestamp of [observedAt, evaluatedAt]) {
      const formatted = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(timestamp))
      assert.ok(text.includes(formatted))
    }
    assert.match(text, /Microsoft Graph mailbox-rule snapshot/)
    assert.match(text, /Microsoft Graph verified tenant domains/)
    rendered.dom.window.close()
  }
})

test('failed summary or findings load cannot reuse cached success; Microsoft stays independently visible', (t) => {
  t.mock.method(Date, 'now', () => receiptTime)
  for (const failedChannel of ['hawkview-summary', 'hawkview-findings']) {
    const responses = syntheticRiskResponses()
    addSyntheticFinding(responses)
    const rendered = renderRisk(responses, { errors: [failedChannel] })
    assert.match(rendered.hawkView?.textContent ?? '', /Unable to load/)
    assert.match(rendered.hawkView?.textContent ?? '', /Retry HawkView signals/)
    assert.doesNotMatch(rendered.hawkView?.textContent ?? '', /Reported mailbox|No findings in evaluated evidence/)
    assert.match(rendered.microsoft?.textContent ?? '', /No current Microsoft risky users reported/)
    rendered.dom.window.close()
  }
})

test('missing payloads and loading never render an empty success', (t) => {
  t.mock.method(Date, 'now', () => receiptTime)
  const responses = syntheticRiskResponses()
  responses.hawkViewSummary = null as any
  responses.microsoftRiskyUsers = null as any
  const missing = renderRisk(responses)
  assert.doesNotMatch(missing.text, /No findings in evaluated evidence|No current Microsoft risky users reported/)
  assert.match(missing.text, /has not been reported in a supported format/)
  missing.dom.window.close()
  const loading = renderRisk(syntheticRiskResponses(), { loading: ['hawkview-summary', 'microsoft-risky-users'] })
  assert.equal(loading.document.querySelectorAll('[aria-busy="true"]').length, 2)
  assert.doesNotMatch(loading.text, /No findings in evaluated evidence|No current Microsoft risky users reported/)
  loading.dom.window.close()
})

test('privileged mailbox action stays explicit, server-authorized, current, and scoped by MSP session and tenant', (t) => {
  t.mock.method(Date, 'now', () => receiptTime)
  const responses = syntheticRiskResponses()
  addSyntheticFinding(responses)
  for (const allowed of [false, true]) {
    const rendered = renderRisk(responses, { access: { version: 1, allowed }, tenantId: 'tenant-2', cacheScope: 'different-msp-session' })
    assert.equal(rendered.document.querySelectorAll('[data-investigation]').length, allowed ? 1 : 0)
    for (const query of rendered.queries) assert.deepEqual(query.queryKey.slice(0, 3), ['identity-risk', 'different-msp-session', 'tenant-2'])
    assert.doesNotMatch(rendered.text, /@|Affected mailbox:/)
    rendered.dom.window.close()
  }
  for (const options of [{ access: { version: 1, allowed: 'true' } }, { access: { version: 1, allowed: true }, errors: ['investigation-access'] }]) {
    const rendered = renderRisk(responses, options)
    assert.equal(rendered.document.querySelector('[data-investigation]'), null)
    rendered.dom.window.close()
  }
  setHawkViewMeta(responses, { status: 'STALE', freshness: 'STALE', limitation: 'Evidence is stale.' })
  const stale = renderRisk(responses, { access: { version: 1, allowed: true } })
  assert.equal(stale.document.querySelector('[data-investigation]'), null)
  stale.dom.window.close()
})

test('implemented scope is bounded to verified Graph domains without delivery, exfiltration, or complete scoring claims', (t) => {
  t.mock.method(Date, 'now', () => receiptTime)
  const rendered = renderRisk()
  assert.match(rendered.text, /exact normalized domain matching/)
  assert.match(rendered.text, /not the Exchange transport accepted-domain configuration/)
  assert.match(rendered.text, /Broader behavioral detection and scoring remain incomplete/)
  assert.match(rendered.text, /do not prove that an account is compromised, that mail was delivered, or that data was exfiltrated/)
  assert.match(rendered.text, /Rules with reported outcomes/)
  rendered.dom.window.close()
})
