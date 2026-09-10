// Synthetic static layout preview for the rebuilt Risky Users surface.
// No customer APIs, authentication or app hydration.
// Run from the frontend checkout, after `npm run build` has produced CSS:
//   node --experimental-strip-types lib/identity-risk/preview-risky-users.mjs
import { createServer } from 'node:http'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  adaptMicrosoftRiskyUsersResponse,
  adaptRiskAssessmentResponse,
  unavailableMicrosoftEntraRiskyUsers,
} from './adapter.ts'
import * as presentation from './presentation.ts'
import * as riskyUsersView from './risky-users-view.ts'
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
  const compiled = ts.transpileModule(
    readFileSync(join(checkout, relativePath), 'utf8'),
    {
      compilerOptions: {
        jsx: ts.JsxEmit.ReactJSX,
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
      },
    }
  ).outputText
  new Function('require', 'exports', compiled)(
    (name) => mocks[name] ?? require(name),
    exports
  )
  return exports
}

/** Most customer tenants: HawkView reporting, Microsoft blocked on P2. */
const microsoftWithoutP2 = () =>
  unavailableMicrosoftEntraRiskyUsers(
    'UNAVAILABLE',
    'Microsoft Entra risky-user evidence is not available on this tenant.',
    'LICENSE_REQUIRED'
  )

/**
 * A tenant whose Microsoft channel is live: threat-intelligence verdicts that
 * were already in the sign-in evidence, with no API call, consent or purchase.
 */
const microsoftLive = () =>
  adaptMicrosoftRiskyUsersResponse({
    version: 1,
    channel: 'MICROSOFT_ENTRA_RISKY_USERS',
    engineVersion: null,
    catalogVersion: 'microsoft-entra-risky-users/v1',
    sourceLabel: 'Microsoft Entra Risky Users',
    capability: 'FULL',
    status: 'AVAILABLE',
    freshness: 'CURRENT',
    limitation: null,
    evaluatedAt: at(),
    observedAt: at(-20),
    users: [
      {
        id: 'microsoft-record-1',
        identityLabel: 'Synthetic finance user',
        riskLevel: 'high',
        riskState: 'atRisk',
        riskDetail: null,
        observedAt: at(-20),
      },
      {
        id: 'microsoft-record-2',
        identityLabel: 'Synthetic sales user',
        riskLevel: 'medium',
        riskState: 'dismissed',
        riskDetail: null,
        observedAt: at(-30),
      },
      {
        id: 'microsoft-record-3',
        identityLabel: 'Synthetic support user',
        riskLevel: 'low',
        riskState: 'remediated',
        riskDetail: null,
        observedAt: at(-40),
      },
    ],
    pageInfo: { hasMore: true, nextCursor: 'cursor.abc' },
  })

const sharedKey = {
  available: true,
  shape: 'DIRECTORY_OBJECT_ID',
  ref: '11111111-2222-3333-4444-555555555555',
}

/** Both channels reporting the same person, joined on the directory object. */
const microsoftCorrelated = () =>
  adaptMicrosoftRiskyUsersResponse({
    version: 1,
    channel: 'MICROSOFT_ENTRA_RISKY_USERS',
    engineVersion: null,
    catalogVersion: 'microsoft-entra-risky-users/v1',
    sourceLabel: 'Microsoft Entra Risky Users',
    capability: 'FULL',
    status: 'AVAILABLE',
    freshness: 'CURRENT',
    limitation: null,
    evaluatedAt: at(),
    observedAt: at(-20),
    users: [
      {
        id: 'microsoft-record-1',
        identityLabel: 'Alice Chen',
        correlation: sharedKey,
        riskLevel: 'high',
        riskState: 'atRisk',
        riskDetail: null,
        observedAt: at(-20),
      },
      {
        id: 'microsoft-record-2',
        identityLabel: 'Synthetic sales user',
        correlation: {
          available: true,
          shape: 'DIRECTORY_OBJECT_ID',
          ref: '99999999-8888-7777-6666-555555555555',
        },
        riskLevel: 'medium',
        riskState: 'dismissed',
        riskDetail: 'aiConfirmedSigninSafe',
        observedAt: at(-30),
      },
    ],
    pageInfo: { hasMore: false, nextCursor: null },
  })

/** One identity reported by both channels, resolved to a name and address. */
function correlatedFindings() {
  const value = withFindings()
  Object.assign(value.users[0], {
    correlation: sharedKey,
    displayName: 'Alice Chen',
    userPrincipalName: 'alice.chen@synthetic.invalid',
  })
  return value
}

