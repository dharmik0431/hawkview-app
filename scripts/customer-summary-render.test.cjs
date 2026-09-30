// Actual customer-summary surfaces; real shared parser/projection, controlled query boundary.
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
 if(name==='@/components/providers/auth-provider')return {useAuth:()=>({session:null})}
 if(name==='@tanstack/react-query')return {useQueryClient:()=>({invalidateQueries(){}})}
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

const Directory=load(root+'/app/(protected)/tenants/page.tsx').default
const {TenantIssueDrawer}=load(root+'/components/tenants/tenant-issue-drawer.tsx')
const {TenantRiskMatrix}=load(root+'/components/dashboard/tenant-risk-matrix.tsx')
const helpers=load(root+'/components/dashboard/tenant-risk-matrix-helpers.ts')
const {getTenantDisplayStatus}=load(root+'/components/tenants/tenant-status-badge.tsx')
const {customerAttention}=load(root+'/lib/attention/customer-attention.ts')
const finding={key:'risk',label:'Reported identity risk',why:'Two identities have reported risk.',severity:'high',actionLabel:'Review finding',provenance:prov.tenantFindingProvenance('MICROSOFT_ACTIVE_RISK')}
const consent={key:'consent',label:'Microsoft consent required',why:'Grant the reported administrator consent.',severity:'high',actionLabel:'Review access setup',provenance:prov.accessProvenance('AUTHORIZATION_REQUIRED',true)}
const ops={key:'ops',label:'PRIVATE_COLLECTOR',why:'PRIVATE_DIAGNOSTIC',severity:'critical',provenance:prov.collectorAttentionProvenance('SHAREPOINT_SITES','HAWKVIEW_INTERNAL_FAILURE')}
const unknown={key:'legacy',label:'UNKNOWN_PROVENANCE',why:'Unsupported evidence',severity:'critical'}
const limited={...unknown,provenance:prov.limitedEvidenceProvenance()}
const baseline={...tenant,organization:{id:'synthetic-org'},name:'Synthetic customer',connectionStatus:'connected',status:'active',missingPermissions:[],mfaCoverage:50,lastSync:at}
const fixtures=[
 ['positive-failure',[finding,ops],true,'needs_attention','needs_attention'],
 ['consent-failure',[consent,ops],true,'pending_setup','pending_setup'],
 ['missing',undefined,true,'unverified','unknown'],
 ['malformed',{invalid:[]},true,'unverified','unknown'],
 ['complete-empty',[],false,'healthy','healthy'],
 ['unknown',[unknown],true,'unverified','unknown'],
 ['limited-signins',[limited],true,'unverified','unknown'],
 ['positive-consent-failure',[finding,consent,ops],true,'needs_attention','needs_attention'],
]
async function mounted(run){
 const dom=new JSDOM('<div id="root"></div>',{url:'https://fixture.invalid'}),saved={}
 for(const [key,value]of Object.entries({window:dom.window,document:dom.window.document,navigator:dom.window.navigator,HTMLElement:dom.window.HTMLElement,localStorage:dom.window.localStorage,IS_REACT_ACT_ENVIRONMENT:true})){
  saved[key]=Object.getOwnPropertyDescriptor(globalThis,key);Object.defineProperty(globalThis,key,{configurable:true,value})
 }
 const rr=createRoot(document.getElementById('root')),opened=[]
 const render=async(surface,value,evidence=null,sync={})=>{
  currentTenant=value
  const bundle={tenant:value,sync,licenses:{rows:[]}}
  const display=deriveTenantWorkspaceDisplay(bundle,false,evidence,tenantActionableHealthProjection(value))
  const el=surface==='list'||surface==='tile'?h(Directory):surface==='matrix'?h(TenantRiskMatrix,{tenants:[value]}):surface==='matrix-drawer'?h(TenantRiskMatrixDrawer,{tenant:value,isOpen:true,onClose(){}}):surface==='tenant-drawer'?h(TenantIssueDrawer,{tenant:value,isOpen:true,onClose(){}}):h(TenantOverview,{bundle,display,onOpenModule:m=>opened.push(m),onOpenIssue:i=>opened.push(i.targetModule)})
  await React.act(async()=>rr.render(el))
  if(surface==='tile'){await React.act(async()=>document.querySelector('button[aria-label="Card view"]').click())}
  return display
 }
 const click=async(label)=>{const b=[...document.querySelectorAll('button')].find(e=>e.textContent.trim()===label);assert.ok(b,label);await React.act(async()=>b.click())}
 try{await run({render,click,opened,doc:document,text:()=>document.body.textContent})}
 finally{await React.act(async()=>rr.unmount());dom.window.close();for(const [key,d]of Object.entries(saved))d?Object.defineProperty(globalThis,key,d):delete globalThis[key]}
}
for(const surface of ['list','tile','matrix','matrix-drawer','tenant-drawer','overview'])for(const [name,attention,incomplete,directoryKey,matrixKey]of fixtures)test(`customer summary ${surface}: ${name}`,async()=>mounted(async h=>{
 const value={...baseline,attention};const view=customerAttention(value)
 assert.equal(view.incomplete,incomplete)
 if(incomplete&&!view.findings.length&&!view.accessActions.length)assert.equal(getTenantDisplayStatus(value).label,'Finding total unavailable')
 assert.equal(getTenantDisplayStatus(value).key,directoryKey);assert.equal(helpers.getTenantMatrixOverallState(value).key,matrixKey)
 assert.equal(helpers.getTenantConnectionDataInfo(value).dataStatus,incomplete?'partial':'current')
 if(view.accessActions.length&&!view.findings.length)assert.equal(helpers.getTenantRecommendedAction(value).destinationUrl,'/tenants/tenant-a/settings')
 const display=await h.render(surface,value)
 assert.equal(display.customer.incomplete,incomplete)
 if(surface==='matrix-drawer'){assert.match(h.text(),/Finding summary/);assert.doesNotMatch(h.text(),/Data Freshness/)}
 const text=h.text(), actions=view.findings.length+view.accessActions.length
 assert.doesNotMatch(text,/Evidence incomplete|Evidence is incomplete|Evidence: Incomplete|PRIVATE_COLLECTOR|PRIVATE_DIAGNOSTIC|UNKNOWN_PROVENANCE|exhaustive security assessment or confirmation/)
 if(actions){
  if(['list','tile'].includes(surface))assert.ok(text.includes(`${actions} reported action${actions===1?'':'s'}`),text)
  assert.match(text,/reported (?:finding|access action|action)|[12] reported/)
  if(['overview','matrix-drawer','tenant-drawer'].includes(surface)){
   for(const item of [...view.findings,...view.accessActions]){assert.ok(text.includes(item.label));assert.ok(text.includes(item.why))}
  }
 }else if(incomplete){
  assert.match(text,/Finding total unavailable|Customer action total unavailable/)
  assert.doesNotMatch(text,/0 reported|No actions reported|No customer actions reported/)
  if(surface==='tenant-drawer')assert.equal(h.doc.querySelector('.lucide-circle-check-2'),null)
 }else assert.match(text,/No (?:findings|actions|customer actions|tenant findings).*reported|0 reported/)
 if(surface==='overview'&&name==='consent-failure'){await h.click('Review access setup');assert.deepEqual(h.opened,['settings'])}
 if(surface==='overview')assert.equal(h.doc.querySelectorAll('[aria-label="Dataset update times"]').length,0)
 if(process.env.HAW38_VISUAL_OUT && ['list-positive-consent-failure','tile-missing','matrix-drawer-positive-consent-failure','tenant-drawer-missing','overview-positive-consent-failure'].includes(surface+'-'+name)) fs.writeFileSync(path.join(process.env.HAW38_VISUAL_OUT,surface+'-'+name+'.html'),'<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="styles.css"></head><body class="bg-slate-50 text-slate-900 dark:bg-slate-950 dark:text-slate-100"><main class="mx-auto max-w-7xl p-4">'+h.doc.getElementById('root').innerHTML+'</main></body></html>')
}))
for(const surface of ['list','tile','matrix','matrix-drawer','tenant-drawer','overview'])test(`customer summary ${surface}: validated inputs clear unavailable and access states`,async()=>mounted(async h=>{
 await h.render(surface,{...baseline,attention:undefined});assert.match(h.text(),/total unavailable/)
 await h.render(surface,{...baseline,attention:[]});assert.doesNotMatch(h.text(),/total unavailable|Evidence incomplete/)
 await h.render(surface,{...baseline,attention:[consent]});assert.match(h.text(),/reported access action|1 reported/)
 await h.render(surface,{...baseline,attention:[]});assert.doesNotMatch(h.text(),/Microsoft consent required|reported access action/)
}))
test('limited selected sign-in source keeps overview unknown despite complete attention',async()=>mounted(async h=>{
 const display=await h.render('overview',baseline,{availability:'LIMITED',selectedSource:'M365_AUDIT'})
 assert.equal(display.customer.incomplete,true);assert.equal(display.state,'unverified');assert.match(h.text(),/Finding total unavailable/)
 const next=await h.render('overview',baseline,{availability:'READY',selectedSource:'M365_AUDIT'})
 assert.equal(next.customer.incomplete,false);assert.match(h.text(),/No findings reported/)
}))

