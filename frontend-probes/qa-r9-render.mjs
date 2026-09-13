// QA — R9. RENDER THE ASSEMBLED SCREEN AND READ WHAT A PERSON WOULD SEE, ICON INCLUDED.
//
// Registered before this code existed, at blob cfb695de / c2aeef8c: "the recurring defect in this
// product is a true sentence in the wrong company, and every instance passed its own tests. So the
// check renders the screen and reads what a person would see."
//
// THE THREE FIXTURES ARE THE ONES IN THE REGISTER, written before the implementation: four tenants
// all assessed and nothing found; three of four unreadable with the fourth finding nothing; and
// nothing assessed at all over a fleet whose size is unknown. They were not derived from this
// code, which is the whole point of a pre-registration.
//
// The page is the REAL `app/(protected)/risky-users/page.tsx`, transpiled and rendered with
// `renderToStaticMarkup`. Only the data hook and the drawer are replaced: the hook because it is
// the seam a fixture enters through, and the drawer because it renders nothing on an empty screen.
// Every icon, every string and the whole empty-state branch are the shipped ones.
import { readFileSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const React = require('react')
const { renderToStaticMarkup } = require('react-dom/server')
const ts = require('typescript')
const checkout = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

// ── a loader that compiles the real modules on demand ────────────────────────────────────────
const cache = new Map()
const mocks = new Map()

function resolveSpecifier(spec, fromDir) {
  let base
  if (spec.startsWith('@/')) base = join(checkout, spec.slice(2))
  else if (spec.startsWith('.')) base = resolve(fromDir, spec)
  else return null
  // statSync().isFile() rather than existsSync plus a trailing-slash guard: on Windows the guard
  // matched the file itself, so every '@/...' specifier fell through to node's own resolver and
  // NOTHING RENDERED — which read as a pass on four of the five fixtures.
  for (const ext of ['', '.tsx', '.ts', '.jsx', '.js', '/index.tsx', '/index.ts']) {
    try { if (statSync(base + ext).isFile()) return base + ext } catch { /* next */ }
  }
  return null
}

function load(file) {
  if (cache.has(file)) return cache.get(file)
  const source = readFileSync(file, 'utf8')
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022, esModuleInterop: true,
    },
  }).outputText
  const exports = {}
  cache.set(file, exports)
  const dir = dirname(file)
  const localRequire = (spec) => {
    if (mocks.has(spec)) return mocks.get(spec)
    const resolved = resolveSpecifier(spec, dir)
    if (resolved) return load(resolved)
    return require(spec)
  }
  new Function('require', 'exports', 'module', compiled)(localRequire, exports, { exports })
  return exports
}

// ── the fixtures, straight out of the register ───────────────────────────────────────────────
const tenant = (i) => ({ id: 'ten-' + i, displayName: 'Tenant ' + i, domain: 'ten' + i + '.example' })

const FIXTURES = {
  allClear: {
    what: 'four tenants, all assessed, nothing found — the only state a green shield may describe',
    tenants: [0, 1, 2, 3].map(tenant),
    tenantStatuses: [0, 1, 2, 3].map((i) => ({ tenantId: 'ten-' + i, status: 'SUCCESS' })),
  },
  threeOfFourUnreadable: {
    what: 'one assessed and found nothing; three could not be assessed — the bug report',
    tenants: [0, 1, 2, 3].map(tenant),
    tenantStatuses: [
      { tenantId: 'ten-0', status: 'SUCCESS' },
      { tenantId: 'ten-1', status: 'FAILED' },
      { tenantId: 'ten-2', status: 'UNAVAILABLE' },
      { tenantId: 'ten-3', status: 'UNAVAILABLE' },
    ],
  },
  nothingKnown: {
    what: 'nothing assessed at all, and the fleet size itself unknown',
    tenants: [],
    tenantStatuses: [],
  },
  // Two more the register implies but did not name, because a degenerate input is where a rule
  // that balances nothing goes quiet.
  everythingStillLoading: {
    what: 'four tenants, all still in flight — not an answer either way',
    tenants: [0, 1, 2, 3].map(tenant),
    tenantStatuses: [0, 1, 2, 3].map((i) => ({ tenantId: 'ten-' + i, status: 'LOADING' })),
  },
  fleetListFailedButTenantsKnown: {
    what: 'tenants exist, and not one of them produced a status row',
    tenants: [0, 1, 2, 3].map(tenant),
    tenantStatuses: [],
  },
  // THE PRODUCTION STATE, not a constructed one. `useTenants()` fails, so `tenantsResponse` is
  // undefined, `safeTenants` is `tenantsResponse?.tenants ?? []`, and the statuses loop over an
  // empty list. `isError` is returned by the hook and the page never consults it: the render
  // chain is `isLoading ? … : summary.empty ? …`.
  tenantListRequestFailed: {
    what: 'the tenant list request errored — the whole fleet is unreadable',
    tenants: [],
    tenantStatuses: [],
    isError: true,
  },
}