/** Findings that cannot be tied to people, so the count is withheld. */
function unresolvedMailboxes() {
  const value = assessmentFixture(true)
  value.users = ['a', 'b', 'c'].map((character) => {
    const user = assessmentUser('HV-ID-MBX-001.v1', character)
    user.label = `Synthetic shared mailbox ${character.toUpperCase()}`
    return user
  })
  value.rules[0].matchedIdentities = 0
  value.rules[2].assessedIdentities = 3
  value.rules[2].matchedIdentities = 3
  value.summary.currentUsers = {
    value: null,
    accuracy: 'UNKNOWN',
    reason: 'UNRESOLVED_SUBJECT_IDENTITY',
  }
  return value
}

/** Sign-in codes outside HawkView's vocabulary withhold the exact claim. */
function uninterpretableEvidence() {
  const value = withFindings()
  value.summary.currentUsers = {
    value: null,
    accuracy: 'UNKNOWN',
    reason: 'UNINTERPRETABLE_EVIDENCE',
  }
  return value
}

/** An audit-log-fallback tenant, where one check has nothing to run against. */
function inapplicableCheck() {
  const value = assessmentFixture(false)
  Object.assign(value.rules[2], {
    status: 'INAPPLICABLE',
    reasonCode: 'CHECK_NOT_APPLICABLE',
    explanation:
      'This tenant’s audit-log evidence carries no mailbox-rule detail, so this check has nothing to evaluate.',
    assessedIdentities: null,
    matchedIdentities: null,
    evaluatedAt: null,
    window: { start: null, end: null },
  })
  return value
}

function withFindings() {
  const value = assessmentFixture(true)
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
  const second = assessmentUser('HV-ID-AUTH-005.v2', 'b')
  second.label = 'Synthetic service owner'
  value.users.push(second)
  const mailbox = assessmentUser('HV-ID-MBX-001.v1', 'c')
  mailbox.label = 'Synthetic shared mailbox'
  value.users.push(mailbox)
  Object.assign(value.rules[1], { matchedIdentities: 1 })
  Object.assign(value.rules[2], { matchedIdentities: 1 })
  // Two distinct USER subjects have a current finding; the mailbox is
  // supporting context and is deliberately not part of the total.
  value.summary.currentUsers = { value: 2, accuracy: 'EXACT' }
  return value
}

