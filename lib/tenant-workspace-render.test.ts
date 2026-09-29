import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve, dirname } from 'node:path'
import test from 'node:test'
import type { TenantBundle, TenantSyncStatus, SyncOutcomeProjection } from '../types/tenant-data.ts'
const require = createRequire(import.meta.url)
const React = require('react')
const { JSDOM } = require('jsdom')
const { createRoot } = require('react-dom/client')
const ts = require('typescript')
const base = resolve(dirname(new URL(import.meta.url).pathname), '..')
const cache = new Map<string, any>()
function load(path: string): any {
  if (cache.has(path)) return cache.get(path)
  const exports: any = {}
  cache.set(path, exports)
  const js = ts.transpileModule(readFileSync(path, 'utf8'), {
    fileName: path, compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText
  new Function('require', 'exports', js)((name: string) => {
    if (name === 'next/link') return { __esModule: true, default: ({children, ...props}: any) => React.createElement('a', props, children) }
    if (!name.startsWith('.') && !name.startsWith('@/')) return require(name)
    const target = name.startsWith('@/') ? resolve(base, name.slice(2)) : resolve(dirname(path), name)
    const file = [target, target + '.tsx', target + '.ts'].find(p => existsSync(p))!
    return load(file)
  }, exports)
  return exports
}
const { deriveTenantWorkspaceDisplay } = load(resolve(base, 'lib/tenant-workspace-state.ts'))
const { TenantOverview } = load(resolve(base, 'app/(protected)/tenants/[id]/components/tenant-overview.tsx'))
const { ModuleHeader } = load(resolve(base, 'app/(protected)/tenants/[id]/components/module-header.tsx'))
const { projectSyncOutcome } = load(resolve(base, 'backend/src/tenants/sync-outcome-projection.ts'))
const stamp = '2026-09-29T12:00:00.000Z'
function keyFor(kind: SyncOutcomeProjection['recordedOutcome']['kind']) {
  return kind === 'LIMITED_COLLECTION_RECORDED' || kind === 'INITIALIZATION_WAIT_RECORDED' ? 'signIns'
    : kind === 'DEFERRED_WORK_RECORDED' ? 'm365Audit' : 'users'
}
function entry(kind: SyncOutcomeProjection['recordedOutcome']['kind'], status = 'running'): TenantSyncStatus {
  const key = keyFor(kind)
  const resource = key === 'signIns' ? 'SIGN_INS' : key === 'm365Audit' ? 'M365_AUDIT' : 'USERS'
  const raw = kind === 'AWAITING_EXECUTION' ? 'queued' : status
  const code = kind === 'LIMITED_COLLECTION_RECORDED' ? 'sign-ins-non-premium-fallback-active'
    : kind === 'INITIALIZATION_WAIT_RECORDED' ? 'sign-ins-audit-subscription-initializing'
      : kind === 'DEFERRED_WORK_RECORDED' ? 'm365-audit-backlog' : null
  return { status: raw, lastSuccessfulAt: stamp, lastError: null,
    outcomeProjection: projectSyncOutcome(resource, { status: raw.toUpperCase(), lastSuccessfulAt: new Date(stamp),
      lastAttemptAt: new Date(stamp), lastErrorCode: code }, new Date('2026-09-29T13:00:00.000Z')) }
}

function bundle(sync: TenantBundle['sync'], id = 'tenant-a'): TenantBundle {
  return { tenant: { id, status: 'connected' }, users: [], signIns: [], exchange: {}, sharepoint: {}, teams: {}, sync }
}
const { tenantActionableHealthProjection } = load(resolve(base, 'lib/attention/computeTenantAttention.ts'))
const { tenantFindingProvenance, collectorAttentionProvenance, accessProvenance } = load(resolve(base, 'backend/src/tenants/attention-provenance.ts'))
const healthy = tenantActionableHealthProjection({data:{status:'COMPLETE'},attention:[]})
async function mounted(run: (h: {
  render: (data: TenantBundle, options?: { manual?: boolean; health?: any; evidence?: any; freshness?: any }) => Promise<void>
  text: () => string; click: (label: string) => Promise<void>; document: any
}) => Promise<void>) {
  const dom = new JSDOM('<div id="root"></div>', { url: 'https://synthetic.invalid' })
  const saved = new Map(['window', 'document', 'navigator', 'IS_REACT_ACT_ENVIRONMENT'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]))
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, navigator: dom.window.navigator, IS_REACT_ACT_ENVIRONMENT: true })) {
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value })
  }
  const root = createRoot(dom.window.document.getElementById('root'))
  try {
    await run({
      render: async (data, options = {}) => {
        const display = deriveTenantWorkspaceDisplay(data, options.manual ?? false, options.evidence ?? null, Object.prototype.hasOwnProperty.call(options, 'health') ? options.health : healthy)
        await React.act(async () => root.render(React.createElement(React.Fragment, null,
          React.createElement(ModuleHeader, { section: 'overview', display, freshness: options.freshness }),
          React.createElement(TenantOverview, { bundle: data, display, isSyncing: options.manual ?? false,
            onOpenModule: () => {}, onSync: () => {}, riskyUsers: React.createElement('p', null, `${data.tenant.id}: 2 identities require review`) }))))
      },
      text: () => dom.window.document.body.textContent,
      click: async label => {
        const button = [...dom.window.document.querySelectorAll('button')].find((b: any) => b.textContent === label) as any
        assert.ok(button, `Missing button: ${label}`)
        await React.act(async () => button.click())
      }, document: dom.window.document,
    })
  } finally {
    await React.act(async () => root.unmount())
    for (const [key, descriptor] of Array.from(saved)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else delete (globalThis as any)[key]
    }
    dom.window.close()
  }
}
function noActiveClaim(text: string) {
  assert.doesNotMatch(text, /Collecting Microsoft 365|Synchronization (?:is )?in progress|Initial sync in progress|Collecting now|Populating progressively|All Microsoft 365 services and permissions are operating normally|Syncing/i)
}


