// Synthetic static layout preview. No customer APIs, authentication or app hydration.
// Run from the frontend checkout: node --experimental-strip-types lib/identity-risk/preview-assessment.mjs
import { createServer } from 'node:http'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  adaptRiskAssessmentResponse,
  unavailableMicrosoftEntraRiskyUsers,
} from './adapter.ts'
import * as presentation from './presentation.ts'
import {
  assessmentFixture,
  assessmentUser,
  assessmentNow,
  at,
} from './assessment-test-fixtures.ts'

const require = createRequire(import.meta.url)
const React = require('react')
const { renderToStaticMarkup } = require('react-dom/server')
const ts = require('typescript')
const checkout = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
Date.now = () => assessmentNow

function compile(relativePath, mocks = {}) {
  const exports = {}
  const source = readFileSync(join(checkout, relativePath), 'utf8')
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      jsx: ts.JsxEmit.ReactJSX,
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText
  new Function('require', 'exports', compiled)(
    (name) => mocks[name] ?? require(name),
    exports
  )
  return exports
}

function sampleAssessment(empty) {
  const value = assessmentFixture(!empty)
  if (empty) return value
  value.users[0].label = 'Synthetic operations user'
  value.users[0].protection.conditionalAccess = {
    contractVersion: 1,
    source: 'EFFECTIVE_MFA_V1',
    status: 'COVERED_BY_CONDITIONAL_ACCESS',
    freshness: 'CURRENT',
    observedAt: at(-10),
    evaluatedAt: at(),
    reasonCodes: [],
    policies: [
      {
        id: 'synthetic-policy-1',
        name: 'Require MFA for staff',
        state: 'ENABLED',
        outcome: 'UNIVERSAL',
        materialConditions: [],
      },
    ],
  }
  value.users[0].protection.registration = {
    state: 'REGISTERED',
    source: 'MICROSOFT_GRAPH',
    observedAt: at(-10),
    freshness: 'CURRENT',
    reasonCode: 'VERIFIED',
  }
  value.users[0].protection.explanation =
    'Current policy coverage and event authentication are separate evidence. Protection does not reduce finding priority.'
  const second = assessmentUser('HV-ID-AUTH-005.v2', 'b')
  second.label = 'Synthetic service owner'
  value.users.push(second)
  Object.assign(value.rules[1], { matchedIdentities: 1 })
  Object.assign(value.sources[2], {
    status: 'MISSING_PERMISSION',
    reasonCode: 'MISSING_PERMISSION',
    explanation:
      'Mailbox-rule evidence requires a Microsoft read permission that is not available.',
    freshness: 'UNKNOWN',
    lastSuccessfulCollectionAt: null,
    window: { start: null, end: null },
  })
  Object.assign(value.rules[2], {
    status: 'MISSING_PERMISSION',
    reasonCode: 'MISSING_PERMISSION',
    explanation:
      'Mailbox forwarding could not be assessed because the required evidence is unavailable.',
    assessedIdentities: null,
    matchedIdentities: null,
    evaluatedAt: null,
    window: { start: null, end: null },
  })
  Object.assign(value.meta, {
    capability: 'PARTIAL',
    freshness: 'UNKNOWN',
    limitation:
      'Qualified authentication findings are available. Mailbox coverage is incomplete; missing evidence is not a clean result.',
  })
  value.summary.currentUsers = { value: 2, accuracy: 'AT_LEAST' }
  return value
}

