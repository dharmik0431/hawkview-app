import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve, dirname } from 'node:path'
import test from 'node:test'
const require = createRequire(import.meta.url)
const React = require('react')
const { createRoot } = require('react-dom/client')
const { JSDOM } = require('jsdom')
const ts = require('typescript')
const base = resolve(dirname(new URL(import.meta.url).pathname), '../..')
const h = React.createElement
const pending: { path: string; signal: AbortSignal | undefined; resolve: (data: unknown) => void; reject: (error: Error) => void }[] = []
const mocks: Record<string, any> = {
  'next/link': { __esModule: true, default: ({children, ...props}: any) => h('a', props, children) },
  '@/lib/api/client': { apiClient: { post: () => { throw Error('Unexpected write') }, patch: () => { throw Error('Unexpected write') }, get: (path: string, options?: { signal: AbortSignal }) => new Promise((resolve, reject) => pending.push({ path, signal: options?.signal, resolve, reject })) } },
  '@/components/providers/notification-provider': { triggerNotification() { throw Error('Unexpected notification') } },
  './components/signin-logs-page': { SignInLogsPage: () => h('div', null, 'Sign-in table') },
  './components/audit-logs-page': { AuditLogsPage: () => h('div', null, 'Audit table') },
}
const cache = new Map<string, any>()
function load(path: string): any {
  if (cache.has(path)) return cache.get(path)
  const exports: any = {}; cache.set(path, exports)
  const js = ts.transpileModule(readFileSync(path, 'utf8'), { compilerOptions: {
    jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true,
  } }).outputText
  new Function('require', 'exports', js)((name: string) => {
    if (mocks[name]) return mocks[name]
    if (!name.startsWith('.') && !name.startsWith('@/')) return require(name)
    const target = name.startsWith('@/') ? resolve(base, name.slice(2)) : resolve(dirname(path), name)
    return load([target, target + '.tsx', target + '.ts'].find(p => existsSync(p))!)
  }, exports)
  return exports
}
const Page = load(resolve(base, 'app/(protected)/activity/page.tsx')).default

