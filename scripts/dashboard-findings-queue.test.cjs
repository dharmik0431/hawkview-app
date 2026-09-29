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
const projection=load(root+'/lib/attention/computeTenantAttention.ts')
const helpers=load(root+'/components/dashboard/tenant-risk-matrix-helpers.ts')
const Dashboard=load(root+'/app/(protected)/dashboard/page.tsx').default
const access={key:'authorization-required',label:'Required Microsoft consent',why:'A required permission needs customer consent.',severity:'high',provenance:prov.accessProvenance('AUTHORIZATION_REQUIRED',true)}
const finding={key:'mfa-gap',label:'Reported registration gap',why:'Registration coverage needs review; this is not enforcement proof.',severity:'critical',provenance:prov.tenantFindingProvenance('MFA_REGISTRATION_COVERAGE')}
const tenant={id:'tenant-a',name:'Contoso customer',provider:'microsoft',domain:'contoso.example',connectionStatus:'connected',status:'active',data:{status:'COMPLETE'},healthScore:100,secureScore:null,mfaCoverage:null,lastSync:at,missingPermissions:[],organization:{id:'org-a'}}
for(const [name,attention,filtered] of [
 ['access-only',[access],false],['complete-empty',[],false],
 ['access-only-filtered',[access],true],['complete-empty-filtered',[],true],
 ['complete-finding',[finding],false],['complete-finding-filtered',[finding],true],
]) test(`actual Dashboard findings queue: ${name}`,async()=>{
 const dom=new JSDOM('<div id="root"></div>',{url:'https://fixture.invalid'})
 for(const [key,value]of Object.entries({window:dom.window,document:dom.window.document,navigator:dom.window.navigator,IS_REACT_ACT_ENVIRONMENT:true}))Object.defineProperty(globalThis,key,{configurable:true,value})
 const rr=createRoot(document.getElementById('root'))
 try {
  currentTenant={...tenant,attention}
  await React.act(async()=>rr.render(h(Dashboard)))
  if(filtered){
   const select=[...document.querySelectorAll('select')].find(s=>[...s.options].some(o=>o.textContent==='All Severities'))
   assert.ok(select,'actual severity filter exists')
   await React.act(async()=>{select.value='high';select.dispatchEvent(new dom.window.Event('change',{bubbles:true}))})
  }
  const text=document.body.textContent
  const expectedCount=name==='complete-finding'?1:0
  assert.match(text,new RegExp(`${expectedCount} matching finding`))
  assert.doesNotMatch(text,/Nothing needs action|none raised anything|matching alerts|No matching alerts/i)
  if(expectedCount===0){
   assert.match(text,filtered?/No tenant findings match these filters/:/No tenant findings reported in this view/)
   assert.match(text,/Customer access setup is shown separately/)
   assert.match(text,/not an exhaustive security assessment/)
  }else assert.match(text,/Reported registration gap/)
  // A findings-only queue must not erase the separate validated access action.
  const p=projection.tenantActionableHealthProjection(currentTenant)
  assert.equal(p.status,'VERIFIED')
  assert.equal(p.customer.accessActions.length,name.startsWith('access-only')?1:0)
  if(name.startsWith('access-only')){
   assert.equal(p.items.length,1)
   assert.equal(helpers.getTenantRecommendedAction(currentTenant).label,'Review access setup')
  }
  if(process.env.HAW38_VISUAL_OUT){
   for(const option of document.querySelectorAll('option'))if(option.selected)option.setAttribute('selected','')
   fs.writeFileSync(path.join(process.env.HAW38_VISUAL_OUT,name+'.html'),'<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="styles.css"><style>body{font-family:Arial,sans-serif}</style></head><body class="bg-slate-50 text-slate-900"><main class="mx-auto max-w-7xl p-4 md:p-6">'+document.getElementById('root').innerHTML+'</main></body></html>')
  }
  if(name.startsWith('access-only')) {
   const matrixButton=[...document.querySelectorAll('button')].find(b=>b.textContent.includes('Tenant Risk Matrix'))
   assert.ok(matrixButton,'separate matrix surface remains reachable')
   await React.act(async()=>matrixButton.click())
   assert.match(document.body.textContent,/Review access setup/)
   assert.doesNotMatch(document.body.textContent,/Nothing needs action|none raised anything/)
  }
 }finally{await React.act(async()=>rr.unmount());dom.window.close()}
})
