import assert from 'node:assert/strict'
import test from 'node:test'
import type { TenantBundle, TenantSyncStatus, SyncOutcomeProjection } from '../types/tenant-data.ts'
import { projectSyncOutcome } from '../backend/src/tenants/sync-outcome-projection.ts'
import { tenantActionableHealthProjection } from './attention/computeTenantAttention.ts'
import { deriveTenantWorkspaceDisplay } from './tenant-workspace-state.ts'
import { tenantFindingProvenance, accessProvenance } from '../backend/src/tenants/attention-provenance.ts'
function bundle(extra: any = {}): TenantBundle { return {tenant:{id:'tenant-1'},users:[],signIns:[],exchange:{},sharepoint:{},teams:{},...extra} as TenantBundle }
function sync(kind: SyncOutcomeProjection['recordedOutcome']['kind'], status = 'running',
  relation?: SyncOutcomeProjection['recordedOutcome']['relation']): TenantSyncStatus {
  const resource = keyFor(kind)
  const resourceType = resource === 'signIns' ? 'SIGN_INS' : resource === 'm365Audit' ? 'M365_AUDIT' : 'USERS'
  const raw = kind === 'AWAITING_EXECUTION' ? 'queued' : kind === 'NOT_STARTED_OR_IDLE' ? 'idle' : status
  const success = '2026-09-29T12:00:00.000Z'
  const attempt = relation === 'PREDATES_ATTEMPT' ? '2026-09-29T12:01:00.000Z' : '2026-09-29T11:59:00.000Z'
  const code = kind === 'LIMITED_COLLECTION_RECORDED' ? 'sign-ins-non-premium-fallback-active'
    : kind === 'INITIALIZATION_WAIT_RECORDED' ? 'sign-ins-audit-subscription-initializing'
      : kind === 'DEFERRED_WORK_RECORDED' ? 'm365-audit-backlog' : null
  return {
    status: raw, lastSuccessfulAt: success, lastError: null,
    outcomeProjection: projectSyncOutcome(resourceType, {
      status: raw.toUpperCase(), lastSuccessfulAt: new Date(success), lastAttemptAt: new Date(attempt), lastErrorCode: code,
    }, new Date('2026-09-29T13:00:00.000Z')),
  }
}
function keyFor(kind: SyncOutcomeProjection['recordedOutcome']['kind']) {
  return kind === 'LIMITED_COLLECTION_RECORDED' || kind === 'INITIALIZATION_WAIT_RECORDED' ? 'signIns'
    : kind === 'DEFERRED_WORK_RECORDED' ? 'm365Audit' : 'users'
}

function current(syncEntries: TenantBundle['sync']): TenantBundle {
  return bundle({ tenant: { id: 'tenant-1', status: 'connected' }, sync: syncEntries })
}
const verifiedHealth = tenantActionableHealthProjection({ data: { status: 'COMPLETE' }, attention: [] })

test('queued, initialization, deferred and unknown records describe distinct outcomes without attesting execution', () => {
  for (const [kind, label] of [
    ['AWAITING_EXECUTION', 'Collection queued'],
    ['INITIALIZATION_WAIT_RECORDED', 'Initialization wait recorded'],
    ['DEFERRED_WORK_RECORDED', 'Deferred work recorded'],
    ['UNKNOWN', 'Collection outcome unknown'],
  ] as const) {
    const display = deriveTenantWorkspaceDisplay(current({ [keyFor(kind)]: sync(kind) }), false, null, verifiedHealth)
    assert.equal(display.state, 'unverified', kind)
    assert.ok(display.syncObservations[0].detail.includes(label))
    assert.match(display.syncObservations[0].detail, /activity is not verified/)
  }
})

test('legacy and malformed projections do not claim healthy or active execution', () => {
  for (const projection of [undefined, null, {}, { version: 2 }, { version: 1 },
    { ...sync('SUCCEEDED').outcomeProjection, recordedOutcome: null },
    { ...sync('SUCCEEDED').outcomeProjection, recordedOutcome: { kind: 'FUTURE_VALUE' } },
  ]) {
    for (const status of ['running', 'pending', 'queued', 'syncing', 'success']) {
      const entry = { ...sync('SUCCEEDED', status), outcomeProjection: projection } as TenantSyncStatus
      const display = deriveTenantWorkspaceDisplay(current({ users: entry }), false, null, verifiedHealth)
      assert.equal(display.state, 'unverified', `${status} / ${JSON.stringify(projection)}`)
      assert.doesNotMatch(display.syncObservations[0].detail, /collecting|crashed|orphaned/i)
    }
  }
})