const Dialog = load(resolve(base, 'components/tenants/tenant-onboarding-dialog.tsx')).TenantOnboardingDialog
const tenantId = '11111111-1111-4111-8111-111111111111'
const setup = (status = 'VERIFIED') => ({version:1,tenant:{id:tenantId,name:'Synthetic tenant',primaryDomain:'example.invalid',microsoftTenantId:'22222222-2222-4222-8222-222222222222'},completedAt:null,canFinish:true,steps:{
 microsoftAccess:{required:true,status,errorCode:null,errorMessage:null},
 exchangeReadOnly:{required:false,status:'DEFERRED',enabledAt:null,deferredAt:'2026-09-29T00:00:00.000Z',permission:'Exchange.ManageAsAppV2',capability:'Get-Mailbox only',disclaimer:'Optional and read-only.'},
 reportVisibility:{required:false,status:'VERIFIED',identifiersVisible:true,lastCheckedAt:null,deferredAt:null,permission:'ReportSettings.Read.All',adminCenterUrl:'https://admin.microsoft.com/#/Settings/Services',settingPath:['Settings','Org settings','Services','Reports'],settingLabel:'Conceal user, group, and site names in all reports',disclaimer:'Read-only verification.'}
}})
async function harness(component: any, props: any, run: (ctx: any) => Promise<void>) {
 pending.length=0
 const dom=new JSDOM('<div id="root"></div>',{url:'https://synthetic.invalid'})
 const saved=new Map<string,PropertyDescriptor|undefined>()
 for(const [key,value] of Object.entries({window:dom.window,document:dom.window.document,HTMLElement:dom.window.HTMLElement,IS_REACT_ACT_ENVIRONMENT:true})) {
  saved.set(key,Object.getOwnPropertyDescriptor(globalThis,key));Object.defineProperty(globalThis,key,{configurable:true,writable:true,value})
 }
 const root=createRoot(dom.window.document.getElementById('root'))
 const request=(path:string)=>{const req=pending.shift();assert.equal(req?.path,path);return req!}
 const reply=async(req:typeof pending[number],data:unknown)=>React.act(async()=>req.resolve(data))
 const fail=async(req:typeof pending[number])=>React.act(async()=>req.reject(new Error('SYNTHETIC_PRIVATE_DETAIL')))
 const click=async(text:RegExp)=>React.act(async()=>{const el=Array.from(dom.window.document.querySelectorAll('button')).find((e:any)=>text.test(e.textContent)) as HTMLButtonElement;assert.ok(el);el.click()})
 const select=async()=>React.act(async()=>{const el=dom.window.document.querySelector('select');el.value=tenantId;el.dispatchEvent(new dom.window.Event('change',{bubbles:true}))})
 const body=()=>dom.window.document.body.textContent
 const alert=()=>dom.window.document.querySelector('[role="alert"]')?.textContent
 try{await React.act(async()=>root.render(h(component,props)));await run({request,reply,fail,click,select,body,alert});assert.equal(pending.length,0)}
 finally{await React.act(async()=>root.unmount());for(const [key,d]of Array.from(saved)) d?Object.defineProperty(globalThis,key,d):Reflect.deleteProperty(globalThis,key);dom.window.close()}
}
test('actual Activity directory failure names read operation and existing retry clears it',async()=>{
 await harness(Page,{},async({request,reply,fail,click,body,alert})=>{
  await fail(request('/api/tenants'));assert.match(alert(),/Tenant directory could not be loaded. Try again./)
  assert.doesNotMatch(body(),/No activity status is being inferred|SYNTHETIC_PRIVATE_DETAIL|permission denied/i)
  await click(/^Try again$/);await reply(request('/api/tenants'),{tenants:[{id:tenantId,name:'Synthetic tenant'}]})
  assert.equal(alert(),undefined);assert.match(body(),/Select a Tenant/)
 })
})
for(const tab of ['Sign-in logs','Audit logs']) test(`actual Activity ${tab} failure and retry preserve tab and empty result`,async()=>{
 await harness(Page,{},async({request,reply,fail,click,select,body,alert})=>{
  await reply(request('/api/tenants'),{tenants:[{id:tenantId,name:'Synthetic tenant'}]});await select()
  if(tab==='Audit logs') await click(/^Audit logs/)
  await fail(request('/api/tenants/'+tenantId));assert.ok(alert().includes(tab+' could not be loaded for this tenant. Try again.'))
  assert.doesNotMatch(body(),/No success state is being shown|SYNTHETIC_PRIVATE_DETAIL|Sign-in table|Audit table/)
  await click(/^Try again$/);await reply(request('/api/tenants/'+tenantId),{bundle:{tenant:{id:tenantId},signIns:[],auditLogs:[]}})
  assert.equal(alert(),undefined);assert.match(body(),tab==='Audit logs'?/Audit table/:/Sign-in table/)
 })
})
for(const kind of ['request','malformed']) test(`actual setup ${kind} failure and retry clear read error`,async()=>{
 await harness(Dialog,{open:true,tenantId,onClose(){},onCompleted(){throw Error('Unexpected completion')}},async({request,reply,fail,click,body,alert})=>{
  const req=request('/api/tenants/'+tenantId+'/onboarding')
  if(kind==='request')await fail(req);else await reply(req,{version:999})
  assert.match(alert(),/Tenant setup status could not be loaded. Retry confirmation./)
  assert.doesNotMatch(alert(),/authoritative|Check your connection|SYNTHETIC_PRIVATE_DETAIL/)
  await click(/^Retry confirmation$/);await reply(request('/api/tenants/'+tenantId+'/onboarding'),setup())
  assert.equal(alert(),undefined);assert.match(body(),/Synthetic tenant/)
 })
})
test('explicit Microsoft consent state retains its separate recovery message',async()=>{
 await harness(Dialog,{open:true,tenantId,onClose(){},onCompleted(){}},async({request,reply,body,alert})=>{
  await reply(request('/api/tenants/'+tenantId+'/onboarding'),setup('CONSENT_REQUIRED'))
  assert.match(body(),/Administrator consent required/);assert.match(alert(),/Microsoft app installation is complete/)
  assert.doesNotMatch(alert(),/setup status could not be loaded/)
 })
})
