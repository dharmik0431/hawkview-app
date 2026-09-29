// Actual Dashboard regression adapted from Engineer 2's independent v1 reproduction.
const test=require('node:test')
const fs=require('fs'),path=require('path'),assert=require('node:assert/strict'),{createRequire}=require('module')
const root=path.resolve(__dirname,'..'),req=createRequire(root+'/package.json')
const React=req('react'),{createRoot}=req('react-dom/client'),{JSDOM}=req('jsdom'),ts=req('typescript'),h=React.createElement,cache=new Map()
const at='2026-09-29T12:00:00.000Z';Date.now=()=>Date.parse('2026-09-29T18:00:00.000Z')
let currentTenants, riskData, nativeData, queryState={}
const query=()=>({data:{tenants:currentTenants},isLoading:false,isError:false,isFetching:false,isStale:false,dataUpdatedAt:Date.now(),refetch:async()=>{},...queryState})
function load(file){if(cache.has(file))return cache.get(file);const ex={};cache.set(file,ex);const js=ts.transpileModule(fs.readFileSync(file,'utf8'),{fileName:file,compilerOptions:{jsx:ts.JsxEmit.ReactJSX,module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText;new Function('require','exports',js)(name=>{
 if(name==='next/navigation')return {useRouter:()=>({push(){}}),usePathname:()=>'/dashboard',useSearchParams:()=>new URLSearchParams()}
 if(name==='next/link')return {__esModule:true,default:({children,...p})=>h('a',p,children)}
 if(name==='@/lib/api/hooks')return {useTenants:query}
 if(name==='@/lib/api/native-risk-summary-hooks')return {useNativeRiskSummary:()=>({data:nativeData,isLoading:false,isError:false,isFetching:false,refetch:async()=>{}})}
 if(name==='@/lib/api/risky-users-hooks')return {useRiskyUsers:()=>riskData}
 if(name==='@/lib/api/client')return {apiClient:{get(){throw Error('Unexpected network')},post(){throw Error('Unexpected mutation')}}}
 if(!name.startsWith('.')&&!name.startsWith('@/'))return req(name)
 const p=name.startsWith('@/')?path.join(root,name.slice(2)):path.resolve(path.dirname(file),name);return load([p,p+'.tsx',p+'.ts'].find(fs.existsSync))},ex);return ex}
const prov=load(root+'/backend/src/tenants/attention-provenance.ts')
const {customerAttention}=load(root+'/lib/attention/customer-attention.ts')
const microsoft=load(root+'/lib/identity-risk/microsoft-risk-summary.ts')
const Dashboard=load(root+'/app/(protected)/dashboard/page.tsx').default
const row=(key,severity,provenance)=>({key,label:key,why:'Synthetic retained evidence',severity,provenance})
const critical=row('Critical identity finding','critical',prov.tenantFindingProvenance('MICROSOFT_ACTIVE_RISK'))
const high=row('Registration gap','high',prov.tenantFindingProvenance('MFA_REGISTRATION_COVERAGE'))
const ops=row('Unrelated SharePoint collection gap','critical',prov.collectorAttentionProvenance('SHAREPOINT_SITES','HAWKVIEW_INTERNAL_FAILURE'))
const microsoftSummary={source:'MICROSOFT_IDENTITY_PROTECTION',availability:'AVAILABLE',completeness:'COMPLETE',rawRecordCount:0,observedActiveDistinctUserCount:0,activeDistinctUserCount:0,snapshotObservedAt:new Date(Date.now()).toISOString(),collectionSucceededAt:new Date(Date.now()).toISOString(),reasonCode:null}
const base={microsoftRiskSummary:microsoftSummary,id:'tenant-a',name:'Synthetic tenant',provider:'microsoft',domain:'example.invalid',connectionStatus:'connected',status:'active',data:{status:'COMPLETE'},attention:[],healthScore:93,secureScore:null,mfaCoverage:5,lastSync:at,missingPermissions:[]}
const results=[]
const summaryMissing={...base,attention:undefined,data:undefined}
const cases=[
 ['critical-with-collection-gap',[{...base,attention:[critical,ops]}],'1 reported',true],
 ['no-observed-critical-with-gap',[{...base,attention:[high,ops]}],'0 reported',true],
 ['complete-empty',[base],'0 reported',false],
 ['missing-attention',[summaryMissing],'Unavailable',true],
 ['supplied-backend-score',[{...base,healthScore:87}],'0 reported',false],
 ['critical-plus-unread-tenant',[{...base,attention:[critical]},{...summaryMissing,id:'tenant-b'}],'1 reported',true],
 ['unclassified-critical-with-gap',[{...base,attention:[row('Unclassified critical','critical',undefined),ops]}],'0 reported',true],
 ['five-mfa-gaps-no-critical',Array.from({length:5},(_,i)=>({...base,id:'tenant-'+i,attention:[high,ops]})),'0 reported',true],
 ['duplicate-positive-id',[{...base,attention:[critical,critical]},{...base,attention:[critical]}],'1 reported',false],
 ['duplicate-unread-id',[{...base,attention:[critical]},summaryMissing],'1 reported',true],
 ['two-positive-ids',[{...base,attention:[critical]},{...base,id:'tenant-b',attention:[critical]}],'2 reported',false],
 ['invalid-ids',[{...base,id:' ',attention:[critical]},{...base,id:null,attention:[critical]}],'Unavailable',false],
 ['access-critical',[{...base,attention:[row('Access only','critical',prov.accessProvenance('AUTHORIZATION_REQUIRED',true))]}],'0 reported',false],
 ['collector-critical',[{...base,attention:[ops]}],'0 reported',true],
 ['future-critical',[{...base,attention:[row('Future critical','critical',{...prov.tenantFindingProvenance('MICROSOFT_ACTIVE_RISK'),version:2})]}],'0 reported',true],
 ['malformed-attention',[{...base,attention:{unexpected:true}}],'Unavailable',true],
 ['capped-summary-high-only',[{...base,attention:[high,{...high,key:'second'},{...high,key:'third'}]}],'0 reported',false],
 ['missing-mfa',[{...base,mfaCoverage:null}],'0 reported',true],
 ['missing-risk',[{...base,microsoftRiskSummary:undefined}],'0 reported',true],
 ['missing-sync',[{...base,lastSync:null}],'0 reported',true],
 ['partial-data',[{...base,data:{status:'PARTIAL'}}],'0 reported',true],
 ['partial-microsoft',[{...base,microsoftRiskSummary:{...microsoftSummary,availability:'PARTIAL',completeness:'PARTIAL',rawRecordCount:3,observedActiveDistinctUserCount:2,activeDistinctUserCount:null,reasonCode:'PARTIAL_RECORDS'}}],'0 reported',true],
 ['stale',[base],'0 reported',false,{isStale:true}],
 ['refresh-error',[base],'0 reported',false,{isError:true}],
 ['refreshing',[base],'0 reported',false,{isFetching:true}],
 ['portfolio-error',[base],'0 reported',true,{data:{tenants:[base],error:'Partial tenant result'}}],
]
for(const [name,tenants,expected,partial,state={}]of cases)test('actual Dashboard KPI '+name,async()=>{
 const dom=new JSDOM('<div id="root"></div>',{url:'https://fixture.invalid'})
 for(const [key,value]of Object.entries({window:dom.window,document:dom.window.document,navigator:dom.window.navigator,IS_REACT_ACT_ENVIRONMENT:true}))Object.defineProperty(globalThis,key,{configurable:true,value})
 const rr=createRoot(document.getElementById('root'))
 try{
  currentTenants=tenants;queryState=state
  nativeData=name==='five-mfa-gaps-no-critical'?{contractVersion:'hawkview-native-risk-summary/v1',source:'HAWKVIEW_NATIVE_ASSESSMENT',countUnit:'TENANT_USER_IDENTITIES',generatedAt:at,fleet:{availability:'PARTIAL',accuracy:'AT_LEAST',distinctUserCount:6,assessedTenants:5,totalTenants:5,enumeratedTenants:5,scopeComplete:true,limitations:['PARTIAL_COVERAGE']},tenants:[]}:undefined
  await React.act(async()=>rr.render(h(Dashboard)))
  function card(label){const title=[...document.querySelectorAll('div')].find(e=>e.textContent.trim()===label&&e.children.length===0);assert.ok(title,label);return {title,value:title.nextElementSibling.textContent.trim(),detail:title.parentElement.textContent}}
  const criticalCard=card('Tenants with reported critical findings'),mfa=card('MFA Registration Gaps')
  assert.equal(criticalCard.value,expected)
  assert.doesNotMatch(document.body.textContent,/Tenant security score|Tenant-only score not supplied|Current critical signals|Partial critical-signal evidence/)
  assert.equal(/Partial dashboard evidence/.test(document.body.textContent),partial)
  assert.match(criticalCard.detail,/loaded tenant summaries readable/)
  assert.equal(criticalCard.title.closest('.grid').children.length,3,'three KPI cards')
  if(['duplicate-positive-id','duplicate-unread-id'].includes(name))assert.match(criticalCard.detail,/1 of 1 loaded tenant summaries readable/)
  if(name==='critical-plus-unread-tenant')assert.match(criticalCard.detail,/1 of 2 loaded tenant summaries readable/)
  if(name==='invalid-ids')assert.match(criticalCard.detail,/2 rows without usable tenant IDs/)
  if(expected==='Unavailable')assert.match(criticalCard.detail,/No readable tenant findings summary/)
  else if(tenants.some(t=>customerAttention(t).incomplete))assert.match(criticalCard.detail,/Evidence incomplete; additional findings may be missing/)
  else assert.match(criticalCard.detail,/not an exhaustive security assessment/)
  if(nativeData){assert.match(document.body.textContent,/≥6/);assert.equal(mfa.value,'5')}
  if(name==='stale')assert.match(document.body.textContent,/Stale dashboard evidence/)
  if(name==='refresh-error')assert.match(document.body.textContent,/Dashboard refresh failed/)
  if(name==='refreshing')assert.match(document.body.textContent,/Refreshing dashboard evidence/)
  // Queue filters must not alter the loaded-tenant KPI scope.
  if(name==='critical-plus-unread-tenant'){
   const select=[...document.querySelectorAll('select')].find(s=>[...s.options].some(o=>o.textContent==='All Severities'))
   await React.act(async()=>{select.value='medium';select.dispatchEvent(new dom.window.Event('change',{bubbles:true}))})
   assert.equal(card('Tenants with reported critical findings').value,'1 reported')
  }
  if(process.env.HAW38_VISUAL_OUT)fs.writeFileSync(path.join(process.env.HAW38_VISUAL_OUT,name+'.html'),'<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="styles.css"></head><body class="bg-slate-50 text-slate-900 dark:bg-slate-950 dark:text-slate-100"><main class="mx-auto max-w-7xl p-4">'+document.getElementById('root').innerHTML+'</main></body></html>')
  // Retiring the KPI must not restore the mixed score in the separate matrix.
  if(name==='supplied-backend-score'){
   const button=[...document.querySelectorAll('button')].find(b=>b.textContent.includes('Tenant Risk Matrix'))
   await React.act(async()=>button.click());assert.match(document.body.textContent,/Tenant scoreUnavailable/);assert.doesNotMatch(document.body.textContent,/87%/)
  }
 }finally{await React.act(async()=>rr.unmount());dom.window.close()}
})
for(const [name,state,rows,expected] of [
 ['loading',{isLoading:true},[base],/Loading dashboard evidence/],
 ['request-failed',{isError:true,data:undefined},[],/could not load dashboard evidence/],
 ['empty',{},[],/No tenant rows to display/],
])test('actual Dashboard early state '+name,async()=>{
 const dom=new JSDOM('<div id="root"></div>',{url:'https://fixture.invalid'})
 for(const [key,value]of Object.entries({window:dom.window,document:dom.window.document,navigator:dom.window.navigator,IS_REACT_ACT_ENVIRONMENT:true}))Object.defineProperty(globalThis,key,{configurable:true,value})
 const rr=createRoot(document.getElementById('root'))
 try{currentTenants=rows;queryState=state;nativeData=undefined;await React.act(async()=>rr.render(h(Dashboard)));assert.match(document.body.textContent,expected);assert.doesNotMatch(document.body.textContent,/0 reported|Tenant security score/)}finally{await React.act(async()=>rr.unmount());dom.window.close()}
})
