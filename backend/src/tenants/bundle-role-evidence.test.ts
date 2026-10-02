import assert from 'node:assert/strict'
import test from 'node:test'
import {TenantSyncService} from './tenant-sync.service.js'
const NOW=new Date('2026-10-01T12:00:00Z'), ORG='10000000-0000-4000-8000-000000000001',TENANT='10000000-0000-4000-8000-000000000002',USER='10000000-0000-4000-8000-000000000003',GROUP='10000000-0000-4000-8000-000000000004',ROLE='10000000-0000-4000-8000-000000000005';
type Options = {
 observedAt?: string | null; noRegistration?: boolean; noContext?: boolean;
 source?: 'AUTH_REGISTRATIONS' | 'DIRECTORY_ROLES'; status?: string;
 sourceTime?: Date | null; missingSource?: boolean; directRole?: boolean;
 independentPolicy?: boolean;
};
async function bundle(complete:boolean,groups:string[],selectors:any,reasonCode?:string, options: Options = {}){
 const tenant={id:TENANT,organizationId:ORG,microsoftTenantId:'10000000-0000-4000-8000-000000000006',displayName:'Synthetic',primaryDomain:'example.invalid',status:'CONNECTED',connection:{lastVerifiedAt:NOW,consentedAt:NOW,onboardingCompletedAt:NOW,exchangeReadOnlyEnabledAt:null}};
 const user={id:'local-user',microsoftUserId:USER,displayName:'Synthetic user',userPrincipalName:'synthetic@example.invalid',userType:'Member',accountEnabled:true,assignedLicenseSkuIds:[],groupMemberships:[]};
 const registration={id:USER,isMfaRegistered:true,methodsRegistered:['fido2'],conditionalAccessContext:{transitiveGroupIds:groups,membershipComplete:complete,observedAt: options.observedAt === undefined ? NOW.toISOString() : options.observedAt,...(reasonCode?{reasonCode}:{})}};
 const policy={id:'only-policy',displayName:'Only policy',state:'enabled',conditions:{users:selectors,applications:{includeApplications:['All']}},grantControls:{operator:'OR',builtInControls:['mfa']}};
 const payloads:any={AUTH_REGISTRATIONS:options.noRegistration ? [] : [options.noContext ? {...registration,conditionalAccessContext:null} : registration],DIRECTORY_ROLES:[{principalId:options.directRole ? USER : GROUP,roleDefinition:{templateId:ROLE,displayName:'Synthetic role'}}],CONDITIONAL_ACCESS:options.independentPolicy ? [policy,{...policy,id:'independent',conditions:{...policy.conditions,users:{includeUsers:[USER]}}}] : [policy],AUTHENTICATION_STRENGTHS:[],SECURITY_DEFAULTS:[{isEnabled:false}]};
 let identityReads=0,tenantReads=0,scopedReads=0;
 const scoped=(args:any)=>{assert.equal(args.where.organizationId,ORG);assert.equal(args.where.customerTenantId,TENANT);scopedReads++};
 const many=(rows:any[])=>({findMany:async(args:any)=>{scoped(args);return rows}});
 const prisma:any={
 user:{findUnique:async(args:any)=>{assert.equal(args.where.authProviderUserId,'synthetic-identity');identityReads++;return {disabledAt:null,memberships:[{organizationId:ORG}]}}},
 customerTenant:{findFirst:async(args:any)=>{assert.equal(args.where.id,TENANT);assert.deepEqual(args.where.organizationId,{in:[ORG]});tenantReads++;return tenant}},
 directoryUser:many([user]),directoryGroup:many([]),tenantLicense:many([]),tenantDomain:many([]),tenantCollectionFieldState:many([]),signInLog:many([]),directoryAuditLog:many([]),m365ActivitySubscription:many([]),
 tenantEntraSnapshot:many(Object.entries(payloads).map(([resourceType,payload])=>({resourceType,payload,observedAt:NOW}))),
 syncState:many(Object.keys(payloads).filter(resourceType=>!(options.missingSource && resourceType===options.source)).map(resourceType=>({resourceType,status:resourceType===options.source ? options.status ?? 'SUCCEEDED' : 'SUCCEEDED',lastAttemptAt:NOW,lastSuccessfulAt:resourceType===options.source && options.sourceTime !== undefined ? options.sourceTime : NOW,lastErrorCode:null,lastErrorMessage:null,consecutiveFailures:0}))),
 m365ActivityContent:{groupBy:async(a:any)=>{scoped(a);return []},findFirst:async(a:any)=>{scoped(a);return null}},m365AuditDailyUsage:{findFirst:async(a:any)=>{scoped(a);return null},aggregate:async(a:any)=>{scoped(a);return {_sum:{downloadedBytes:null,recordsStored:null,blobsProcessed:null}}}}
 };
 const service=new TenantSyncService(prisma,{} as never,{} as never,{} as never,{} as never,{} as never);
 const result=await service.getBundleForIdentity({subject:'synthetic-identity'} as never,TENANT);assert.equal(identityReads,1);assert.equal(tenantReads,1);assert.equal(scopedReads,14);assert.equal(result.bundle.users.length,1);return result.bundle.users[0];
}

