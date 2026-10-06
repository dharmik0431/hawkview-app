import assert from 'node:assert/strict'
import type { AuthorityDatabase, AuthorityTransaction, ManagedAuthority } from '../microsoft/managed-connector-authority.js'
import type { PimAttemptRecord, PimScopeRecord } from './pim-schedule-store.js'
import type { PimTenant } from './pim-schedule-contract.js'

export const testTenant: PimTenant = { organizationId: '11111111-1111-4111-8111-111111111111',
  customerTenantId: '22222222-2222-4222-8222-222222222222', microsoftTenantId: '33333333-3333-4333-8333-333333333333' }
export const alternateId = '99999999-9999-4999-8999-999999999999'
/** Transactional injected double for caller behavior/rollback assertions only.
 * Does NOT execute SQL or prove PostgreSQL constraints, lock modes, or concurrency. */
export class PimDatabaseDouble implements AuthorityDatabase {
  authority: ManagedAuthority | null = { configurationRevision: '44444444-4444-4444-8444-444444444444',
    clientId: '55555555-5555-4555-8555-555555555555', homeTenantId: testTenant.microsoftTenantId, credentialReference: 'injected-only' }
  tenant = { ...testTenant }
  incarnation = '66666666-6666-4666-8666-666666666666'
  connected = true
  active = true
  now = Date.parse('2026-10-06T08:00:00Z')
  inTransaction = false
  operations: string[] = []
  mutations = 0
  hook: ((operation: string, values: unknown[]) => void) | null = null
  scopes: Array<PimScopeRecord & { is_current: boolean; retired_at: Date | null }> = []
  attempts: PimAttemptRecord[] = []
  envelopes: Array<{ attempt_id: string; page_index: number; envelope: unknown; requested_token: string; byte_length: number }> = []
  rows: Array<Record<string, any>> = []
  wireFailures: Array<{ attempt_id: string; page_index: number; byte_length: number; failure_kind: string }> = []
  async $transaction<T>(work: (tx: AuthorityTransaction) => Promise<T>): Promise<T> {
    assert.equal(this.inTransaction, false, 'nested transaction unsupported in double')
    const saved = structuredClone({ scopes: this.scopes, attempts: this.attempts, envelopes: this.envelopes, rows: this.rows, wireFailures: this.wireFailures })
    this.inTransaction = true
    try {
      return await work({ $queryRawUnsafe: async <R>(sql: string, ...values: any[]) => this.query(sql, values) as R,
        $executeRawUnsafe: async (sql: string, ...values: any[]) => { this.mutations++; return this.execute(sql, values) } })
    } catch (error) { Object.assign(this, saved); throw error }
    finally { this.inTransaction = false }
  }
  private op(sql: string, values: unknown[]): string {
    const op = /\/\* pim:([a-z-]+) \*\//.exec(sql)?.[1]
      ?? (sql.includes('pg_advisory_xact_lock_shared') ? 'G-advisory' : sql.includes('FROM platform_microsoft_connectors') ? 'G-row' : '')
    assert.ok(op, 'unrecognized SQL in injected double')
    this.operations.push(op); this.hook?.(op, values)
    return op
  }
  private matching(r: { customer_tenant_id: string; organization_id: string; plane: string }, v: any[]) {
    return r.customer_tenant_id === v[0] && r.organization_id === v[1] && r.plane === v[2]
  }
  private query(sql: string, v: any[]): unknown {
    const op = this.op(sql, v)
    switch (op) {
      case 'G-advisory': return [{ locked: 1 }]
      case 'G-row': return this.authority ? [{ ...this.authority }] : []
      case 'tenant': return this.active && v[0] === this.tenant.customerTenantId && v[1] === this.tenant.organizationId && v[2] === this.tenant.microsoftTenantId ? [{ id: v[0] }] : []
      case 'connection': return this.connected && v[0] === this.tenant.customerTenantId && v[1] === this.tenant.organizationId ? [{ id: 'connection', incarnation: this.incarnation }] : []
      case 'scope': return structuredClone(this.scopes.filter(s => s.customer_tenant_id === v[0] && s.organization_id === v[1] && s.microsoft_tenant_id === v[2] && s.plane === v[3] && s.is_current))
      case 'scope-lookup': {
        // Mirrors the lookup statement's predicates exactly: inactive tenant or a mismatched
        // organization yields no row at all, which the caller reports as TENANT_MISMATCH.
        if (!this.active || v[0] !== this.tenant.customerTenantId || v[1] !== this.tenant.organizationId) return []
        const current = this.scopes.find(s => s.customer_tenant_id === v[0] && s.organization_id === v[1]
          && s.microsoft_tenant_id === this.tenant.microsoftTenantId && s.plane === v[2] && s.is_current)
        return structuredClone([{ observedAt: new Date(this.now), microsoftTenantId: this.tenant.microsoftTenantId,
          connections: this.connected ? [this.incarnation] : null, scope: current ?? null }])
      }
      case 'inflight': return this.attempts.filter(a => this.matching(a, v) && a.terminal_at === null).map(a => ({ id: a.id }))
      case 'begin': {
        this.mutations++
        const row: PimAttemptRecord = { id: v[0], organization_id: v[1], customer_tenant_id: v[2], microsoft_tenant_id: v[3], plane: v[4],
          configuration_revision: v[5], connection_incarnation: v[6], scope_id: v[7], scope_incarnation: v[8], scope_version: v[9],
          endpoint_descriptor: v[10], projection_identity: v[11], started_at: new Date(++this.now), expires_at: new Date(this.now + v[12]),
          committed_at: null, terminal_at: null, content_changed_at: null, outcome: null, failure_kind: null, content_digest: null,
          observed_row_count: null, traversal_outcome: 'IN_FLIGHT', is_current: false }
        assert.equal(this.attempts.some(a => a.customer_tenant_id === row.customer_tenant_id && a.plane === row.plane && !a.terminal_at), false)
        this.attempts.push(row); return structuredClone([row])
      }
      case 'attempt': return structuredClone(this.attempts.filter(a => a.id === v[0] && a.customer_tenant_id === v[1] && a.organization_id === v[2]))
      case 'deadline': return this.attempts.filter(a => a.id === v[0]).map(a => ({ live: this.now < a.expires_at.getTime() }))
      case 'previous': return structuredClone(this.attempts.filter(a => this.matching(a, v) && a.is_current))
      case 'commit': {
        this.mutations++
        const a = this.attempts.find(a => a.id === v[0] && !a.terminal_at && this.now < a.expires_at.getTime())
        if (!a) return []
        Object.assign(a, { outcome: 'COMMITTED', traversal_outcome: 'EXHAUSTED', committed_at: new Date(this.now), terminal_at: new Date(this.now),
          content_changed_at: v[3] ?? new Date(this.now), content_digest: v[1], observed_row_count: v[2], is_current: true })
        return structuredClone([a])
      }
      case 'read': {
        if (v[0] !== this.tenant.customerTenantId || v[1] !== this.tenant.organizationId) return []
        const attempts = this.attempts.filter(a => this.matching(a, v)).sort((a, b) => b.started_at.getTime() - a.started_at.getTime())
        const current = attempts.find(a => a.is_current) ?? null
        // SQL to_jsonb converts timestamps to strings. Simulate that boundary too.
        return JSON.parse(JSON.stringify([{ readAt: new Date(this.now), current, latest: attempts[0] ?? null,
          rows: this.rows.filter(r => r.attempt_id === current?.id).sort((a, b) => a.occurrence_ordinal - b.occurrence_ordinal) }]))
      }
      default: throw new Error('Unexpected query: ' + op)
    }
  }
  private execute(sql: string, v: any[]): number {
    const op = this.op(sql, v)
    switch (op) {
      case 'insert-scope':
        if (this.scopes.some(s => s.customer_tenant_id === v[2] && s.plane === v[4] && s.is_current)) return 0
        this.scopes.push({ id: v[0], organization_id: v[1], customer_tenant_id: v[2], microsoft_tenant_id: v[3], plane: v[4],
          scope_incarnation: v[5], scope_version: v[6], endpoint_descriptor: v[7], projection_identity: v[8], is_current: true, retired_at: null }); return 1
      case 'retire-expired': {
        const expired = this.attempts.filter(a => this.matching(a, v) && !a.terminal_at && a.expires_at.getTime() <= this.now)
        for (const a of expired) Object.assign(a, { outcome: 'ABANDONED', terminal_at: new Date(this.now), traversal_outcome: 'TRUNCATED_DEADLINE', failure_kind: 'DEADLINE' })
        return expired.length
      }
      case 'rotate': {
        const s = this.scopes.find(s => s.id === v[0] && s.is_current)
        if (!s) return 0
        s.is_current = false; s.retired_at = new Date(this.now); return 1
      }
      case 'envelope': this.envelopes.push({ attempt_id: v[1], page_index: v[2], requested_token: v[3], envelope: JSON.parse(v[4]), byte_length: v[5] }); return 1
      case 'observation': this.rows.push({ attempt_id: v[1], plane: v[2], occurrence_ordinal: v[3], instance_id: v[4], raw: JSON.parse(v[5]),
        observations: JSON.parse(v[6]), diagnostics: JSON.parse(v[7]), provider_start_date_time: v[8], provider_end_date_time: v[9] }); return 1
      case 'clear-current': {
        const current = this.attempts.filter(a => this.matching(a, v) && a.is_current)
        for (const a of current) a.is_current = false
        return current.length
      }
      case 'wire-failure': this.wireFailures.push({ attempt_id: v[1], page_index: v[2], byte_length: v[3], failure_kind: v[4] }); return 1
      case 'fail': {
        const a = this.attempts.find(a => a.id === v[0] && !a.terminal_at)
        if (!a) return 0
        Object.assign(a, { outcome: 'FAILED', terminal_at: new Date(this.now), failure_kind: v[1], traversal_outcome: v[2] }); return 1
      }
      default: throw new Error('Unexpected mutation: ' + op)
    }
  }
}