/** Findings present, but one evidence source is missing a permission. */
function partialCoverage() {
  const value = withFindings()
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

const routes = {
  '/': {
    title: 'List — partial coverage, lower-bound count',
    fixture: partialCoverage,
  },
  '/exact': {
    title: 'List — complete coverage, exact count',
    fixture: withFindings,
  },
  '/clean': {
    title: 'List — genuinely clean, zero shown with its gaps',
    fixture: () => assessmentFixture(false),
  },
  '/unreadable': {
    title: 'List — response arrived but could not be read',
    fixture: () => assessmentFixture(false),
    contractFailed: true,
  },
  '/stale': {
    title: 'List — refresh failed, earlier findings retained',
    fixture: withFindings,
    requestFailed: true,
  },
  '/count': {
    title: 'Tenant overview — the count card',
    fixture: partialCoverage,
    card: true,
  },
  '/count-clean': {
    title: 'Tenant overview — a zero that discloses what it misses',
    fixture: () => assessmentFixture(false),
    card: true,
  },
  '/withheld-identity': {
    title: 'Count withheld — findings cannot be tied to people',
    fixture: unresolvedMailboxes,
  },
  '/withheld-evidence': {
    title: 'Count withheld — evidence could not be interpreted',
    fixture: uninterpretableEvidence,
  },
  '/inapplicable': {
    title: 'Scoped zero — one check cannot run on this tenant',
    fixture: inapplicableCheck,
  },
  '/count-withheld': {
    title: 'Tenant overview — a withheld count with what is known',
    fixture: unresolvedMailboxes,
    card: true,
  },
  '/microsoft-live': {
    title: 'Microsoft channel live — its own records, never merged',
    fixture: withFindings,
    microsoft: microsoftLive,
  },
  '/correlated': {
    title: 'Both channels — one user reported by HawkView and Microsoft',
    fixture: correlatedFindings,
    microsoft: microsoftCorrelated,
  },
  '/drawer': {
    title: 'Detail — one user, evidence and next steps',
    fixture: withFindings,
    drawer: true,
  },
}

function renderRoute(path) {
  const route = routes[path]
  const assessment = adaptRiskAssessmentResponse(route.fixture(), assessmentNow)
  if (!assessment)
    throw new Error(
      `Synthetic preview fixture for ${path} did not match the assessment contract.`
    )

  const utils = compile('lib/utils.ts')
  const shared = {
    '@/lib/utils': utils,
    '@/lib/identity-risk/presentation': presentation,
    '@/lib/identity-risk/risky-users-view': riskyUsersView,
  }
  shared['@/components/ui/button'] = compile('components/ui/button.tsx', shared)
  shared['@/components/ui/badge'] = compile('components/ui/badge.tsx', shared)

  const identityRiskHooks = {
    useIdentityRiskChannels: () => ({
      cacheScope: 'synthetic-preview-session',
      assessmentView: route.contractFailed ? null : assessment,
      assessmentLoading: false,
      assessmentRequestError: Boolean(route.requestFailed),
      assessmentContractError: Boolean(route.contractFailed),
      microsoftView: (route.microsoft ?? microsoftWithoutP2)(),
      microsoftLoading: false,
      retryAssessment: async () => undefined,
      retryMicrosoft: async () => undefined,
    }),
  }
  const hooks = compile('lib/api/risky-users-hooks.ts', {
    ...shared,
    './identity-risk-hooks': identityRiskHooks,
  })
  const drawer = compile(
    'components/identity-risk/risk-assessment-drawer.tsx',
    shared
  )
  const section = compile('components/identity-risk/risky-users-section.tsx', {
    ...shared,
    '@/lib/api/risky-users-hooks': hooks,
    './risk-assessment-drawer': drawer,
  })
  const card = compile('components/identity-risk/risky-users-count-card.tsx', {
    ...shared,
    '@/lib/api/risky-users-hooks': hooks,
  })

  const content = route.card
    ? React.createElement(card.RiskyUsersCountCard, {
        tenantId: 'synthetic-tenant',
        onOpen: () => undefined,
      })
    : React.createElement(
        React.Fragment,
        null,
        React.createElement(section.default, { tenantId: 'synthetic-tenant' }),
        route.drawer
          ? React.createElement(drawer.RiskAssessmentDrawer, {
              user: assessment.users[0],
              onClose: () => undefined,
            })
          : null
      )

  const nav = Object.entries(routes)
    .map(([href, value]) => `<a href="${href}">${value.title}</a>`)
    .join('')

  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>Risky Users preview · ${route.title}</title><link rel="stylesheet" href="/preview.css"><style>body{margin:0;font-family:Arial,Helvetica,sans-serif;background:#f8fafc;color:#0f172a}.preview-header{padding:16px 28px;border-bottom:1px solid #cbd5e1;background:#fff}.preview-header p{margin:0 0 10px;font-size:13px}.preview-header nav{display:flex;flex-direction:column;gap:6px;font-size:13px}.preview-header a{color:#1d4ed8}main{max-width:1180px;margin:0 auto;padding:28px}.preview-marker{position:fixed;left:12px;bottom:12px;z-index:70;padding:7px 10px;background:#0f172a;color:#fff;border-radius:6px;font-size:11px}@media(max-width:640px){main{padding:16px}.preview-header{padding:16px}}</style></head><body><header class="preview-header"><p><strong>Synthetic static layout preview</strong> · ${route.title} · Fixture time: 2026-09-08 22:00 UTC</p><nav aria-label="Preview screens">${nav}</nav><p style="margin-top:10px;margin-bottom:0;color:#475569">No customer data or API calls. Controls are static; this previews layout and copy only. Most routes show a tenant unlicensed for Entra ID P2; the Microsoft-live route shows one whose Microsoft channel is already reporting.</p></header><main>${renderToStaticMarkup(content)}</main><aside class="preview-marker">Synthetic data · Static preview</aside></body></html>`
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
  const path = new URL(request.url ?? '/', 'http://127.0.0.1:3018').pathname
  try {
    if (path === '/preview.css') {
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
    if (!Object.hasOwn(routes, path)) {
      response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
      response.end('Synthetic preview route not found.')
      return
    }
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    response.end(renderRoute(path))
  } catch (error) {
    console.error('Synthetic Risky Users preview failed:', error)
    if (!response.headersSent)
      response.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' })
    response.end('Synthetic preview failed. Check the local preview terminal.')
  }
})

server.listen(3018, '127.0.0.1', () => {
  console.log('Synthetic Risky Users layout preview: http://127.0.0.1:3018')
  console.log(`Routes: ${Object.keys(routes).join(' · ')}`)
})
