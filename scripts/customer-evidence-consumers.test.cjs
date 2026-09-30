// Actual Dashboard regression adapted from Engineer 2's independent v1 reproduction.
const test=require('node:test')
const fs=require('fs'),path=require('path'),assert=require('node:assert/strict'),{createRequire}=require('module')
const root=path.resolve(__dirname,'..'),req=createRequire(root+'/package.json')
const React=req('react'),{createRoot}=req('react-dom/client'),{JSDOM}=req('jsdom'),ts=req('typescript'),h=React.createElement,cache=new Map()
const at='2026-09-29T12:00:00.000Z';Date.now=()=>Date.parse('2026-09-29T18:00:00.000Z')
let currentTenant, riskData
const query=()=>({data:{tenants:[currentTenant]},isLoading:false,isError:false,isFetching:false,isStale:false,dataUpdatedAt:Date.now(),refetch:async()=>{}})
function load(file){if(cache.has(file))return cache.get(file);const ex={};cache.set(file,ex);const js=ts.transpileModule(fs.readFileSync(file,'utf8'),{fileName:file,compilerOptions:{jsx:ts.JsxEmit.ReactJSX,module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText;new Function('require','exports',js)(name=>{
 if(name==='next/navigation')return {useRouter:()=>({push(){}}),usePathname:()=>'/dashboard',useSearchParams:()=>new URLSearchParams()}
 if(name==='next/link')return {__esModule:true,default:({children,...p})=>h('a',p,children)}
 if(name==='@/lib/api/hooks')return {useTenants:query}
 if(name==='@/lib/api/native-risk-summary-hooks')return {useNativeRiskSummary:()=>({isLoading:false,isError:false,isFetching:false,refetch:async()=>{}})}
 if(name==='@/lib/api/risky-users-hooks')return {useRiskyUsers:()=>riskData}
 if(name==='@/lib/api/client')return {apiClient:{get(){throw Error('Unexpected network')},post(){throw Error('Unexpected mutation')}}}
 if(!name.startsWith('.')&&!name.startsWith('@/'))return req(name)
 const p=name.startsWith('@/')?path.join(root,name.slice(2)):path.resolve(path.dirname(file),name);return load([p,p+'.tsx',p+'.ts'].find(fs.existsSync))},ex);return ex}
const prov=load(root+'/backend/src/tenants/attention-provenance.ts')
const {AffectedServices}=load(root+'/components/tenants/affected-services.tsx')
const {TenantRiskMatrixDrawer}=load(root+'/components/dashboard/tenant-risk-matrix-drawer.tsx')
const {TenantOverview}=load(root+'/app/(protected)/tenants/[id]/components/tenant-overview.tsx')
const {deriveTenantWorkspaceDisplay}=load(root+'/lib/tenant-workspace-state.ts')
const {tenantActionableHealthProjection}=load(root+'/lib/attention/computeTenantAttention.ts')
const {projectSyncOutcome}=load(root+'/backend/src/tenants/sync-outcome-projection.ts')
const row=(provenance)=>({key:'misleading-exchange-key',label:'Misleading SharePoint label',why:'Reported evidence',severity:'critical',provenance})
const tenant={id:'tenant-a',name:'Contoso',provider:'microsoft',domain:'contoso.example',connectionStatus:'revoked',data:{status:'COMPLETE'},attention:[]}
async function mount(name,element,check){
 const dom=new JSDOM('<div id="root"></div>',{url:'https://fixture.invalid'})
 const previous={}
 for(const [key,value]of Object.entries({window:dom.window,document:dom.window.document,navigator:dom.window.navigator,IS_REACT_ACT_ENVIRONMENT:true})){
  previous[key]=Object.getOwnPropertyDescriptor(globalThis,key);Object.defineProperty(globalThis,key,{configurable:true,value})
 }
 const rr=createRoot(document.getElementById('root'))
 try{
  await React.act(async()=>rr.render(element));check(document)
  if(process.env.HAW38_VISUAL_OUT)fs.writeFileSync(path.join(process.env.HAW38_VISUAL_OUT,name+'.html'),'<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="styles.css"><style>body{font-family:Arial,sans-serif}</style></head><body class="bg-slate-50 text-slate-900"><main class="p-4">'+document.getElementById('root').innerHTML+'</main></body></html>')
 }finally{
  await React.act(async()=>rr.unmount());dom.window.close()
  for(const [key,desc]of Object.entries(previous))if(desc)Object.defineProperty(globalThis,key,desc);else delete globalThis[key]
 }
}
const serviceCases=[
 ['missing',{id:'tenant-a'},null,'Unknown'],
 ['complete-empty',tenant,null,'Unknown'],
 ['access',{...tenant,attention:[row(prov.accessProvenance('AUTHORIZATION_REQUIRED',true))]},null,'Unknown',1],
 ['legacy-exchange',{...tenant,attention:[row(undefined)]},null,'Unknown',1],
 ['future',{...tenant,attention:[row({...prov.tenantFindingProvenance('MICROSOFT_ACTIVE_RISK'),version:2})]},null,'Unknown',1],
 ['generic-application',{...tenant,attention:[row(prov.tenantFindingProvenance('APPLICATION_ACCESS_CHANGE'))]},null,'Unknown',1],
 ['generic-role',{...tenant,attention:[row(prov.tenantFindingProvenance('ADMINISTRATIVE_ROLE_CHANGE'))]},null,'Unknown',1],
 ...['MICROSOFT_ACTIVE_RISK','MFA_REGISTRATION_COVERAGE','CONDITIONAL_ACCESS_CHANGE','AUTHENTICATION_CHANGE'].map(kind=>[kind,{...tenant,attention:[row(prov.tenantFindingProvenance(kind))]},'entra','Finding reported']),
 ...[['M365_AUDIT','o365'],['USERS','entra'],['EXCHANGE_MAILBOXES','exchange'],['SHAREPOINT_SITES','sharepoint']].map(([resource,service])=>[resource,{...tenant,attention:[row(prov.collectorAttentionProvenance(resource,'HAWKVIEW_INTERNAL_FAILURE'))]},service,'Evidence gap']),
 ['mixed',{...tenant,attention:[row(prov.tenantFindingProvenance('MFA_REGISTRATION_COVERAGE')),row(prov.collectorAttentionProvenance('USERS','HAWKVIEW_INTERNAL_FAILURE'))]},'entra','Finding · evidence gap'],
]
for(const compact of [true,false])for(const [name,value,affected,label,unattributed]of serviceCases)test(`mounted services ${compact?'compact':'full'} ${name}`,()=>mount('services-'+name+'-'+compact,h(AffectedServices,{tenant:value,compact}),doc=>{
 assert.equal(doc.querySelectorAll('[data-service]').length,4)
 for(const key of ['o365','entra','exchange','sharepoint']){
  const pill=doc.querySelector(`[data-service="${key}"]`)
  assert.ok(pill.textContent.endsWith(key===affected?label:'Unknown'),pill.textContent)
  assert.match(pill.getAttribute('aria-label'),new RegExp(key===affected?label:'Unknown'))
 }
 assert.doesNotMatch(doc.body.textContent+' '+[...doc.querySelectorAll('[title]')].map(e=>e.title).join(' '),/No issue|healthy|Needs attention|PRIVATE_DIAGNOSTIC/)
 if(unattributed)assert.match(doc.body.textContent,/Service not established for 1 reported item/)
}))
for(const [name,attention,expected]of [
 ['access',[row(prov.accessProvenance('AUTHORIZATION_REQUIRED',true))],/explicit customer access setup action/],
 ['operations',[row(prov.collectorAttentionProvenance('USERS','HAWKVIEW_INTERNAL_FAILURE'))],/Finding total unavailable/],
 ['unknown',[row(undefined)],/Finding total unavailable/],
 ['empty',[],/No tenant findings are reported in this summary/],
 ['finding',[row(prov.tenantFindingProvenance('MICROSOFT_ACTIVE_RISK'))],/Critical tenant findings are reported/],
])test('mounted matrix drawer '+name,()=>mount('drawer-'+name,h(TenantRiskMatrixDrawer,{tenant:{...tenant,attention},isOpen:true,onClose(){}}),doc=>{
 assert.match(doc.body.textContent,expected)
 assert.doesNotMatch(doc.body.textContent,/operating within healthy|environment is synchronized|Re-authentication is required|missing API permissions/)
}))
for(const name of ['success','future','mismatched','deferred','positive-deferred'])test('mounted complete overview '+name,async()=>{
 const deferred=name.includes('deferred'),resource=deferred?'M365_AUDIT':'USERS',status=deferred?'RUNNING':'SUCCEEDED'
 const entry={status:status.toLowerCase(),lastSuccessfulAt:at,lastError:null,outcomeProjection:projectSyncOutcome(resource,{status,lastSuccessfulAt:new Date(at),lastAttemptAt:new Date(at),lastErrorCode:deferred?'m365-audit-backlog':null},new Date(Date.now()))}
 if(name==='future')entry.outcomeProjection.version=2
 if(name==='mismatched')entry.outcomeProjection.resourceType='LICENSES'
 const attention=name==='positive-deferred'?[{...row(prov.tenantFindingProvenance('MICROSOFT_ACTIVE_RISK')),label:'Known positive finding'}]:[]
 const health=tenantActionableHealthProjection({...tenant,attention});assert.equal(health.customer.incomplete,false)
 const bundle={tenant,sync:{[deferred?'m365Audit':'users']:entry},licenses:{rows:[]}}
 const display=deriveTenantWorkspaceDisplay(bundle,false,null,health)
 assert.equal(display.customer.incomplete,name!=='success');assert.equal(display.attentionVerified,name==='success')
 await mount('overview-'+name,h(TenantOverview,{bundle,display,onOpenModule(){}}),doc=>{
  assert.equal(!!doc.querySelector('a[href="/tenants/tenant-a/settings?tab=collection"]'),false)
  if(name!=='success'){assert.doesNotMatch(doc.body.textContent,/Evidence incomplete/);assert.match(doc.body.textContent,attention.length?/1 reported finding/:/Finding total unavailable/)}
  if(attention.length)assert.match(doc.body.textContent,/Known positive finding/)
  assert.doesNotMatch(doc.body.textContent,/Deferred work recorded|m365-audit-backlog|Collection outcome not verified/)
 })
})
