import { Inject, Injectable } from '@nestjs/common'
import { IdentityRiskPseudonymProvider } from './identity-risk-pseudonym.js'
import { readActiveMailboxKeys } from './mailbox-risk-projector.service.js'
import { withMailboxReadTransaction } from './mailbox-read-transaction.js'
import { assessmentManagedReference, emptyAssessment } from './risk-assessment-projector.service.js'
import { readAssessmentHistory, reconcileAssessmentHistory } from './risk-assessment-history.js'
import { assessmentMeta, assessmentReason, projectStoredRiskAssessment, unknownRiskProtection, type StoredRiskAssessment } from './risk-assessment-projection.js'
import { RISK_ASSESSMENT_SCHEMA, type RiskAssessmentDto, type RiskAssessmentReason, type RiskAssessmentUserDto } from './identity-risk-assessment.contract.js'
import { loadAssessmentProtection } from './risk-assessment-protection-loader.js'
import { MAILBOX_SOURCE_VERSION, sourceAttestationKey } from './mailbox-source-attestation.js'

type Scope={organizationId:string;customerTenantId:string}
export function unavailableAssessment(reason:RiskAssessmentReason='WAITING_FOR_COLLECTION',now=new Date()):RiskAssessmentDto{
  const assessment=emptyAssessment(reason)
  return {version:1,schemaVersion:RISK_ASSESSMENT_SCHEMA,meta:assessmentMeta(assessment,null,now),sources:assessment.sources,rules:assessment.rules,users:[],page:{hasMore:false,nextCursor:null}}
}
const safeLabel=(value:unknown,max=320):value is string=>typeof value==='string'&&value.length>0&&value.length<=max&&!/[\p{Cc}\p{Cf}<>]/u.test(value)
const uuid=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value)

/** Bounded persisted read. It never normalizes events or runs risk detectors.
 * IdentityRiskService authorizes before AND after this private enrichment. */