function renderRoute(route) {
  const assessment = adaptRiskAssessmentResponse(
    sampleAssessment(route === '/empty'),
    assessmentNow
  )
  if (!assessment)
    throw new Error(
      'Synthetic preview fixture did not match the assessment contract.'
    )
  const utils = compile('lib/utils.ts')
  const shared = {
    '@/lib/utils': utils,
    '@/lib/identity-risk/presentation': presentation,
  }
  shared['@/components/ui/button'] = compile('components/ui/button.tsx', shared)
  shared['@/components/ui/badge'] = compile('components/ui/badge.tsx', shared)
  const drawer = compile(
    'components/identity-risk/risk-assessment-drawer.tsx',
    shared
  )
  const card = compile('components/identity-risk/risk-assessment-card.tsx', {
    ...shared,
    './risk-assessment-drawer': drawer,
  })
  const section = compile(
    'components/identity-risk/identity-risk-section.tsx',
    {
      ...shared,
      './risk-assessment-card': card,
      '@/lib/api/identity-risk-hooks': {
        useIdentityRiskChannels: () => ({
          cacheScope: 'synthetic-preview-session',
          assessmentView: assessment,
          assessmentLoading: false,
          assessmentRequestError: route === '/error',
          assessmentContractError: false,
          microsoftView: unavailableMicrosoftEntraRiskyUsers(
            'UNAVAILABLE',
            'Independent Microsoft Entra risky-user evidence is unavailable in this synthetic example.'
          ),
          microsoftLoading: false,
          retryAssessment: async () => undefined,
          retryMicrosoft: async () => undefined,
        }),
      },
    }
  )
  const content = React.createElement(
    React.Fragment,
    null,
    React.createElement(section.default, { tenantId: 'synthetic-tenant' }),
    route === '/drawer'
      ? React.createElement(drawer.RiskAssessmentDrawer, {
          user: assessment.users[0],
          onClose: () => undefined,
        })
      : null
  )
  const title =
    route === '/drawer'
      ? 'Finding drawer'
      : route === '/empty'
        ? 'Complete evaluated empty'
        : route === '/error'
          ? 'Refresh failure with retained findings'
          : 'Partial coverage with positive findings'
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>Synthetic HawkView preview · ${title}</title><link rel="stylesheet" href="/preview.css"><style>body{margin:0;font-family:Arial,Helvetica,sans-serif;background:#f8fafc;color:#0f172a}.preview-header{padding:16px 28px;border-bottom:1px solid #cbd5e1;background:#fff}.preview-header p{margin:0 0 10px;font-size:13px}.preview-header nav{display:flex;flex-wrap:wrap;gap:18px;font-size:13px}.preview-header a{color:#1d4ed8;text-decoration:underline}main{max-width:1480px;margin:0 auto;padding:28px}.preview-marker{position:fixed;left:12px;bottom:12px;z-index:70;padding:7px 10px;background:#0f172a;color:#fff;border-radius:6px;font-size:11px}@media(max-width:640px){main{padding:16px}.preview-header{padding:16px}}</style></head><body><header class="preview-header"><p><strong>Synthetic static layout preview</strong> · ${title} · Fixture time: 2026-09-08 22:00 UTC</p><nav aria-label="Synthetic preview screens"><a href="/">Partial positive</a><a href="/drawer">Open drawer</a><a href="/empty">Complete empty</a><a href="/error">Refresh error</a></nav><p style="margin-top:10px;margin-bottom:0;color:#475569">No customer data or API calls. Application controls are static; this page previews layout only.</p></header><main>${renderToStaticMarkup(content)}</main><aside class="preview-marker">Synthetic data · Static preview</aside></body></html>`
}

function builtCss() {
  const directory = join(checkout, '.next/static/css')
  if (!existsSync(directory)) return null
  const files = readdirSync(directory)
    .filter((name) => /^[A-Za-z0-9._-]+\.css$/.test(name))
    .sort()
  return files.length > 0
    ? files
        .map((name) => readFileSync(join(directory, name), 'utf8'))
        .join('\n')
    : null
}

const server = createServer((request, response) => {
  response.setHeader('Cache-Control', 'no-store')
  response.setHeader('X-HawkView-Preview', 'synthetic-static-layout-only')
  response.setHeader('X-Content-Type-Options', 'nosniff')
  response.setHeader(
    'Content-Security-Policy',
    "default-src 'none'; style-src 'self' 'unsafe-inline'; img-src data:; font-src 'self'; connect-src 'none'; base-uri 'none'; form-action 'none'"
  )
  const route = new URL(request.url ?? '/', 'http://127.0.0.1:3017').pathname
  try {
    if (route === '/preview.css') {
      const css = builtCss()
      response.writeHead(css === null ? 503 : 200, {
        'Content-Type': 'text/css; charset=utf-8',
      })
      response.end(
        css ??
          '/* Build CSS is not available yet. Refresh after npm run build completes. */'
      )
      return
    }
    if (!['/', '/drawer', '/empty', '/error'].includes(route)) {
      response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
      response.end('Synthetic preview route not found.')
      return
    }
    const markup = renderRoute(route)
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    response.end(markup)
  } catch (error) {
    console.error('Synthetic layout preview failed:', error)
    if (!response.headersSent)
      response.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' })
    response.end(
      'Synthetic layout preview failed. Check the local preview terminal.'
    )
  }
})

server.listen(3017, '127.0.0.1', () => {
  console.log('Synthetic static HawkView layout preview: http://127.0.0.1:3017')
  console.log(
    'Routes: / · /drawer · /empty · /error. CSS is read from .next/static/css on each request.'
  )
})