test('contradictory status, identity, basis, reason and relation use conservative descriptions', () => {
  const cases: TenantSyncStatus[] = [
    { ...sync('SUCCEEDED', 'succeeded'), status: 'failed' },
    { ...sync('SUCCEEDED', 'succeeded'), status: 'running' },
    { ...sync('FAILED', 'failed'), outcomeProjection: { ...sync('SUCCEEDED', 'succeeded').outcomeProjection!,
      recordedOutcome: { kind: 'SUCCEEDED', basis: 'LEGACY_LABEL', relation: 'LATEST_RECORDED' } } },
  ]
  for (const key of ['basis', 'relation', 'kind'] as const) {
    const entry = sync('SUCCEEDED', 'succeeded')
    const replacements = { basis: 'UNCLASSIFIED', relation: 'PREDATES_ATTEMPT', kind: 'AWAITING_EXECUTION' } as const
    ;(entry.outcomeProjection!.recordedOutcome as Record<string, string>)[key] = replacements[key]
    cases.push(entry)
  }
  for (const value of cases) {
    const display = deriveTenantWorkspaceDisplay(current({ users: value }), false, null, verifiedHealth)
    assert.notEqual(display.state, 'healthy')
    assert.doesNotMatch(display.syncObservations[0].detail, /Successful collection recorded|Collection queued/)
  }
  for (const mutate of [
    (entry: TenantSyncStatus) => { entry.outcomeProjection!.recordedOutcome.relation = 'LATEST_RECORDED' },
    (entry: TenantSyncStatus) => { entry.outcomeProjection!.recordedOutcome.basis = 'STORED_STATUS' },
    (entry: TenantSyncStatus) => { entry.outcomeProjection!.reasonCode = 'unrecognized-partial' },
    (entry: TenantSyncStatus) => { entry.outcomeProjection!.resourceType = 'USERS' },
  ]) {
    const entry = sync('LIMITED_COLLECTION_RECORDED')
    mutate(entry)
    const display = deriveTenantWorkspaceDisplay(current({ signIns: entry }), false, null, verifiedHealth)
    assert.equal(display.state, 'unverified')
    assert.doesNotMatch(display.syncObservations[0].detail, /Limited collection recorded|Successful collection recorded/)
  }
})

test('accepts actual producer combinations including all reason codes and clock relationships', () => {
  const now = new Date('2026-09-29T13:00:00.000Z')
  const success = new Date('2026-09-29T12:00:00.000Z')
  const limitedCodes = [
    'sign-ins-premium-graph-fallback-active', 'sign-ins-non-premium-fallback-active',
    'sign-ins-entitlement-unverified-fallback-active',
    'sign-ins-premium-graph-fallback-active-geolocation-partial',
    'sign-ins-non-premium-fallback-active-geolocation-partial',
    'sign-ins-entitlement-unverified-fallback-active-geolocation-partial',
  ]
  for (const [resourceType, resource, code, label] of [
    ...limitedCodes.map(code => ['SIGN_INS', 'signIns', code, 'Limited collection recorded']),
    ['SIGN_INS', 'signIns', 'sign-ins-audit-subscription-initializing', 'Initialization wait recorded'],
    ['M365_AUDIT', 'm365Audit', 'm365-audit-backlog', 'Deferred work recorded'],
    ['M365_AUDIT', 'm365Audit', 'm365-audit-budget-exhausted', 'Deferred work recorded'],
  ]) {
    for (const attempt of [null, new Date('2026-09-29T11:59:00.000Z'), success, new Date('2026-09-29T12:01:00.000Z')]) {
      const projected = projectSyncOutcome(resourceType, { status: 'RUNNING', lastSuccessfulAt: success, lastAttemptAt: attempt, lastErrorCode: code }, now)
      const display = deriveTenantWorkspaceDisplay(current({ [resource]: { status: 'running', lastSuccessfulAt: success.toISOString(), lastError: null, outcomeProjection: projected } }), false, null, verifiedHealth)
      assert.ok(display.syncObservations[0].detail.includes(label), `${code} / ${attempt}`)
      assert.notEqual(display.state, 'healthy')
    }
  }
  for (const [status, label] of [['SUCCEEDED', 'Successful collection recorded'], ['FAILED', 'Collection failure recorded'], ['IDLE', 'collector idle'], ['PENDING', 'Collection queued'], ['QUEUED', 'Collection queued'], ['RUNNING', 'Collection outcome unknown']]) {
    const value = { status: status.toLowerCase(), lastSuccessfulAt: success.toISOString(), lastError: null,
      outcomeProjection: projectSyncOutcome('USERS', { status }, now) }
    const display = deriveTenantWorkspaceDisplay(current({ users: value }), false, null, verifiedHealth)
    assert.ok(display.syncObservations[0].detail.includes(label), status)
  }
})

test('complete otherwise-valid projections reject unsupported version and execution independently', () => {
  for (const changedField of [{ version: 2 }, { execution: 'RUNNING' }]) {
    const value = sync('SUCCEEDED', 'succeeded')
    value.outcomeProjection = { ...value.outcomeProjection!, ...changedField } as SyncOutcomeProjection
    const display = deriveTenantWorkspaceDisplay(current({ users: value }), false, null, verifiedHealth)
    assert.equal(display.state, 'unverified', JSON.stringify(changedField))
    assert.match(display.syncObservations[0].detail, /Collection outcome not verified/)
    assert.doesNotMatch(display.syncObservations[0].detail, /Successful collection recorded|collecting|in progress/i)
    assert.equal(display.lastSuccessfulSync, null)
  }
})

