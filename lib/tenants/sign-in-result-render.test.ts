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
test('composed overview cannot turn unreported outcomes or no data into healthy posture',async()=>mounted(async(h:any)=>{
  const user={id:'u',name:'Synthetic',email:'u@example.test',type:'Member',role:'User',status:'Enabled',mfa:'Enabled',mfaRegistration:'Registered',authMethods:['microsoftAuthenticatorPush']}
  const props={tenant:{},bundle:{users:[user],entra:{riskyUsers:[]}},users:[user],caPolicies:[{state:'ON'}],conditionalAccessEvidence:{availability:'READY',count:1},authMethods:[],namedLocations:[],onNavigateTab:()=>{}}
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
  // Unknown sign-ins must not suppress warnings from other security evidence.
  await h.render(Overview,{...props,signIns:[{...rows[0],result:'Not reported'}],bundle:{...props.bundle,entra:{riskyUsers:[{id:'synthetic-risk'}]}}})
  assert.match(h.document.body.textContent,/Needs attention/)
}))
