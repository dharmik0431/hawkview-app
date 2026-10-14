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
const {TenantServiceCollection}=load(root+'/components/tenants/tenant-service-collection.tsx')
const {TenantPermissionSummary}=load(root+'/components/tenants/tenant-permission-summary.tsx')
const {tenantConnectionBadge}=load(root+'/lib/tenants/service-collection-status.ts')
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
const snapshot=(key,status,freshness='CURRENT',last=at)=>({services:{[key]:{
 status,freshnessStatus:freshness,lastSuccessfulCollectionAt:last,successfulCollectors:status==='SUCCESS'?2:1,expectedCollectors:2,
}}})
const serviceCases=[
 ['missing',tenant,null,'Status unavailable'],
 ['finding-does-not-establish-collection',{...tenant,attention:[row(prov.tenantFindingProvenance('MICROSOFT_ACTIVE_RISK'))]},null,'Status unavailable'],
 ['collection-operation-does-not-establish-service-result',{...tenant,attention:[row(prov.collectorAttentionProvenance('USERS','HAWKVIEW_INTERNAL_FAILURE'))]},null,'Status unavailable'],
 ['success',{...tenant,status:'active',connectionStatus:'connected',syncFreshness:snapshot('entraId','SUCCESS')},'entraId','Collected'],
 ['partial',{...tenant,syncFreshness:snapshot('exchange','PARTIAL')},'exchange','Partial'],
 ['failed',{...tenant,syncFreshness:snapshot('sharePointOneDrive','FAILED')},'sharePointOneDrive','Collection failed'],
 ['permission',{...tenant,syncFreshness:{services:{exchange:{...snapshot('exchange','FAILED').services.exchange,permissionRequiredCollectors:1,failedCollectors:0}}}},'exchange','Access needed'],
 ['partial-permission',{...tenant,syncFreshness:{services:{exchange:{...snapshot('exchange','PARTIAL').services.exchange,permissionRequiredCollectors:1,failedCollectors:0}}}},'exchange','Partial · access needed'],
 ['partial-permission-stale',{...tenant,syncFreshness:{services:{exchange:{...snapshot('exchange','PARTIAL','STALE').services.exchange,permissionRequiredCollectors:1,pendingCollectors:1}}}},'exchange','Partial · access needed'],
 ['partial-pending-stale',{...tenant,syncFreshness:{services:{exchange:{...snapshot('exchange','PARTIAL','STALE').services.exchange,pendingCollectors:1}}}},'exchange','Partial'],
 ['not-licensed',{...tenant,syncFreshness:{services:{sharePointOneDrive:{status:'UNKNOWN',expectedCollectors:0,notLicensedCollectors:3,unsupportedCollectors:0}}}},'sharePointOneDrive','Not licensed'],
 ['unsupported',{...tenant,syncFreshness:{services:{auditLogs:{status:'UNKNOWN',expectedCollectors:0,notLicensedCollectors:0,unsupportedCollectors:2}}}},'auditLogs','Unsupported'],
 ['mixed-eligibility',{...tenant,syncFreshness:{services:{auditLogs:{status:'UNKNOWN',expectedCollectors:0,notLicensedCollectors:1,unsupportedCollectors:1}}}},'auditLogs','Not eligible'],
 ['excluded-reason-missing',{...tenant,syncFreshness:{services:{auditLogs:{status:'UNKNOWN',expectedCollectors:0,notLicensedCollectors:0,unsupportedCollectors:0}}}},'auditLogs','Status unavailable'],
 ['stale',{...tenant,syncFreshness:snapshot('office365','STALE','STALE')},'office365','Stale'],
 ['not-collected',{...tenant,syncFreshness:snapshot('signInLogs','NOT_COLLECTED','NEVER_SYNCED',null)},'signInLogs','Not collected'],
 ['pending',{...tenant,syncFreshness:snapshot('auditLogs','PENDING','NEVER_SYNCED',null)},'auditLogs','Pending'],
 ['malformed',{...tenant,syncFreshness:{services:{entraId:{status:'SUCCESS',freshnessStatus:'CURRENT',lastSuccessfulCollectionAt:'bad-date'}}}},'entraId','Status unavailable'],
]
for(const compact of [true,false])for(const [name,value,selected,label]of serviceCases)test(`mounted collection ${compact?'compact':'full'} ${name}`,()=>mount('services-'+name+'-'+compact,h(TenantServiceCollection,{tenant:value,compact}),doc=>{
 assert.equal(doc.querySelectorAll('[data-service]').length,6)
 for(const key of ['office365','entraId','exchange','sharePointOneDrive','signInLogs','auditLogs']){
  const pill=doc.querySelector(`[data-service="${key}"]`)
  assert.ok(pill.textContent.endsWith(key===selected?label:'Status unavailable'),pill.textContent)
  assert.match(pill.getAttribute('aria-label'),new RegExp(key===selected?label:'Status unavailable'))
 }
 assert.match(doc.body.textContent,/Connection: (Disconnected|Connected)/)
 assert.doesNotMatch(doc.body.textContent+' '+[...doc.querySelectorAll('[title]')].map(e=>e.title).join(' '),/No issue|\bis healthy\b|\bhealthy tenant\b|all clear|PRIVATE_DIAGNOSTIC/)
}))
for(const [name,value,expected]of [
 ['connected',{status:'active',connectionStatus:'connected'},'Connected'],
 ['revoked',{status:'active',connectionStatus:'revoked'},'Disconnected'],
 ['error',{status:'active',connectionStatus:'error'},'Needs attention'],
 ['pending',{status:'pending',connectionStatus:'pending-consent'},'Setup pending'],
 ['suspended',{status:'suspended',connectionStatus:'connected'},'Suspended'],
 ['suspended-pending',{status:'suspended',connectionStatus:'pending-consent'},'Suspended'],
 ['suspended-error',{status:'suspended',connectionStatus:'error'},'Suspended'],
 ['unknown',{status:'active',connectionStatus:null},'Not verified'],
])test('tenant connection '+name,()=>assert.equal(tenantConnectionBadge(value).label,expected))
test('tenant directory permission badge names a verified missing grant and opens permission details',()=>mount('tenant-permissions',h(TenantPermissionSummary,{tenant:{...tenant,status:'active',connectionStatus:'connected',missingRequiredPermissions:['User.Read.All'],collectionReadiness:{accessContractVersion:1,permissionVerifiedAt:at,workloads:[{key:'directory',workload:'Directory',state:'BLOCKED_PERMISSION',configuredCapability:'NOT_CONFIGURED',permissionStatus:'MISSING',requiredPermissions:['User.Read.All'],freshness:'CURRENT',remediation:'Review access.',datasets:[{key:'users',label:'Users',tier:'CORE',state:'BLOCKED_PERMISSION',permissionStatus:'MISSING',permissions:[{resource:'MICROSOFT_GRAPH',name:'User.Read.All',type:'APPLICATION',consentMode:'DEFAULT',grantStatus:'MISSING'}],permissionMatch:'ALL',evidenceMode:'RESOURCE_STATE',licensePrerequisite:{kind:'NONE',state:'NOT_REQUIRED'},fallbackDatasetKey:null,failureScope:'DATASET_ONLY',resourceTypes:['USERS'],endpointPatterns:['/users'],documentationUrl:'https://learn.microsoft.com/graph/',freshness:'CURRENT',remediation:'Review access.'}]}]}}}),doc=>{
 const link=doc.querySelector('a[href="/tenants/tenant-a/settings?tab=permissions"]')
 assert.ok(link)
 assert.match(link.textContent,/1 required permission missing/)
 assert.match(link.textContent,/User\.Read\.All/)
 assert.doesNotMatch(link.textContent,/Collection|Stale|Not licensed/)
}))
test('tenant directory does not advertise an intentionally ungranted optional Exchange capability',()=>{
 const dataset=(key,tier,state,grantStatus,permissionName,resource,consentMode,licenseKind)=>({
  key,label:key,tier,state,permissionStatus:grantStatus,
  permissions:[{resource,name:permissionName,type:'APPLICATION',consentMode,grantStatus}],
  permissionMatch:'ALL',evidenceMode:'RESOURCE_STATE',licensePrerequisite:{kind:licenseKind,state:'SATISFIED'},
  fallbackDatasetKey:null,failureScope:'DATASET_ONLY',resourceTypes:[key],endpointPatterns:['/fixture'],
  documentationUrl:'https://learn.microsoft.com/graph/',freshness:'CURRENT',remediation:'Review access.'
 })
 const datasets=[
  dataset('Users','CORE','READY','CONFIRMED','User.Read.All','MICROSOFT_GRAPH','DEFAULT','NONE'),
  dataset('Exchange Admin','CAPABILITY_OPTIONAL','BLOCKED_PERMISSION','MISSING','Exchange.ManageAsAppV2','EXCHANGE_ONLINE','SEPARATE_OPT_IN','EXCHANGE_SERVICE_PLAN'),
 ]
 const value={...tenant,status:'active',connectionStatus:'connected',missingRequiredPermissions:[],collectionReadiness:{
  accessContractVersion:1,permissionVerifiedAt:at,workloads:[{key:'directory',workload:'Directory',state:'READY',
   configuredCapability:'CONFIGURED',permissionStatus:'CONFIRMED',requiredPermissions:[],freshness:'CURRENT',
   remediation:'Review access.',datasets}],
 }}
 return mount('optional-permission-hidden',h(TenantPermissionSummary,{tenant:value}),doc=>{
  const link=doc.querySelector('a[href="/tenants/tenant-a/settings?tab=permissions"]')
  assert.ok(link)
  assert.match(link.textContent,/No required permission gap/)
  assert.doesNotMatch(link.outerHTML,/Exchange\.ManageAsAppV2|optional permission not granted/)
 })
})
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