for(const surface of ['list','tile'])test(`directory ${surface} filters retain complete/incomplete membership`,async()=>mounted(async h=>{
 for(const [attention,filter]of [[[], 'No findings reported'],[[finding,ops],'Attention'],[undefined,'Setup / Incomplete']]){
  await h.render(surface,{...baseline,attention});await h.click('All')
  assert.match(h.text(),/Synthetic customer/)
  for(const selected of ['No findings reported','Attention','Setup / Incomplete']){
   await h.click(selected);assert.equal(h.text().includes('Synthetic customer'),selected===filter,selected)
  }
 }
}))
test('named overview dates remain independent of unrelated collection failure',async()=>mounted(async h=>{
 const sync={sharepoint:{status:'failed',lastError:'PRIVATE_DIAGNOSTIC',lastSuccessfulAt:'2026-09-29T17:59:00.000Z'}}
 for(const [key,resource,hour]of [['applications','APPLICATIONS',12],['groups','GROUPS',14],['licenses','LICENSES',16]]){
  const stamp=`2026-09-29T${hour}:00:00.000Z`
  sync[key]={status:'succeeded',lastError:null,lastSuccessfulAt:stamp,outcomeProjection:projectSyncOutcome(resource,{status:'SUCCEEDED',lastSuccessfulAt:new Date(stamp),lastAttemptAt:new Date(stamp)},new Date(Date.now()))}
 }
 const display=await h.render('overview',{...baseline,attention:[finding]},null,sync)
 assert.equal(display.customer.incomplete,true);assert.match(h.text(),/1 reported finding/)
 assert.deepEqual([...h.doc.querySelectorAll('[aria-label="Dataset update times"] time')].map(e=>e.dateTime),[])
 assert.doesNotMatch(h.text(),/PRIVATE_DIAGNOSTIC|Evidence incomplete/)
}))
