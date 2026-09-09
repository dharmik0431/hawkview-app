import { Inject, Injectable } from '@nestjs/common'
import { createHash } from 'node:crypto'
import { IdentityRiskPseudonymProvider, type PinnedPseudonymSession } from './identity-risk-pseudonym.js'
import { IDENTITY_RISK_CATALOG_VERSION, IDENTITY_RISK_ENGINE_VERSION, type IdentityRiskSourceBatch } from './identity-risk.contract.js'
import { MailboxRiskProjector, MAILBOX_FIRST_SLICE_FLAGS, readActiveMailboxKeys } from './mailbox-risk-projector.service.js'
import { adaptApprovedIdentitySignalDetector } from './identity-risk-approved-evaluator.adapter.js'
import { loadAuthenticationRiskEvidence } from './authentication-risk-loader.js'
import { unavailableAuthenticationSource } from './authentication-source-readiness.js'
import { withMailboxReadTransaction } from './mailbox-read-transaction.js'
import { evaluateAuthenticationRules } from '../risky-users-auth/index.js'
import { projectAuthenticationAssessment } from '../risky-users-auth/to-assessment.js'
import { RISK_ASSESSMENT_SCHEMA, RISK_ASSESSMENT_RULE_IDS, RISK_ASSESSMENT_RULE_TUPLES,
  type RiskAssessmentReason, type RiskAssessmentFindingDto, type RiskSourceReadinessDto, type RiskRuleReadinessDto } from './identity-risk-assessment.contract.js'
import { ASSESSMENT_COPY, assessmentActions, assessmentReason, assessmentMeta, projectStoredRiskAssessment, type StoredRiskAssessment } from './risk-assessment-projection.js'
import { readAssessmentHistory, reconcileAssessmentHistory } from './risk-assessment-history.js'

