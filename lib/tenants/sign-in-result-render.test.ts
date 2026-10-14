import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve, dirname } from 'node:path'
import test from 'node:test'
const require = createRequire(import.meta.url)
const React = require('react'), { JSDOM } = require('jsdom'), { createRoot } = require('react-dom/client'), ts = require('typescript')
const base = resolve(dirname(new URL(import.meta.url).pathname), '../..')
const cache = new Map<string, any>()
function load(path: string): any {
  if (cache.has(path)) return cache.get(path)
  const exports: any = {}; cache.set(path, exports)
  const js = ts.transpileModule(readFileSync(path, 'utf8'), { fileName: path,
    compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText
  new Function('require', 'exports', js)((name: string) => {
    if (name === 'maplibre-gl') return { __esModule: true, default: {} }
    // The overview section now renders two authenticated, query-backed panels. This file's subject
    // is the composed posture from sign-in outcomes, not those panels, and this loader supplies no
    // auth provider or query client — so they are stubbed to nothing here. Their own suites cover
    // them against the real providers; stubbing them changes no assertion in this file.
    if (name === '@/components/tenant/directory-role-assignments-panel') return { DirectoryRoleAssignmentsPanel: () => null }
    if (name === '@/components/tenant/pim-schedule-observations-panel') return { PimScheduleObservationsPanel: () => null }
    if (!name.startsWith('.') && !name.startsWith('@/')) return require(name)
    const target = name.startsWith('@/') ? resolve(base, name.slice(2)) : resolve(dirname(path), name.replace(/\.js$/, ''))
    const file = [target, target + '.tsx', target + '.ts'].find(p => existsSync(p))!
    return load(file)
  }, exports)
  return exports
}
const Tenant = load(resolve(base, 'app/(protected)/tenants/[id]/components/sections/signins-section.tsx')).default
const { SignInLogsPage } = load(resolve(base, 'app/(protected)/activity/components/signin-logs-page.tsx'))
const { normalizeSignInEvent } = load(resolve(base, 'app/(protected)/activity/data/normalize.ts'))
const { signInResult } = load(resolve(base, 'backend/src/tenants/sign-in-result.ts'))
const { signInResultColor, signInResultClass } = load(resolve(base, 'lib/tenants/sign-in-result.ts'))
const codes = ['0', '50126', null, 'null', '00', ' 0 ', '2147483647', '2147483648']
const rows = codes.map((code, index) => ({ id: `synthetic-${index}`, userId: `id-${index}`, userDisplayName: `Person ${index}`,
  userPrincipalName: `user${index}@example.test`, createdAt: new Date().toISOString(), result: signInResult(code),
  ipAddress: '192.0.2.1', appDisplayName: 'Synthetic app', clientAppUsed: 'Browser', country: 'Synthetic', latitude: 0, longitude: 0 }))
async function mounted(run: (h: any) => Promise<void>) {
  const dom = new JSDOM('<div id="root"></div>', {url:'https://synthetic.invalid'})
  const saved = new Map(['window','document','navigator','IS_REACT_ACT_ENVIRONMENT'].map(k => [k,Object.getOwnPropertyDescriptor(globalThis,k)]))
  for(const [k,v] of Object.entries({window:dom.window,document:dom.window.document,navigator:dom.window.navigator,IS_REACT_ACT_ENVIRONMENT:true})) Object.defineProperty(globalThis,k,{configurable:true,writable:true,value:v})
  const root=createRoot(dom.window.document.getElementById('root'))
  try { await run({document:dom.window.document, render: async (component: any, props: any) => React.act(async()=>root.render(React.createElement(component,props))),
    select: async(value:string)=>React.act(async()=>{const el=dom.window.document.querySelector('select');el.value=value;el.dispatchEvent(new dom.window.Event('change',{bubbles:true}))})}) }
  finally {await React.act(async()=>root.unmount());dom.window.close();for(const [k,v] of Array.from(saved)) if(v)Object.defineProperty(globalThis,k,v);else delete (globalThis as any)[k]}
}
test('tenant composed table keeps neutral outcomes visible, filterable and counted under Success filter', async()=>mounted(async(h:any)=>{
  await h.render(Tenant,{signIns:rows,signInView:'list',onSignInViewChange:()=>{}})
  assert.equal(h.document.querySelectorAll('tbody tr').length,8)
  const neutral=Array.from(h.document.querySelectorAll('tbody .text-slate-600')).filter((x:any)=>x.textContent==='Not reported') as any[]
  assert.equal(neutral.length,5);assert.ok(neutral.every(x=>x.className.includes('text-slate-600')))
  await h.select('Success');assert.equal(h.document.querySelectorAll('tbody tr').length,1)
  assert.match(h.document.body.textContent,/Not reported: 5 in this time\/search selection/)
  await h.select('Not reported');assert.equal(h.document.querySelectorAll('tbody tr').length,5)
  await h.select('all');assert.equal(h.document.querySelectorAll('tbody tr').length,8)
  // Changing the scoped input must not retain the previous tenant's neutral rows/count.
  await h.render(Tenant,{signIns:[{...rows[0],id:'other-tenant',userDisplayName:'Other tenant'}],signInView:'list',onSignInViewChange:()=>{}})
  assert.doesNotMatch(h.document.body.textContent,/Person 2/);assert.match(h.document.body.textContent,/Not reported: 0/)
}))
test('Activity composed normalizer/table renders neutral after upstream classification and preserves count when filtered',async()=>mounted(async(h:any)=>{
  const normalized=rows.map((row,index)=>normalizeSignInEvent(row,{tenantId:'tenant-a',index}))
  await h.render(SignInLogsPage,{rows:normalized,notReportedCount:5})
  const neutral=Array.from(h.document.querySelectorAll('tbody .text-slate-600')).filter((x:any)=>x.textContent==='Not reported') as any[]
  assert.ok(neutral.some(x=>x.className.includes('bg-slate-50')))
  assert.equal(normalized.filter((x:any)=>x.status==='Not reported').length,5)
  await h.render(SignInLogsPage,{rows:normalized.filter((x:any)=>x.status==='Success'),notReportedCount:5})
  assert.equal(h.document.querySelectorAll('tbody tr').length,1);assert.match(h.document.body.textContent,/Not reported: 5 in loaded tenant sign-ins/)
  const unknown=normalizeSignInEvent({...rows[0],result:'Unestablished'},{tenantId:'tenant-a',index:0})
  assert.equal(unknown.status,'Not reported')
  await h.render(SignInLogsPage,{rows:[unknown]});assert.ok(h.document.querySelector('tbody .bg-slate-50'))
}))
test('unknown transport values are neutral in tenant rendering and maps',async()=>mounted(async(h:any)=>{
  await h.render(Tenant,{signIns:[{...rows[0],result:'Unestablished'}],signInView:'list',onSignInViewChange:()=>{}})
  assert.match(h.document.querySelector('tbody').textContent,/Not reported/)
  assert.equal(signInResultColor('Not reported'),'#64748b');assert.match(signInResultClass('Not reported'),/slate/)
  assert.notEqual(signInResultColor('Failure'),signInResultColor('Success'))
}))

const Overview = load(resolve(base, 'app/(protected)/tenants/[id]/components/sections/entra-overview-section.tsx')).default
const SYNTHETIC_SUCCESS = '2026-10-14T00:00:00.000Z'
const syncEvidence = (kind: 'SUCCEEDED' | 'FAILED' = 'SUCCEEDED', lastSuccessfulAt: string | null = SYNTHETIC_SUCCESS) => ({
  lastSuccessfulAt,
  outcomeProjection: { recordedOutcome: { kind } },
})
test('composed overview cannot turn unreported outcomes or no data into healthy posture',async()=>mounted(async(h:any)=>{
  const user={id:'u',name:'Synthetic',email:'u@example.test',type:'Member',role:'User',status:'Enabled',mfa:'Enabled',mfaRegistration:'Registered',authMethods:['microsoftAuthenticatorPush']}
  const props={tenant:{},bundle:{users:[user],entra:{riskyUsers:[]},sync:{users:syncEvidence(),authMethodPolicies:syncEvidence(),authRegistrations:syncEvidence(),signIns:syncEvidence(),namedLocations:syncEvidence()}},users:[user],caPolicies:[{state:'ON'}],conditionalAccessEvidence:{availability:'READY',count:1},authMethods:[],namedLocations:[],onNavigateTab:()=>{}}
  for (const [outcomes, posture, icon] of [
    [['Not reported'],'Incomplete data','neutral'],
    [['Success','Not reported'],'Incomplete data','neutral'],
    [['Failure','Not reported'],'Needs attention','warning'],
    [['Failure'],'Needs attention','warning'],
    [['Success'],'Healthy','healthy'],
    [[],'Incomplete data','neutral'],
  ] as const) {
    await h.render(Overview,{...props,signIns:outcomes.map((result,index)=>({...rows[index],result}))})
    assert.match(h.document.body.textContent,new RegExp(posture))
    if(posture!=='Healthy') assert.doesNotMatch(h.document.body.textContent,/Healthy/)
    const label=Array.from(h.document.querySelectorAll('div')).find((e:any)=>e.textContent==='Failed sign-ins') as any
    const checklistRow=label.parentElement.parentElement.parentElement
    assert.equal(Boolean(checklistRow.querySelector('svg.text-emerald-500')),icon==='healthy')
    assert.equal(Boolean(checklistRow.querySelector('svg.text-amber-500')),icon==='warning')
    if(outcomes.includes('Not reported' as never)) assert.match(checklistRow.textContent,/results? not reported; evidence incomplete/)
    if(outcomes.length===0) {assert.match(checklistRow.textContent,/No sign-in data/);assert.doesNotMatch(checklistRow.textContent,/0 reported authentication failures/)}
    if(outcomes.includes('Failure' as never)) assert.match(checklistRow.textContent,/1 reported authentication failure/)
  }
  // Reported successes cannot override unavailable Conditional Access evidence.
  await h.render(Overview,{...props,signIns:[{...rows[0],result:'Success'}],caPolicies:[],conditionalAccessEvidence:{availability:'UNVERIFIED',count:null}})
  assert.match(h.document.body.textContent,/Incomplete data/)
  assert.doesNotMatch(h.document.body.textContent,/Healthy/)
  // An authoritative empty CA list is observed, neutral configuration evidence.
  await h.render(Overview,{...props,signIns:[{...rows[0],result:'Success'}],caPolicies:[],conditionalAccessEvidence:{availability:'READY',count:0}})
  assert.match(h.document.body.textContent,/Healthy/)
  // Unknown sign-ins must not suppress warnings from other security evidence.
  await h.render(Overview,{...props,signIns:[{...rows[0],result:'Not reported'}],bundle:{...props.bundle,entra:{riskyUsers:[{id:'synthetic-risk'}]}}})
  assert.match(h.document.body.textContent,/Needs attention/)
}))

test('Entra overview gates posture on its actual collection and per-user registration evidence', async () => mounted(async (h: any) => {
  const registered = { id: 'registered', name: 'Registered', email: 'registered@example.test', type: 'Member', role: 'User', status: 'Enabled', mfaRegistration: 'Registered' }
  const unreported = { ...registered, id: 'unreported', name: 'Unreported', mfaRegistration: 'Unknown' }
  const notRegistered = { ...registered, id: 'not-registered', name: 'Not registered', mfaRegistration: 'Not registered' }
  const baseSync = {
    users: syncEvidence(), authMethodPolicies: syncEvidence(), authRegistrations: syncEvidence(),
    namedLocations: syncEvidence(), signIns: syncEvidence(),
  }
  const render = async ({
    users = [registered], sync = {}, outcomes = ['Success'], authMethods = [{ method: 'Authenticator', enabled: true, users: 1 }],
    namedLocations = [{ id: 'location', name: 'Office', type: 'TRUSTED' }],
  }: any = {}) => h.render(Overview, {
    tenant: {}, users, bundle: { users, entra: { riskyUsers: [], authMethods, namedLocations }, sync: { ...baseSync, ...sync } },
    signIns: outcomes.map((result: string, index: number) => ({ ...rows[index], result })),
    caPolicies: [{ state: 'ON' }], conditionalAccessEvidence: { availability: 'READY', count: 1 },
    authMethods, namedLocations, onNavigateTab: () => {},
  })
  const row = (name: string) => {
    const label = Array.from(h.document.querySelectorAll('div')).find((element: any) => element.textContent === name) as any
    assert.ok(label, `${name} row exists`)
    return label.parentElement.parentElement.parentElement as HTMLElement
  }
  const evidence = () => h.document.querySelector('[aria-label="Entra evidence not fully reported"]')?.textContent ?? ''

  await render()
  assert.match(h.document.body.textContent, /Healthy/)
  assert.equal(evidence(), '', 'complete default evidence has no missing-input disclosure')

  await render({ users: [], sync: { users: syncEvidence('SUCCEEDED', null) } })
  assert.match(h.document.body.textContent, /Incomplete data/)
  assert.match(row('MFA registration coverage').textContent, /Awaiting collection/)
  assert.doesNotMatch(row('MFA registration coverage').textContent, /0%/)
  assert.match(evidence(), /Users collection: not reported/)

  await render({ sync: { authMethodPolicies: syncEvidence('SUCCEEDED', null) } })
  assert.match(h.document.body.textContent, /Incomplete data/)
  assert.match(evidence(), /Authentication-method policies: not reported/)
  assert.equal(Boolean(row('Authentication methods').querySelector('svg.text-emerald-500')), false)

  await render({ users: [unreported], sync: { authRegistrations: syncEvidence('SUCCEEDED', null) } })
  assert.match(h.document.body.textContent, /Incomplete data/)
  assert.match(row('MFA registration coverage').textContent, /Coverage not fully reported/)
  assert.doesNotMatch(row('MFA registration coverage').textContent, /0%/)
  assert.match(evidence(), /MFA registration: not reported/)

  await render({ users: [registered, unreported] })
  assert.match(h.document.body.textContent, /Incomplete data/)
  assert.match(row('MFA registration coverage').textContent, /1 registered of 2 enabled; 1 not reported/)
  assert.doesNotMatch(row('MFA registration coverage').textContent, /%/)
  assert.equal(Boolean(row('MFA registration coverage').querySelector('svg.text-emerald-500, svg.text-amber-500')), false)
  assert.match(evidence(), /MFA registration: 1 enabled user state not reported/)

  await render({ sync: { users: syncEvidence('FAILED') } })
  assert.match(h.document.body.textContent, /Incomplete data/)
  assert.match(evidence(), /Users collection: latest attempt failed/)
  assert.doesNotMatch(h.document.body.textContent, /Healthy/)

  await render({ sync: { signIns: syncEvidence('FAILED') } })
  assert.match(h.document.body.textContent, /Incomplete data/)
  assert.match(evidence(), /Sign-ins: latest attempt failed/)

  await render({ sync: { authMethodPolicies: syncEvidence('FAILED'), namedLocations: syncEvidence('FAILED') } })
  assert.match(h.document.body.textContent, /Incomplete data/)
  assert.match(evidence(), /Authentication-method policies: latest attempt failed/)
  assert.match(row('Authentication methods').textContent, /1 method last reported; latest collection failed/)
  assert.equal(Boolean(row('Authentication methods').querySelector('svg.text-emerald-500')), false)
  assert.match(row('Named locations').textContent, /1 location last reported; latest collection failed/)
  assert.equal(Boolean(row('Named locations').querySelector('svg.text-emerald-500')), false)

  await render({ users: [registered, notRegistered] })
  assert.match(h.document.body.textContent, /Needs attention/)
  assert.match(row('MFA registration coverage').textContent, /1 of 2 registered \(50%\)/)
  assert.ok(row('MFA registration coverage').querySelector('svg.text-amber-500'))

  await render({ outcomes: ['Failure'], sync: { authMethodPolicies: syncEvidence('SUCCEEDED', null) } })
  assert.match(h.document.body.textContent, /Needs attention/)
  assert.match(evidence(), /Authentication-method policies: not reported/)

  await render({ users: [], authMethods: [], namedLocations: [] })
  assert.match(row('MFA registration coverage').textContent, /No enabled users reported/)
  assert.equal(Boolean(row('MFA registration coverage').querySelector('svg.text-emerald-500, svg.text-amber-500')), false)
  assert.match(row('Authentication methods').textContent, /0 methods configured/)
  assert.equal(Boolean(row('Authentication methods').querySelector('svg.text-emerald-500')), false)
  assert.match(row('Named locations').textContent, /0 locations configured/)
  assert.equal(Boolean(row('Named locations').querySelector('svg.text-emerald-500')), false)

  await render({ sync: { namedLocations: syncEvidence('SUCCEEDED', null) } })
  assert.match(row('Named locations').textContent, /Awaiting collection/)
  assert.equal(Boolean(row('Named locations').querySelector('svg.text-emerald-500')), false)
}))

test('Entra overview reports stored group/device counts only with their own collection evidence and never asserts an admin total', async () => mounted(async (h: any) => {
  const user = {
    id: 'user-one', name: 'Synthetic', email: 'user@example.test', type: 'Member',
    role: 'Global Administrator', status: 'Enabled', mfaRegistration: 'Registered',
    groups: ['Operations'], devices: [{ name: 'Shared' }],
  }
  const groups = [
    { id: 'group-one', displayName: 'Operations' },
    { id: 'group-two', displayName: 'Operations' },
    { id: 'group-three', displayName: 'Security only' },
  ]
  const completeSync = {
    users: syncEvidence(), authMethodPolicies: syncEvidence(), authRegistrations: syncEvidence(),
    namedLocations: syncEvidence(), signIns: syncEvidence(), groups: syncEvidence(), devices: syncEvidence(),
  }
  const render = async ({ storedGroups = groups, deviceCount = 3, sync = {} }: any = {}) => h.render(Overview, {
    tenant: {}, users: [user], signIns: [{ ...rows[0], result: 'Success' }],
    bundle: {
      users: [user], exchange: { groups: [{ id: 'group-one', name: 'Operations', email: 'ops@example.test' }] },
      entra: { groups: storedGroups, deviceCount, riskyUsers: [] }, sync: { ...completeSync, ...sync },
    },
    caPolicies: [{ state: 'ON' }], conditionalAccessEvidence: { availability: 'READY', count: 1 },
    authMethods: [], namedLocations: [], onNavigateTab: () => {},
  })
  const metric = (name: string) => {
    const label = Array.from(h.document.querySelectorAll('div')).find((element: any) => element.textContent === name) as any
    assert.ok(label, `${name} metric exists`)
    return label.parentElement.textContent as string
  }

  await render()
  assert.match(metric('Stored groups'), /Stored groups\s*3/)
  assert.match(metric('Stored devices'), /Stored devices\s*3/)
  assert.match(metric('Admins'), /Admins\s*Not assessed by HawkView/)
  assert.doesNotMatch(metric('Admins'), /\b1\b/)

  await render({ storedGroups: [], deviceCount: 0 })
  assert.match(metric('Stored groups'), /Stored groups\s*0/)
  assert.match(metric('Stored devices'), /Stored devices\s*0/)

  await render({ sync: { groups: syncEvidence('SUCCEEDED', null), devices: syncEvidence('SUCCEEDED', null) } })
  assert.match(metric('Stored groups'), /Count not reported/)
  assert.match(metric('Stored devices'), /Count not reported/)
  assert.doesNotMatch(metric('Stored groups'), /\b3\b/)
  assert.doesNotMatch(metric('Stored devices'), /\b3\b/)

  await render({ sync: { groups: syncEvidence('FAILED'), devices: syncEvidence('FAILED') } })
  assert.match(metric('Stored groups'), /Stored groups\s*3\s*Latest refresh failed/)
  assert.match(metric('Stored devices'), /Stored devices\s*3\s*Latest refresh failed/)
  assert.match(metric('Admins'), /Not assessed by HawkView/)
}))