@Injectable()
export class RiskAssessmentReader{
  constructor(@Inject(IdentityRiskPseudonymProvider)private readonly provider:IdentityRiskPseudonymProvider){}
  async read(scope:Scope,run:{id:string;pseudonymKeyVersionId:string|null;completedAt:Date|null},now:Date,_evidenceDetailAllowed:boolean):Promise<RiskAssessmentDto>{
    const environment=process.env.HAWKVIEW_IDENTITY_RISK_ENVIRONMENT
    if(!environment||!run.pseudonymKeyVersionId||!this.provider.configured||!this.provider.allowsScope({...scope,environment}))return unavailableAssessment('KEY_UNAVAILABLE',now)
    const {tryInSyncMemoryLane}=await import('../tenants/tenant-sync.service.js')
    return await tryInSyncMemoryLane(async()=>{
      const deadline=Date.now()+15_000
      const keys=await readActiveMailboxKeys(scope,environment,now,deadline)
      if(keys.length!==1||keys[0]!.id!==run.pseudonymKeyVersionId)return unavailableAssessment('KEY_UNAVAILABLE',now)
      const session=await this.provider.pin(keys[0]!,deadline)
      try{
        const loaded=await withMailboxReadTransaction(deadline,4000,async client=>{
          const runs=(await client.query<{assessment:unknown;mailboxGenerations:unknown}>(`SELECT CASE WHEN octet_length(aggregate::text)<=1000000 THEN aggregate->'assessment' ELSE NULL END AS assessment,
            CASE WHEN octet_length(aggregate::text)<=1000000 THEN aggregate->'assessmentMailboxGenerations' ELSE NULL END AS "mailboxGenerations"
            FROM identity_risk_evaluation_runs WHERE id=$1::uuid AND organization_id=$2::uuid AND customer_tenant_id=$3::uuid
              AND status='COMPLETED' AND expires_at>$4 AND pseudonym_key_version_id=$5::uuid LIMIT 1`,
          [run.id,scope.organizationId,scope.customerTenantId,now,run.pseudonymKeyVersionId])).rows
          const tenant=(await client.query<{microsoftTenantId:string}>(`SELECT microsoft_tenant_id AS "microsoftTenantId" FROM customer_tenants
            WHERE id=$1::uuid AND organization_id=$2::uuid AND status='ACTIVE' LIMIT 1`,[scope.customerTenantId,scope.organizationId])).rows[0]
          const users=(await client.query<{id:string;label:string}>(`SELECT microsoft_user_id AS id,user_principal_name AS label FROM directory_users
            WHERE organization_id=$1::uuid AND customer_tenant_id=$2::uuid AND deleted_at IS NULL ORDER BY id LIMIT 2001`,[scope.organizationId,scope.customerTenantId])).rows
          const sources=(await client.query<{resource:string;observedAt:Date;status:string;lastSuccess:Date|null;lastAttempt:Date|null;payload:unknown}>(`SELECT s.resource_type AS resource,s.observed_at AS "observedAt",y.status,y.last_successful_at AS "lastSuccess",y.last_attempt_at AS "lastAttempt",
            CASE WHEN jsonb_typeof(s.payload)='array' THEN CASE WHEN jsonb_array_length(s.payload)<=1000 AND octet_length(s.payload::text)<=1000000 THEN
              (SELECT coalesce(jsonb_agg(jsonb_build_object('id',x->'id','appId',x->'appId','displayName',x->'displayName','mail',x->'mail','userPrincipalName',x->'userPrincipalName')),'[]'::jsonb) FROM jsonb_array_elements(s.payload)x)
              ELSE NULL END ELSE NULL END AS payload
            FROM tenant_entra_snapshots s JOIN sync_states y ON y.organization_id=s.organization_id AND y.customer_tenant_id=s.customer_tenant_id AND y.resource_type=s.resource_type
            WHERE s.organization_id=$1::uuid AND s.customer_tenant_id=$2::uuid AND s.resource_type IN('EXCHANGE_MAILBOXES','APPLICATIONS','SERVICE_PRINCIPALS') LIMIT 3`,[scope.organizationId,scope.customerTenantId])).rows
          const states=(await client.query<{resource:string;status:string;lastSuccess:Date|null;lastAttempt:Date|null}>(`SELECT resource_type AS resource,status,last_successful_at AS "lastSuccess",last_attempt_at AS "lastAttempt"
            FROM sync_states WHERE organization_id=$1::uuid AND customer_tenant_id=$2::uuid AND resource_type IN('SIGN_INS','USERS','EXCHANGE_MAILBOX_RULES','EXCHANGE_ACCEPTED_DOMAINS') LIMIT 4`,[scope.organizationId,scope.customerTenantId])).rows
          // Check the exact two attested generations used by the persisted run.
          // Do not reload mailbox payloads or evaluate forwarding in GET. Legacy
          // runs without these private pins remain unknown, never current.
          const pins=runs[0]?.mailboxGenerations
          let mailboxCurrent=Array.isArray(pins)&&pins.length===2
          for(const resource of ['EXCHANGE_MAILBOX_RULES','EXCHANGE_ACCEPTED_DOMAINS'] as const){
            const matching=Array.isArray(pins)?pins.filter(pin=>pin&&typeof pin==='object'&&pin.resourceType===resource):[]
            const pin=matching[0]
            if(matching.length!==1||!pin||Object.keys(pin).sort().join(',')!=='digest,observedAt,resourceType'||
              typeof pin.digest!=='string'||!/^[a-f0-9]{64}$/.test(pin.digest)||typeof pin.observedAt!=='string'||
              !Number.isFinite(Date.parse(pin.observedAt))){mailboxCurrent=false;continue}
            const rows=(await client.query(`SELECT s.id FROM tenant_entra_snapshots s
              JOIN tenant_collection_field_states f ON f.organization_id=s.organization_id AND f.customer_tenant_id=s.customer_tenant_id AND f.field_key=$4
              JOIN sync_states y ON y.organization_id=s.organization_id AND y.customer_tenant_id=s.customer_tenant_id AND y.resource_type=s.resource_type
              WHERE s.organization_id=$1::uuid AND s.customer_tenant_id=$2::uuid AND s.resource_type::text=$3
                AND s.observed_at=$5::timestamptz AND s.observed_at<=$8::timestamptz AND s.observed_at>=$8::timestamptz-INTERVAL '36 hours'
                AND f.state='COMPLETE' AND f.source=$6 AND f.correlation_id=$7 AND f.last_successful_at=s.observed_at
                AND y.status='SUCCEEDED' AND y.last_successful_at>=s.observed_at
                AND (y.last_attempt_at IS NULL OR y.last_attempt_at<=y.last_successful_at) LIMIT 1`,
              [scope.organizationId,scope.customerTenantId,resource,sourceAttestationKey(resource),pin.observedAt,MAILBOX_SOURCE_VERSION,pin.digest,now])).rows
            if(rows.length!==1)mailboxCurrent=false
          }
          return {raw:runs[0]?.assessment,tenant,users,sources,states,mailboxCurrent}
        })
        if(!loaded.tenant)return unavailableAssessment('SOURCE_UNAVAILABLE',now)
        const parsed=projectStoredRiskAssessment(loaded.raw,now,'PERSISTED_HISTORY')
        if(!parsed)return unavailableAssessment('WAITING_FOR_COLLECTION',now)
        let metadata:StoredRiskAssessment={...parsed,subjects:[],sources:parsed.sources.map(source=>{
          const resources=source.source==='MAILBOX_RULES'?['EXCHANGE_MAILBOX_RULES','EXCHANGE_ACCEPTED_DOMAINS']:['SIGN_INS']
          const failed=!run.completedAt||(source.source==='MAILBOX_RULES'&&!loaded.mailboxCurrent)||resources.some(resource=>{
            const state=loaded.states.find(state=>state.resource===resource)
            return !state||!state.lastSuccess||state.lastSuccess>now||state.status==='FAILED'||(state.lastAttempt&&state.lastAttempt>state.lastSuccess)||
              (source.source!=='MAILBOX_RULES'&&source.lastSuccessfulCollectionAt!==null&&state.lastSuccess.toISOString()!==source.lastSuccessfulCollectionAt)
          })
          if(failed&&['READY','PARTIAL'].includes(source.status))return {...source,status:'FAILED' as const,reasonCode:'EVALUATION_FAILED' as const,explanation:assessmentReason('EVALUATION_FAILED'),freshness:'UNKNOWN' as const}
          if(source.lastSuccessfulCollectionAt&&now.getTime()-Date.parse(source.lastSuccessfulCollectionAt)>(source.source==='MAILBOX_RULES'?36*60*60_000:60*60_000))
            return {...source,status:'STALE' as const,reasonCode:'COLLECTION_STALE' as const,explanation:assessmentReason('COLLECTION_STALE'),freshness:'STALE' as const}
          return source
        })}
        metadata={...metadata,rules:metadata.rules.map(rule=>{
          const source=metadata.sources.find(source=>source.source===rule.selectedSource)
          return source&&['FAILED','STALE'].includes(source.status)?{...rule,status:source.status,reasonCode:source.reasonCode,explanation:source.explanation,assessedIdentities:null,matchedIdentities:null}:rule
        })}
        const history=await readAssessmentHistory(scope,session.keyVersion.id,metadata,now,deadline)
        const assessment=projectStoredRiskAssessment(reconcileAssessmentHistory(metadata,history.subjects,now),now)
        if(!assessment)return unavailableAssessment('EVALUATION_FAILED',now)
        const reference=assessmentManagedReference(session)
        const labels=new Map<string,{label:string;userId:string|null;canonicalId:string}>()
        const directoryIds=new Map<string,{label:string;userId:string;canonicalId:string}>()
        const userState=loaded.states.find(state=>state.resource==='USERS')
        const directoryCurrent=!!userState&&userState.status==='SUCCEEDED'&&!!userState.lastSuccess&&userState.lastSuccess<=now&&now.getTime()-userState.lastSuccess.getTime()<=26*60*60_000&&(!userState.lastAttempt||userState.lastAttempt<=userState.lastSuccess)
        if(directoryCurrent&&loaded.users.length<=2000)for(const user of loaded.users){
          if(!uuid(user.id)||!safeLabel(user.label))continue
          const id=await reference('subject',[scope.organizationId,scope.customerTenantId,loaded.tenant.microsoftTenantId,user.id.toLowerCase()])
          const label={label:user.label,userId:user.id.toLowerCase(),canonicalId:id}
          labels.set(id,label);directoryIds.set(user.id.toLowerCase(),label)
        }
        const apps=new Map<string,string|null>()
        for(const source of loaded.sources){
          if(source.status!=='SUCCEEDED'||!source.lastSuccess||source.lastSuccess<source.observedAt||source.observedAt>now||now.getTime()-source.observedAt.getTime()>26*60*60_000||
            (source.lastAttempt&&source.lastAttempt>source.lastSuccess)||!Array.isArray(source.payload))continue
          for(const value of source.payload){
            if(!value||typeof value!=='object')continue
            if(source.resource==='EXCHANGE_MAILBOXES'){
              const label=value.mail??value.userPrincipalName
              if(uuid(value.id)&&safeLabel(label)){
                const id=await session.reference('mailbox',[value.id])
                // Exact current directory GUID only. Never join by UPN/display
                // name; an unresolved/shared mailbox remains a mailbox row.
                labels.set(id,directoryIds.get(value.id.toLowerCase())??{label,userId:null,canonicalId:id})
              }
            }else if(uuid(value.appId)&&safeLabel(value.displayName,256)){
              const id=await reference('application',[scope.organizationId,scope.customerTenantId,loaded.tenant.microsoftTenantId,value.appId.toLowerCase()])
              apps.set(id,apps.has(id)&&apps.get(id)!==value.displayName?null:value.displayName)
            }
          }
        }
        const protectionIds=[...new Set(assessment.subjects.flatMap(subject=>{const id=labels.get(subject.id)?.userId;return id?[id]:[]}))]
        const protections=_evidenceDetailAllowed?await loadAssessmentProtection(scope,protectionIds,now,deadline):new Map()
        const grouped=new Map<string,RiskAssessmentUserDto>()
        let omitted=0
        for(const subject of assessment.subjects){
          const label=labels.get(subject.id);if(!label){omitted++;continue}
          const prior=grouped.get(label.canonicalId)
          const findings=[...(prior?.findings??[]),...subject.findings.map(finding=>({...finding,
            application:{...finding.application,label:finding.application.id?apps.get(finding.application.id)??null:null}}))]
          const current=findings.filter(f=>f.activityState==='CURRENT')
          const priority=current.some(f=>f.priority==='HIGH')?'HIGH':current.some(f=>f.priority==='MEDIUM')?'MEDIUM':current.length?'LOW':null
          grouped.set(label.canonicalId,{id:label.canonicalId,subjectType:label.userId?'USER':subject.subjectType,label:label.label,priority,
            protection:label.userId?protections.get(label.userId.toLowerCase())??unknownRiskProtection():unknownRiskProtection(),findings})
        }
        const users=[...grouped.values()]
        const incomplete=history.capped||omitted>0
        const rules=incomplete?assessment.rules.map(rule=>['READY','PARTIAL'].includes(rule.status)?{...rule,status:'PARTIAL' as const,reasonCode:'CAPACITY_LIMIT' as const,
          explanation:assessmentReason('CAPACITY_LIMIT'),countsCapped:true,assessedIdentities:null,matchedIdentities:null}:rule):assessment.rules
        return {version:1 as const,schemaVersion:RISK_ASSESSMENT_SCHEMA,meta:assessmentMeta({...assessment,rules},run.completedAt?.toISOString()??null,now),sources:assessment.sources,rules,users,page:{hasMore:false,nextCursor:null}}
      }finally{session.close?.()}
    })??unavailableAssessment('SOURCE_UNAVAILABLE',now)
  }
}