type Scope = { organizationId: string; customerTenantId: string }
export function assessmentManagedReference(session: PinnedPseudonymSession) {
  return async (kind: 'subject'|'application'|'contribution'|'evidence'|'context', identifiers: readonly string[]) => {
    if (!['subject','application','contribution','evidence','context'].includes(kind) || identifiers.length < 1 || identifiers.length > 8 ||
      identifiers.some(id => typeof id !== 'string' || !id || id.length > 512 || /[\p{Cc}\p{Cf}]/u.test(id))) throw new Error('IDENTITY_RISK_REFERENCE_INVALID')
    // Domain-separated MAC through the existing immutable managed key. Hash
    // only bounds the message; it is not a replacement for managed MAC or scope.
    const input = createHash('sha256').update(JSON.stringify(identifiers)).digest('hex')
    const value = await session.reference('evidence',['risk-assessment-reference/v1',kind,input])
    if (!/^hvr1_evidence_[a-f0-9]{64}$/.test(value)) throw new Error('IDENTITY_RISK_REFERENCE_INVALID')
    return value.replace('hvr1_evidence_',`hvr1_${kind}_`)
  }
}
export function emptyAssessment(reason: RiskAssessmentReason = 'WAITING_FOR_COLLECTION'): StoredRiskAssessment {
  const auth = (['GRAPH_SIGN_INS','M365_AUDIT_STS'] as const).map(source => unavailableAuthenticationSource(source,reason))
  const mailbox: RiskSourceReadinessDto = { ...auth[0]!,source:'MAILBOX_RULES' }
  return {schemaVersion:RISK_ASSESSMENT_SCHEMA,sources:[...auth,mailbox],subjects:[],rules:RISK_ASSESSMENT_RULE_IDS.map(ruleId=>({
    ruleId,ruleVersion:RISK_ASSESSMENT_RULE_TUPLES[ruleId].version,title:ASSESSMENT_COPY[ruleId].title,status:mailbox.status,
    reasonCode:reason,explanation:assessmentReason(reason),selectedSource:null,window:{start:null,end:null},evaluatedAt:null,
    assessedIdentities:null,matchedIdentities:null,countsCapped:reason==='CAPACITY_LIMIT',
  }))}
}
export async function projectMailboxAssessment(batch: IdentityRiskSourceBatch | null, now: Date, reference: ReturnType<typeof assessmentManagedReference>) {
  const empty=emptyAssessment('SOURCE_NOT_ATTESTED')
  if (!batch || batch.capability!=='FULL' || !batch.sourceObservedAt) return {source:empty.sources.find(s=>s.source==='MAILBOX_RULES')!,rule:empty.rules[2]!,subjects:[] as StoredRiskAssessment['subjects']}
  const observedAt=batch.sourceObservedAt.toISOString()
  const source:RiskSourceReadinessDto={source:'MAILBOX_RULES',status:'READY',reasonCode:'ATTESTED_COMPLETE',explanation:assessmentReason('ATTESTED_COMPLETE'),
    window:{start:observedAt,end:observedAt},lastSuccessfulCollectionAt:observedAt,latestEventAt:observedAt,latestIngestionAt:observedAt,freshness:'CURRENT'}
  const results=await adaptApprovedIdentitySignalDetector({ruleId:'HV-ID-MBX-001.v1',configuration:{readiness:'READY',featureFlags:MAILBOX_FIRST_SLICE_FLAGS}}).evaluate({
    ...batch.context,capability:batch.capability,sources:{EXCHANGE_MAILBOX_RULES:batch.sourceEnvelopes.map(envelope=>envelope.payload)},
  })
  const subjects=new Map<string,{id:string;subjectType:'MAILBOX';findings:RiskAssessmentFindingDto[]}>()
  let incomplete=false
  for(const result of results) {
    if(result.outcome==='NOT_EVALUATED'||result.outcome==='SUPPRESSED') {incomplete=true;continue}
    if(result.outcome!=='MATCHED')continue
    if(result.severity!=='HIGH'||result.subjectType!=='MAILBOX'||!result.observedAt||!result.candidateReference||
      !/^hvr1_mailbox_[a-f0-9]{64}$/.test(result.subjectId))throw new Error('IDENTITY_RISK_MAILBOX_RESULT_INVALID')
    const seen=result.observedAt.toISOString()
    const finding:RiskAssessmentFindingDto={id:await reference('contribution',['HV-ID-MBX-001.v1',result.subjectId,result.candidateReference]),
      ruleId:'HV-ID-MBX-001.v1',ruleVersion:'v1',priority:'HIGH',confidence:result.confidence==='HIGH'?'HIGH':result.confidence==='LOW'?'LOW':'MEDIUM',activityState:'CURRENT',
      ...ASSESSMENT_COPY['HV-ID-MBX-001.v1'],firstSeen:seen,lastSeen:seen,evaluatedAt:now.toISOString(),
      activityWindowEndsAt:new Date(result.observedAt.getTime()+36*60*60_000).toISOString(),window:{start:seen,end:seen},
      evidenceCount:result.evidenceReferences?.length??0,evidenceCountCapped:false,selectedSource:'MAILBOX_RULES',
      application:{id:null,state:'NOT_REPORTED',label:null},device:{state:'NOT_REPORTED',label:null},clientSource:{reference:null,qualification:'NOT_REPORTED'},
      evidenceReferences:(result.evidenceReferences??[]).map(id=>({id,recordedAt:seen,ingestedAt:seen})),eventProtection:'NOT_REPORTED',recommendedActions:assessmentActions('HV-ID-MBX-001.v1')}
    const subject=subjects.get(result.subjectId)??{id:result.subjectId,subjectType:'MAILBOX' as const,findings:[]}
    subject.findings.push(finding);subjects.set(subject.id,subject)
  }
  const state=incomplete?'PARTIAL':'READY',reason=incomplete?'INCOMPLETE_WINDOW':'READY'
  const rule:RiskRuleReadinessDto={...empty.rules[2]!,status:state,reasonCode:reason,explanation:assessmentReason(reason),selectedSource:'MAILBOX_RULES',
    window:source.window,evaluatedAt:now.toISOString(),assessedIdentities:incomplete?null:new Set(results.filter(r=>r.subjectType==='MAILBOX').map(r=>r.subjectId)).size,
    matchedIdentities:incomplete?null:subjects.size}
  return {source,rule,subjects:[...subjects.values()]}
}

