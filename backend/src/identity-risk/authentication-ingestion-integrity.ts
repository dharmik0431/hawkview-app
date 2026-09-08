import { createHash } from 'node:crypto'
import type { Prisma } from '../generated/prisma/client.js'
import type { PrismaService } from '../prisma/prisma.service.js'
import { enforceRiskUtcTransaction } from './risk-utc-session.js'

const MARKER = 'hawkviewAuthenticationIntegrity'
const MAX_ROW_BYTES = 16_384
const MAX_BATCH_BYTES = 2 * 1024 * 1024
const plain = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value) &&
  [Object.prototype, null].includes(Object.getPrototypeOf(value)) && Reflect.ownKeys(value).every(key => typeof key === 'string' &&
    !['__proto__','prototype','constructor'].includes(key) && 'value' in Object.getOwnPropertyDescriptor(value,key)!)
function canonical(value: unknown, depth = 0): unknown {
  if (depth > 6) throw new Error('IDENTITY_AUTH_RECORD_INVALID')
  if (value === undefined) return null
  if (value === null || typeof value === 'boolean' || typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value))) return value
  if (Array.isArray(value) && value.length <= 100) return value.map(item => canonical(item, depth + 1))
  if (!plain(value) || Object.keys(value).length > 100) throw new Error('IDENTITY_AUTH_RECORD_INVALID')
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key], depth + 1)]))
}
/** Only facts consumed by authentication normalization. Geographic enrichment,
 * ingestion clocks and optional display text do not turn a replay into conflict.
 * This transient digest is never persisted or returned to a customer. */
export function authenticationFactFingerprint(raw: unknown): string | null {
  try {
    if (!plain(raw)) return null
    const audit = raw.hawkviewSource === 'MICROSOFT_365_MANAGEMENT_ACTIVITY'
    if (!audit && raw.hawkviewSource !== undefined) return null
    const record = audit ? raw.managementActivityRecord : raw
    if (!plain(record)) return null
    const keys = audit ? ['Id','CreationTime','OrganizationId','UserId','UserType','ApplicationId','RecordType','Operation','ErrorCode','LogonError','LoginStatus','ResultStatus','ActorIpAddress']
      : ['id','createdDateTime','userId','appId','isInteractive','signInEventTypes','ipAddress']
    const facts: Record<string, unknown> = Object.fromEntries(keys.map(key => [key, record[key]]))
    if (audit) facts.ExtendedProperties = record.ExtendedProperties
    else facts.status = plain(record.status) ? { errorCode: record.status.errorCode, failureReason: record.status.failureReason } : record.status
    const text = JSON.stringify(canonical({ source: audit ? 'M365_AUDIT_STS' : 'GRAPH_SIGN_INS', facts }))
    if (Buffer.byteLength(text) > MAX_ROW_BYTES) return null
    return createHash('sha256').update(text).digest('hex')
  } catch { return null }
}

/** Bounded atomic chunks share a scope lock with the evaluation commit guard.
 * Conflicts are sticky: preserve the first stored row and mark only its raw
 * integrity field; never replace its Microsoft risk/identity/retention columns.
 * A failed later chunk cannot publish a complete collection-window assertion. */