test('customer workspace preserves diagnostics without converting raw collector errors to customer actions', () => {
 for (const error of ['403 missing permission','token expired','attack detected','internal failure']) {
  const d=deriveTenantWorkspaceDisplay(current({users:{status:'failed',lastError:error,lastSuccessfulAt:null}}),true)
  assert.equal(d.issueCount,0);assert.equal(d.state,'unverified');assert.equal(d.syncRequestPending,true)
  assert.equal(d.syncObservations[0].diagnostic,error);assert.equal(d.lastSuccessfulSync,null)
 }
})
test('typed tenant findings and explicit access stay distinct while unknown evidence remains incomplete', () => {
 const health=tenantActionableHealthProjection({attention:[
 {key:'sync-fake',label:'Risk evidence',why:'Positive Microsoft evidence.',severity:'high',provenance:tenantFindingProvenance('MICROSOFT_ACTIVE_RISK')},
 {key:'risky-fake',label:'Consent',why:'Required consent missing.',severity:'high',provenance:accessProvenance('AUTHORIZATION_REQUIRED',true)},
 {key:'unknown',label:'Unclassified',why:'Historical record.',severity:'critical'}]})
 const d=deriveTenantWorkspaceDisplay(bundle(),false,null,health)
 assert.equal(d.issueCount,2);assert.equal(d.issues[0].targetModule,'risky-users');assert.equal(d.issues[1].targetModule,'settings')
 assert.equal(d.customer?.incomplete,true);assert.equal(d.stateLabel,'1 reported finding');assert.equal(d.customer?.findings.length,1);assert.equal(d.customer?.accessActions.length,1)
})
test('supplied empty coverage is described as no reported findings, never an exhaustive healthy claim', () => {
 const health=tenantActionableHealthProjection({data:{status:'COMPLETE'},attention:[]})
 const d=deriveTenantWorkspaceDisplay(bundle(),false,null,health)
 assert.equal(d.stateLabel,'No findings reported');assert.equal(d.attentionVerified,true)
})
test('selected source cannot create permission actions from a failed nonselected Graph attempt', () => {
 const d=deriveTenantWorkspaceDisplay(current({signIns:{status:'failed',lastError:'Nonselected Graph 403',lastSuccessfulAt:null}}),false,{availability:'CURRENT_LIMITED',coverage:'LIMITED',selectedSource:'OFFICE_365_ACTIVITY_FEED',observedAt:null,reasonCode:null,reason:null})
 assert.equal(d.issues.length,0);assert.equal(d.customer?.incomplete,true)
})

test('silent complete health cannot hide an independent recorded collection failure', () => {
 const health=tenantActionableHealthProjection({data:{status:'COMPLETE'},attention:[]})
 const d=deriveTenantWorkspaceDisplay(current({users:{status:'failed',lastError:'Retained diagnostic',lastSuccessfulAt:null}}),false,null,health)
 assert.equal(d.state,'unverified');assert.equal(d.customer?.incomplete,true);assert.equal(d.issueCount,0)
 assert.equal(d.syncObservations[0].diagnostic,'Retained diagnostic')
})


test('verified successful records preserve complete coverage without asserting current execution', () => {
 const d=deriveTenantWorkspaceDisplay(current({users:sync('SUCCEEDED','succeeded')}),false,null,verifiedHealth)
 assert.equal(verifiedHealth.customer?.incomplete,false)
 assert.equal(d.customer?.incomplete,false);assert.equal(d.attentionVerified,true)
 assert.equal(d.stateLabel,'No findings reported');assert.equal(d.issueCount,0)
 assert.match(d.syncObservations[0].detail,/Successful collection recorded/)
 assert.match(d.syncObservations[0].detail,/activity is not verified/)
})


test('complete selected source excludes failed nonselected Graph while preserving known findings', () => {
 const health=tenantActionableHealthProjection({data:{status:'COMPLETE'},attention:[{key:'risk',label:'Known risk',why:'Positive evidence',severity:'high',provenance:tenantFindingProvenance('MICROSOFT_ACTIVE_RISK')}]})
 const selected={availability:'READY',coverage:'FULL',selectedSource:'OFFICE_365_ACTIVITY_FEED',observedAt:null,reasonCode:null,reason:null} as any
 const d=deriveTenantWorkspaceDisplay(current({signIns:{status:'failed',lastError:'Nonselected Graph 403',lastSuccessfulAt:null}}),false,selected,health)
 assert.equal(d.customer?.incomplete,false);assert.equal(d.attentionVerified,true)
 assert.equal(d.issueCount,1);assert.equal(d.issues[0].title,'Known risk')
 assert.equal(d.syncObservations[0].diagnostic,'Nonselected Graph 403')
 const limited=deriveTenantWorkspaceDisplay(current({users:sync('SUCCEEDED','succeeded')}),false,{...selected,availability:'CURRENT_LIMITED'},verifiedHealth)
 assert.equal(limited.customer?.incomplete,true);assert.equal(limited.issueCount,0)
})