// ── read what a person would see ─────────────────────────────────────────────────────────────
const text = (html) => html.replace(/<[^>]*>/g, ' ').replace(/&#x27;/g, "'").replace(/&quot;/g, '"')
  .replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim()

/** Every shield icon, with the markup immediately around it, so the COLOUR is read rather than
 * assumed. A green shield is the claim; a grey or amber one is not. */
function shields(html) {
  const found = []
  const re = /<svg[^>]*class="[^"]*lucide-shield[^"]*"[^>]*>/g
  let m
  while ((m = re.exec(html)) !== null) {
    const before = html.slice(Math.max(0, m.index - 260), m.index)
    const cls = /class="([^"]*)"/.exec(m[0])?.[1] ?? ''
    const context = before.slice(before.lastIndexOf('<div'))
    const green = /emerald|green/.test(cls) || /emerald|green/.test(context)
    found.push({ icon: /lucide-shield-[a-z]+/.exec(cls)?.[0] ?? 'lucide-shield', green, cls, context: context.slice(0, 160) })
  }
  return found
}

async function main() {
  mocks.set('@/components/identity-risk/fleet-risk-assessment-drawer', {
    FleetRiskAssessmentDrawer: () => null,
  })

  const results = {}
  for (const [name, fixture] of Object.entries(FIXTURES)) {
    mocks.set('@/lib/api/fleet-risky-users-hooks', {
      useFleetRiskyUsers: () => ({
        tenants: fixture.tenants,
        fleetRows: [],
        tenantStatuses: fixture.tenantStatuses,
        metrics: {
          totalTenants: fixture.tenants.length,
          failedTenants: fixture.tenantStatuses.filter((s) => s.status === 'FAILED').length,
          totalHawkViewUsers: 0, totalMicrosoftUsers: 0, totalBothUsers: 0, totalRiskyUsers: 0,
        },
        isLoading: false, isError: fixture.isError === true, cacheScope: 'qa', retryAll: () => {},
      }),
    })
    cache.delete(join(checkout, 'app/(protected)/risky-users/page.tsx'))

    let html = ''
    let error = null
    try {
      const page = load(join(checkout, 'app/(protected)/risky-users/page.tsx'))
      html = renderToStaticMarkup(React.createElement(page.default))
    } catch (e) { error = String(e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : e) }

    const body = text(html)
    const icons = shields(html)
    results[name] = {
      what: fixture.what,
      error,
      RENDERED: html.length > 0,
      htmlBytes: html.length,
      // What a person reads, in the order they read it.
      headlineNear: /(\d+ users?(?: across [^<]*)?)/.exec(body)?.[1] ?? null,
      emptyTitle:
        /No users require review/.test(body) ? 'No users require review'
          : /No users to review among the tenants HawkView assessed/.test(body)
            ? 'No users to review among the tenants HawkView assessed'
            : /No users match the selected filters/.test(body) ? 'No users match the selected filters' : null,
      saysNotAssessed: /not assessed/.test(body),
      saysAllInScopeWereAssessed: /in scope were assessed/.test(body),
      detail: (/((?:All \d+ tenants? in scope were assessed[^.]*\.)|(?:\d+ of \d+ tenants? (?:was|were) not assessed[^.]*\.))/.exec(body) ?? [])[1] ?? null,
      shields: icons,
      GREEN_SHIELDS: icons.filter((s) => s.green).length,
      shieldKinds: [...new Set(icons.map((s) => s.icon))],
    }
  }

  const r = results
  console.log(JSON.stringify({
    QA_R9_RENDER: {
      boundTo: 'ed6f73b',
      register: 'published at cfb695de / c2aeef8c, before this code existed',
      method: 'the real page.tsx rendered with renderToStaticMarkup; only the data hook and the '
        + 'drawer are replaced. Every icon, string and branch is the shipped one.',
      results,

      // ══ THE REGISTER'S OWN QUESTIONS ══════════════════════════════════════════════════════
      R9_THE_THREE_FIXTURES_RENDER_DIFFERENTLY: new Set([
        JSON.stringify([r.allClear.emptyTitle, r.allClear.GREEN_SHIELDS]),
        JSON.stringify([r.threeOfFourUnreadable.emptyTitle, r.threeOfFourUnreadable.GREEN_SHIELDS]),
        JSON.stringify([r.nothingKnown.emptyTitle, r.nothingKnown.GREEN_SHIELDS]),
      ]).size === 3,

      R5_A_REASSURING_RENDERING_NEEDS_A_COMPLETE_READ: {
        allClear_earnsIt: r.allClear.GREEN_SHIELDS > 0,
        partialRead_refusedIt: r.threeOfFourUnreadable.GREEN_SHIELDS === 0,
        nothingAssessed_refusedIt: r.nothingKnown.GREEN_SHIELDS === 0,
        stillLoading_refusedIt: r.everythingStillLoading.GREEN_SHIELDS === 0,
        noStatusRowsAtAll_refusedIt: r.fleetListFailedButTenantsKnown.GREEN_SHIELDS === 0,
      },
    },
  }, null, 2))
}

main().catch((e) => { console.error('QA R9 RENDER FAILED:', e); process.exitCode = 1 })