export async function persistAuthenticationRecords(prisma: PrismaService, scope: {organizationId:string;customerTenantId:string},
  records: readonly Prisma.SignInLogCreateManyInput[], deadlineAt = Date.now() + 30_000) {
  if (records.length > 100_000) throw new Error('IDENTITY_AUTH_CAPACITY')
  let inserted = 0, hasConflicts = false
  for (let offset = 0; offset < records.length; offset += 500) {
    if (deadlineAt - Date.now() < 100) throw new Error('IDENTITY_AUTH_DEADLINE')
    const chunk = records.slice(offset, offset + 500)
    let bytes = 0
    const unique = new Map<string,{row:Prisma.SignInLogCreateManyInput;fingerprint:string|null;conflict:boolean}>()
    for (const row of chunk) {
      if (row.organizationId !== scope.organizationId || row.customerTenantId !== scope.customerTenantId ||
        typeof row.microsoftSignInId !== 'string' || !row.microsoftSignInId || row.microsoftSignInId.length > 200 || !plain(row.raw)) throw new Error('IDENTITY_AUTH_RECORD_INVALID')
      const size = Buffer.byteLength(JSON.stringify(canonical(row.raw)))
      bytes += size
      if (size > MAX_ROW_BYTES || bytes > MAX_BATCH_BYTES) throw new Error('IDENTITY_AUTH_CAPACITY')
      const fingerprint = authenticationFactFingerprint(row.raw)
      const old = unique.get(row.microsoftSignInId)
      const conflict = fingerprint === null || (row.raw as Record<string,unknown>)[MARKER] !== undefined
      if (old) old.conflict ||= conflict || old.fingerprint !== fingerprint
      else unique.set(row.microsoftSignInId,{row,fingerprint,conflict})
    }
    await prisma.$transaction(async transaction => {
      await enforceRiskUtcTransaction(transaction)
      await transaction.$executeRawUnsafe("SELECT set_config('statement_timeout',$1,true)",String(Math.max(1,Math.min(4500,deadlineAt-Date.now()))))
      await transaction.$executeRawUnsafe('SELECT pg_advisory_xact_lock(hashtext($1))',`hawkview:auth-ingestion:${scope.organizationId}:${scope.customerTenantId}`)
      const ids = [...unique.keys()]
      const existing = await transaction.$queryRawUnsafe<Array<{id:string|null;raw:unknown;bounded:boolean}>>(`WITH rows AS MATERIALIZED (
        SELECT microsoft_sign_in_id AS id,raw FROM sign_in_logs WHERE organization_id=$1::uuid AND customer_tenant_id=$2::uuid
          AND microsoft_sign_in_id=ANY($3::text[]) FOR UPDATE
      ), limits AS (SELECT coalesce(sum(octet_length(raw::text)),0)<=2097152 AND coalesce(max(octet_length(raw::text)),0)<=16384 AS bounded FROM rows)
      SELECT CASE WHEN bounded THEN rows.id ELSE NULL END AS id,CASE WHEN bounded THEN rows.raw ELSE NULL END AS raw,bounded
        FROM limits LEFT JOIN rows ON bounded`,scope.organizationId,scope.customerTenantId,ids)
      if (existing.some(row=>!row.bounded)) throw new Error('IDENTITY_AUTH_CAPACITY')
      const seen = new Set<string>()
      for (const old of existing) {
        if (old.id === null) continue
        const pending = unique.get(old.id)
        if (!pending || !plain(old.raw)) throw new Error('IDENTITY_AUTH_RECORD_INVALID')
        seen.add(old.id)
        const conflict = pending.conflict || old.raw[MARKER] !== undefined || authenticationFactFingerprint(old.raw) !== pending.fingerprint
        if (conflict) {
          hasConflicts = true
          await transaction.$executeRawUnsafe(`UPDATE sign_in_logs SET raw=jsonb_set(raw,'{hawkviewAuthenticationIntegrity}','"CONFLICT"'::jsonb,true)
            WHERE organization_id=$1::uuid AND customer_tenant_id=$2::uuid AND microsoft_sign_in_id=$3`,scope.organizationId,scope.customerTenantId,old.id)
        }
      }
      const data = [...unique.values()].filter(value=>!seen.has(value.row.microsoftSignInId)).map(value=>{
        hasConflicts ||= value.conflict
        return value.conflict ? {...value.row,raw:{...value.row.raw as Prisma.InputJsonObject,[MARKER]:'CONFLICT'}} : value.row
      })
      if (data.length) {
        const result = await transaction.signInLog.createMany({data,skipDuplicates:false})
        inserted += result.count
      }
    },{maxWait:1000,timeout:Math.max(100,Math.min(6000,deadlineAt-Date.now()))})
  }
  return {inserted,hasConflicts}
}