const exclusion = {includeUsers:['All'],excludeRoles:[ROLE]};
const inclusion = {includeRoles:[ROLE]};
type Case = {name:string; complete?:boolean; groups?:string[]; selectors?:unknown;
 reason?:string; options?:Options; expected?:string};
const cases:Case[] = [
 {name:'incomplete role exclusion',complete:false},
 {name:'permission-limited role exclusion',complete:false,reason:'PERMISSION_LIMITED'},
 {name:'valid empty role exclusion',expected:'COVERED_BY_CONDITIONAL_ACCESS'},
 {name:'matching group role exclusion',groups:[GROUP],expected:'NOT_COVERED'},
 {name:'matching direct role exclusion',options:{directRole:true},expected:'NOT_COVERED'},
 {name:'incomplete group exclusion',complete:false,selectors:{includeUsers:['All'],excludeGroups:[GROUP]}},
 {name:'direct-user independent policy',complete:false,selectors:{includeUsers:[USER]},expected:'COVERED_BY_CONDITIONAL_ACCESS'},
 {name:'all-users independent policy',complete:false,selectors:{includeUsers:['All']},expected:'COVERED_BY_CONDITIONAL_ACCESS'},
 {name:'second independent policy',complete:false,options:{independentPolicy:true},expected:'COVERED_BY_CONDITIONAL_ACCESS'},
 {name:'incomplete role inclusion',complete:false,selectors:inclusion},
 {name:'permission-limited role inclusion',complete:false,reason:'PERMISSION_LIMITED',selectors:inclusion},
 {name:'matching group role inclusion',groups:[GROUP],selectors:inclusion,expected:'COVERED_BY_CONDITIONAL_ACCESS'},
 {name:'matching direct role inclusion',selectors:inclusion,options:{directRole:true},expected:'COVERED_BY_CONDITIONAL_ACCESS'},
 {name:'valid empty role inclusion',selectors:inclusion,expected:'NOT_COVERED'},
 {name:'direct assignment does not repair incomplete closure',complete:false,selectors:inclusion,options:{directRole:true}},
 {name:'missing registration',options:{noRegistration:true}},
 {name:'missing context',options:{noContext:true}},
 {name:'missing membership timestamp',options:{observedAt:null}},
 {name:'invalid membership timestamp',options:{observedAt:'invalid'}},
 {name:'invalid calendar timestamp',options:{observedAt:'2026-09-31T12:00:00Z'}},
 {name:'future membership timestamp',options:{observedAt:'2026-10-01T12:00:01Z'}},
 {name:'stale membership timestamp',options:{observedAt:'2026-09-30T09:59:59.999Z'}},
 {name:'membership freshness boundary',options:{observedAt:'2026-09-30T10:00:00Z'},expected:'COVERED_BY_CONDITIONAL_ACCESS'},
 {name:'membership newer than auth source',options:{source:'AUTH_REGISTRATIONS',sourceTime:new Date('2026-10-01T11:00:00Z')}},
 {name:'malformed group member',groups:['not-a-guid']},
 {name:'oversized membership',groups:Array(1001).fill(GROUP)},
];
for (const source of ['AUTH_REGISTRATIONS','DIRECTORY_ROLES'] as const) {
 for (const [name,options] of Object.entries({
  stale:{sourceTime:new Date('2026-09-30T09:59:59.999Z')},
  failed:{status:'FAILED'}, partial:{status:'PARTIAL'}, missing:{missingSource:true},
  neverSucceeded:{sourceTime:null}, future:{sourceTime:new Date('2026-10-01T12:00:01Z')},
 })) {
  for (const [selectorName,selectors] of [['exclude',exclusion],['include',inclusion]] as const) {
   cases.push({name:`${source} ${name} ${selectorName}`,selectors,options:{source,...options}});
  }
 }
 cases.push({name:`independent policy despite failed ${source}`,selectors:{includeUsers:['All']},options:{source,status:'FAILED'},expected:'COVERED_BY_CONDITIONAL_ACCESS'});
}
for (const c of cases) {
 test(`public bundle: ${c.name}`,async t=>{
  t.mock.timers.enable({apis:['Date'],now:NOW});
  t.mock.method(globalThis,'fetch',()=>{throw Error('network prohibited')});
  const row=await bundle(c.complete ?? true,c.groups ?? [],c.selectors ?? exclusion,c.reason,c.options);
  const expected=c.expected ?? 'UNKNOWN';
  assert.equal(row.effectiveMfaEnforcement.status,expected);
  assert.equal(row.effectiveMfaEnforcement.riskReductionAllowed,expected==='COVERED_BY_CONDITIONAL_ACCESS');
  if (!c.options?.noRegistration) assert.equal(row.mfaRegistration,'Registered');
  if(c.name.includes('matching') && c.name.includes('exclusion')) assert(row.effectiveMfaEnforcement.reasonCodes.includes('EFFECTIVE_EXCLUSION'));
 });
}