const mixed = () => tenantActionableHealthProjection({data:{status:'PARTIAL'},attention:[
 {key:'risk',label:'Microsoft risk reported',why:'Two identities have positive evidence; the total is unknown.',severity:'high',provenance:tenantFindingProvenance('MICROSOFT_ACTIVE_RISK')},
 {key:'access',label:'Microsoft consent required',why:'Explicit required consent is missing.',severity:'high',provenance:accessProvenance('AUTHORIZATION_REQUIRED',true)},
 {key:'ops',label:'INTERNAL_COLLECTOR_SENTINEL',why:'PRIVATE_DIAGNOSTIC_SENTINEL',severity:'critical',provenance:collectorAttentionProvenance('USERS','HAWKVIEW_INTERNAL_FAILURE')},
 {key:'legacy',label:'UNKNOWN_SENTINEL',why:'Historical unclassified evidence',severity:'critical'},
]})
test('mixed customer overview shows positives and access separately without collector wall', async () => mounted(async h => {
 await h.render(bundle({users:{status:'failed',lastError:'RAW_DIAGNOSTIC',lastSuccessfulAt:stamp}}),{health:mixed()})
 assert.equal(h.document.querySelector('a[href="/tenants/tenant-a/settings?tab=collection"]')?.textContent.includes('View collection'),true)
 assert.match(h.text(),/1 reported finding/);assert.match(h.text(),/Microsoft risk reported/);assert.match(h.text(),/Customer access setup/)
 assert.match(h.text(),/Evidence incomplete/);assert.match(h.text(),/2 identities require review/)
 assert.doesNotMatch(h.text(),/INTERNAL_COLLECTOR_SENTINEL|PRIVATE_DIAGNOSTIC_SENTINEL|UNKNOWN_SENTINEL|RAW_DIAGNOSTIC|Retry synchronization/)
 assert.equal(h.document.querySelectorAll('[aria-label="Dataset update times"]').length,1)
 noActiveClaim(h.text())
}))
test('unknown and operations-only summaries never render clean or zero risk', async () => mounted(async h => {
 for(const health of [null,tenantActionableHealthProjection({attention:[{key:'ops',label:'Operator failure',why:'Collector failed',severity:'critical',provenance:collectorAttentionProvenance('USERS',null)}]})]) {
  await h.render(bundle({}),{health});assert.match(h.text(),/Finding total unavailable/);assert.match(h.text(),/Evidence incomplete/)
  assert.doesNotMatch(h.text(),/Operator failure|No active issues|Posture Healthy|0 reported findings/)
 }
}))
test('A to B to A does not retain findings or expose diagnostics from another tenant', async () => mounted(async h => {
 await h.render(bundle({},'tenant-a'),{health:mixed(),manual:true});assert.match(h.text(),/Microsoft risk reported/)
 await h.render(bundle({},'tenant-b'),{health:null});assert.doesNotMatch(h.text(),/Microsoft risk reported|Microsoft consent required|Synchronization request pending|tenant-a/)
 await h.render(bundle({},'tenant-a'),{health:mixed()});assert.match(h.text(),/Microsoft risk reported/);assert.doesNotMatch(h.text(),/tenant-b|Synchronization request pending/)
}))
test('dataset clocks remain scoped and never use newest unrelated success', async () => mounted(async h => {
 await h.render(bundle({users:{status:'succeeded',lastSuccessfulAt:stamp,lastError:null}}),{health:healthy})
 const ages=h.document.querySelector('[aria-label="Dataset update times"]').textContent
 assert.equal((ages.match(/Update time unavailable/g)||[]).length,3)
 assert.doesNotMatch(ages,/Updated .*ago/)
 assert.match(h.text(),/No findings reported/);assert.doesNotMatch(h.text(),/Healthy|0 risk/)
}))