@Injectable()
export class RiskAssessmentProjector {
  constructor(@Inject(IdentityRiskPseudonymProvider)private readonly provider:IdentityRiskPseudonymProvider,
    @Inject(MailboxRiskProjector)private readonly mailbox:MailboxRiskProjector){}
  async load(scope:Scope,evaluationAt:Date,executionDeadlineAt=Date.now()+30_000):Promise<IdentityRiskSourceBatch>{
    const environment=process.env.HAWKVIEW_IDENTITY_RISK_ENVIRONMENT
    if(!environment||!this.provider.configured||!this.provider.allowsScope({...scope,environment}))throw new Error('IDENTITY_RISK_KEY_UNAVAILABLE')
    const keys=await readActiveMailboxKeys(scope,environment,evaluationAt,executionDeadlineAt)
    if(keys.length!==1)throw new Error('IDENTITY_RISK_KEY_UNAVAILABLE')
    const session=await this.provider.pin(keys[0]!,executionDeadlineAt)
    try {
      const tenant=await withMailboxReadTransaction(executionDeadlineAt,1500,async client=>(await client.query<{microsoftTenantId:string}>(
        `SELECT microsoft_tenant_id AS "microsoftTenantId" FROM customer_tenants WHERE id=$1::uuid AND organization_id=$2::uuid AND status='ACTIVE' LIMIT 1`,
        [scope.customerTenantId,scope.organizationId])).rows[0])
      if(!tenant)throw new Error('IDENTITY_RISK_SCOPE_UNAVAILABLE')
      const reference=assessmentManagedReference(session)
      let assessment=emptyAssessment(),authenticationProof:IdentityRiskSourceBatch['authenticationProof']
      const disputed=new Set<string>()
      try {
        const auth=await loadAuthenticationRiskEvidence({...scope,microsoftTenantId:tenant.microsoftTenantId},evaluationAt,Math.min(executionDeadlineAt,Date.now()+7000),reference)
        assessment={...assessment,sources:[...auth.sources,assessment.sources[2]!]}
        if(auth.input){
          const result=evaluateAuthenticationRules(auth.input)
          const part=await projectAuthenticationAssessment(auth.input,result,reference)
          const source=auth.sources.find(s=>s.source===auth.input!.source)!
          assessment={...assessment,subjects:part.subjects,rules:[...part.rules.map(rule=>({...rule,window:{start:auth.input!.authorizedFrom,end:source.window.end},
            ...(rule.status==='INSUFFICIENT_FIELDS'&&part.subjects.some(subject=>subject.findings.some(finding=>finding.ruleId===rule.ruleId&&finding.activityState==='CURRENT'))?
              {status:'PARTIAL' as const,reasonCode:'INSUFFICIENT_FIELDS' as const,explanation:assessmentReason('INSUFFICIENT_FIELDS')}:{}),
          })),assessment.rules[2]!]}
          authenticationProof=auth.proof
          for(const id of [...result.conflictingEventIds,...auth.disputedEventIds])disputed.add(await reference('evidence',[scope.organizationId,scope.customerTenantId,tenant.microsoftTenantId,auth.input.source,id]))
        }else{
          const source=auth.sources.find(s=>s.reasonCode!=='WAITING_FOR_COLLECTION')??auth.sources[0]!
          assessment={...assessment,rules:assessment.rules.map(rule=>rule.ruleId==='HV-ID-MBX-001.v1'?rule:{...rule,status:source.status,reasonCode:source.reasonCode,explanation:source.explanation})}
        }
      }catch{
        const failed=emptyAssessment('EVALUATION_FAILED')
        assessment={...assessment,sources:[failed.sources[0]!,failed.sources[1]!,assessment.sources[2]!],rules:[failed.rules[0]!,failed.rules[1]!,assessment.rules[2]!],subjects:[]}
        authenticationProof=undefined
      }
      let mailbox:IdentityRiskSourceBatch|null=null
      try{mailbox=await this.mailbox.load(scope,evaluationAt,Math.min(executionDeadlineAt,Date.now()+7000))}catch{/* This source does not veto auth evidence. */}
      if(mailbox?.pseudonymKeyVersionId&&mailbox.pseudonymKeyVersionId!==session.keyVersion.id)throw new Error('IDENTITY_RISK_KEY_CHANGED')
      const mbx=await projectMailboxAssessment(mailbox,evaluationAt,reference)
      assessment={...assessment,sources:[assessment.sources[0]!,assessment.sources[1]!,mbx.source],rules:[assessment.rules[0]!,assessment.rules[1]!,mbx.rule],subjects:[...assessment.subjects,...mbx.subjects]}
      const history=await readAssessmentHistory(scope,session.keyVersion.id,assessment,evaluationAt,executionDeadlineAt)
      assessment=reconcileAssessmentHistory(assessment,history.subjects,evaluationAt,disputed)
      if(history.capped)assessment={...assessment,rules:assessment.rules.map(rule=>['READY','PARTIAL'].includes(rule.status)?{...rule,status:'PARTIAL',reasonCode:'CAPACITY_LIMIT',explanation:assessmentReason('CAPACITY_LIMIT'),countsCapped:true,assessedIdentities:null,matchedIdentities:null}:rule)}
      const safe=projectStoredRiskAssessment(assessment,evaluationAt)
      if(!safe)throw new Error('IDENTITY_RISK_ASSESSMENT_INVALID')
      const observed=safe.sources.map(source=>source.latestEventAt??source.lastSuccessfulCollectionAt).filter((value):value is string=>value!==null).sort()
      const watermark=await session.reference('observation',['risk-assessment/v1',createHash('sha256').update(JSON.stringify(safe)).digest('hex')])
      if(!this.provider.allowsScope({...scope,environment}))throw new Error('IDENTITY_RISK_SCOPE_UNAVAILABLE')
      return {context:{...scope,evaluationAt,engineVersion:IDENTITY_RISK_ENGINE_VERSION,catalogVersion:IDENTITY_RISK_CATALOG_VERSION},
        sourceEnvelopes:[],orderedSourceWatermarks:[watermark],earliestSourceExpiry:null,capability:assessmentMeta(safe,evaluationAt.toISOString(),evaluationAt).capability,
        assessment:safe,authenticationProof,mailboxAttestations:mailbox?.mailboxAttestations,pseudonymKeyVersionId:session.keyVersion.id,
        ...(observed[0]?{sourceObservedAt:new Date(observed[0])}:{})}
    }finally{session.close?.()}
  }
}
