import assert from 'node:assert/strict'
import { setImmediate } from 'node:timers/promises'
import test from 'node:test'
import { BadGatewayException } from '@nestjs/common'
import { ChangeEvidenceService } from '../changes/change-evidence.service.js'
import {
  MicrosoftGraphCollectionError,
  NON_PREMIUM_AUTH_REGISTRATION_ERROR_CODE,
  TenantSyncService,
} from './tenant-sync.service.js'

// Control-flow witnesses with synthetic storage boundaries, not PostgreSQL
// rollback/trigger/lock proof. Keep the entry methods, runSnapshotSync,
// saveEntraSnapshot, saveSnapshot and difference builder real.
type TenantRef = { id: string; organizationId: string }
type Resource = 'AUTH_REGISTRATIONS' | 'RISKY_USERS'
type Entry = 'premium MFA' | 'fallback MFA' | 'risky users'
type Where = { customerTenantId_resourceType: { customerTenantId: string; resourceType: Resource } }
type StatePatch = {
  status: string
  lastSuccessfulAt?: Date
  consecutiveFailures?: number | { increment: number }
}
type InternalSync = {
  syncAuthenticationRegistrations: (tenant: TenantRef, token: string) => Promise<unknown>
  syncEntraCollection: (tenant: TenantRef, token: string, resource: Resource, url: string) => Promise<unknown>
  collectEntraCollection: (token: string, resource: Resource) => Promise<unknown[]>
  collectPerUserAuthenticationMethods: (token: string) => Promise<unknown[]>
  enrichAuthenticationRegistrationsWithPerUserMfaState: (token: string, rows: unknown[]) => Promise<unknown[]>
  enrichAuthenticationRegistrationsWithConditionalAccessContext: (token: string, rows: unknown[]) => Promise<unknown[]>
}

const tenant = { id: 'snapshot-outcome-tenant', organizationId: 'snapshot-outcome-org' }
const lastSuccessfulAt = new Date('2020-01-01T00:00:00.000Z')
const entries: Entry[] = ['premium MFA', 'fallback MFA', 'risky users']

function deferred() {
  let resolve!: () => void
  let reject!: (error: Error) => void
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

function fixture(entry: Entry, options: {
  upsertError?: Error
  failedStateError?: Error
  deferCommit?: boolean
} = {}) {
  const resource: Resource = entry === 'risky users' ? 'RISKY_USERS' : 'AUTH_REGISTRATIONS'
  const rows = entry === 'risky users'
    ? [{ id: 'synthetic-user', riskLevel: 'high' }]
    : [{ id: 'synthetic-user', isMfaRegistered: true }]
  const where: Where = { customerTenantId_resourceType: { customerTenantId: tenant.id, resourceType: resource } }
  const events: string[] = []
  const updates: StatePatch[] = []
  const resolvedIncidents: unknown[][] = []
  const publishedIncidents: Record<string, unknown>[] = []
  let state = { status: 'FAILED', lastSuccessfulAt, consecutiveFailures: 2 }
  const commitEntered = deferred()
  const commitCompletion = deferred()
  let fallbackCalls = 0
  let snapshotAttempts = 0
  let transactionCalls = 0
  const transaction = {
    $executeRawUnsafe: async (_sql: string, key: string) => {
      assert.equal(key, `hawkview:snapshot:${tenant.id}:${resource}`)
      events.push('snapshot lock requested')
      return 1
    },
    tenantEntraSnapshot: {
      findUnique: async (args: { where: Where }) => {
        assert.deepEqual(args.where, where)
        events.push('baseline read')
        return { organizationId: tenant.organizationId, payload: [], observedAt: lastSuccessfulAt }
      },
      upsert: async (args: { where: Where; create: Record<string, unknown>; update: Record<string, unknown> }) => {
        assert.deepEqual(args.where, where)
        assert.equal(args.create.organizationId, tenant.organizationId)
        assert.equal(args.create.customerTenantId, tenant.id)
        assert.equal(args.create.resourceType, resource)
        assert.deepEqual(args.create.payload, rows)
        assert.deepEqual(args.update.payload, rows)
        snapshotAttempts += 1
        events.push('snapshot upsert')
        if (options.upsertError) throw options.upsertError
        return {}
      },
    },
    changeEvidenceEvent: { createMany: async () => ({ count: 0 }) },
  }
  const prisma = {
    syncState: {
      upsert: async (args: { where: Where; update: StatePatch }) => {
        assert.deepEqual(args.where, where)
        assert.equal(args.update.status, 'RUNNING')
        assert.equal(Object.hasOwn(args.update, 'lastSuccessfulAt'), false)
        events.push('RUNNING')
        state = { ...state, status: 'RUNNING' }
        return { ...state }
      },
      update: async (args: { where: Where; data: StatePatch }) => {
        assert.deepEqual(args.where, where)
        updates.push(args.data)
        events.push(args.data.status)
        if (args.data.status === 'FAILED' && options.failedStateError) throw options.failedStateError
        const failures = args.data.consecutiveFailures
        state = {
          ...state,
          status: args.data.status,
          lastSuccessfulAt: args.data.lastSuccessfulAt ?? state.lastSuccessfulAt,
          consecutiveFailures: typeof failures === 'number' ? failures
            : state.consecutiveFailures + (failures?.increment ?? 0),
        }
        return { ...state }
      },
    },
    $transaction: async (operation: (tx: typeof transaction) => Promise<void>) => {
      transactionCalls += 1
      events.push('snapshot transaction started')
      await operation(transaction)
      events.push('snapshot callback completed')
      if (options.deferCommit) {
        commitEntered.resolve()
        // Callback completion is deliberately distinct from transaction completion.
        try { await commitCompletion.promise } catch (error) {
          events.push('snapshot commit rejected')
          throw error
        }
      }
      events.push('snapshot commit resolved')
    },
  }
  const notifications = {
    resolveIncident: async (...args: unknown[]) => {
      events.push('incident resolved')
      resolvedIncidents.push(args)
    },
    publishIncident: async (args: Record<string, unknown>) => {
      events.push('failure incident published')
      publishedIncidents.push(args)
    },
  }
  const service = new TenantSyncService(
    prisma as never, {} as never, {} as never, notifications as never,
    new ChangeEvidenceService(prisma as never), {} as never,
  )
  const subject = service as unknown as InternalSync
  subject.collectEntraCollection = async (_token, requestedResource) => {
    assert.equal(requestedResource, resource)
    events.push('collection requested')
    if (entry === 'fallback MFA') {
      throw new MicrosoftGraphCollectionError('Synthetic non-premium report refusal.', 403,
        NON_PREMIUM_AUTH_REGISTRATION_ERROR_CODE)
    }
    return rows
  }
  subject.collectPerUserAuthenticationMethods = async () => {
    fallbackCalls += 1
    assert.equal(entry, 'fallback MFA', 'a storage failure must not select the Graph fallback')
    return rows
  }
  subject.enrichAuthenticationRegistrationsWithPerUserMfaState = async (_token, result) => result
  subject.enrichAuthenticationRegistrationsWithConditionalAccessContext = async (_token, result) => result
  return {
    resource, events, updates, resolvedIncidents, publishedIncidents,
    commitEntered, commitCompletion,
    run: () => entry === 'risky users'
      ? subject.syncEntraCollection(tenant, 'synthetic-token', resource, 'https://graph.invalid/synthetic')
      : subject.syncAuthenticationRegistrations(tenant, 'synthetic-token'),
    state: () => state,
    assertSaveReached: () => {
      assert.equal(transactionCalls, 1)
      assert.equal(snapshotAttempts, 1)
      assert.equal(fallbackCalls, entry === 'fallback MFA' ? 1 : 0)
      assert.ok(events.indexOf('RUNNING') < events.indexOf('snapshot upsert'))
    },
  }
}

function assertFailedSave(subject: ReturnType<typeof fixture>, recordingFailed = false) {
  subject.assertSaveReached()
  assert.equal(subject.events.includes('snapshot commit resolved'), false)
  assert.deepEqual(subject.updates.map((data) => data.status), ['FAILED'])
  assert.equal(Object.hasOwn(subject.updates[0], 'lastSuccessfulAt'), false)
  assert.deepEqual(subject.updates[0].consecutiveFailures, { increment: 1 })
  assert.equal(subject.state().lastSuccessfulAt, lastSuccessfulAt)
  assert.deepEqual(subject.resolvedIncidents, [])
  if (recordingFailed) {
    assert.equal(subject.state().status, 'RUNNING')
    assert.deepEqual(subject.publishedIncidents, [])
  } else {
    assert.equal(subject.state().status, 'FAILED')
    assert.equal(subject.publishedIncidents.length, 1)
    assert.equal(subject.publishedIncidents[0].eventType, 'tenant.sync_failed')
    assert.equal(subject.publishedIncidents[0].customerTenantId, tenant.id)
    assert.equal(subject.publishedIncidents[0].organizationId, tenant.organizationId)
  }
}

for (const entry of entries) {
  for (const [label, code] of [
    ['authority revision overflow', '22003'],
    ['authority privilege denial', '42501'],
    ['hidden authority RLS refusal', '42501'],
  ]) {
    for (const recordingFailed of [false, true]) {
      test(`${entry}: ${label} cannot report success${recordingFailed ? ' even when FAILED recording rejects' : ''}`, async () => {
        // Synthetic Prisma-shaped errors exercise propagation, not actual server diagnostics.
        const upsertError = Object.assign(new Error(`Synthetic ${label}`), { code: 'P2010', meta: { code } })
        const failedStateError = recordingFailed ? new Error('Synthetic terminal state rejection') : undefined
        const subject = fixture(entry, { upsertError, failedStateError })
        await assert.rejects(subject.run(), (error: unknown) => failedStateError
          ? error === failedStateError : error instanceof BadGatewayException)
        assertFailedSave(subject, recordingFailed)
        assert.equal(subject.events.includes('snapshot callback completed'), false)
      })
    }
  }

  for (const completion of ['resolve', 'reject'] as const) {
    test(`${entry}: pending snapshot commit suppresses success, then ${completion}s`, { timeout: 5_000 }, async () => {
      const subject = fixture(entry, { deferCommit: true })
      let settled = false
      const outcome = subject.run().then(
        () => { settled = true; return { ok: true as const } },
        (error: unknown) => { settled = true; return { ok: false as const, error } },
      )
      try {
        await subject.commitEntered.promise
        await setImmediate()
        subject.assertSaveReached()
        assert.equal(subject.events.includes('snapshot callback completed'), true)
        assert.equal(settled, false)
        assert.equal(subject.updates.length, 0)
        assert.equal(subject.resolvedIncidents.length, 0)
        assert.equal(subject.publishedIncidents.length, 0)
        assert.equal(subject.state().lastSuccessfulAt, lastSuccessfulAt)
        if (completion === 'reject') subject.commitCompletion.reject(new Error('Synthetic commit failure'))
        else subject.commitCompletion.resolve()
        const result = await outcome
        if (completion === 'reject') {
          assert.equal(result.ok, false)
          assert.ok(!result.ok && result.error instanceof BadGatewayException)
          assertFailedSave(subject)
          assert.ok(subject.events.indexOf('snapshot commit rejected') < subject.events.indexOf('FAILED'))
        } else {
          assert.equal(result.ok, true)
          assert.deepEqual(subject.updates.map((data) => data.status), ['SUCCEEDED'])
          assert.equal(subject.state().status, 'SUCCEEDED')
          assert.ok(subject.state().lastSuccessfulAt > lastSuccessfulAt)
          assert.equal(subject.state().consecutiveFailures, 0)
          assert.deepEqual(subject.publishedIncidents, [])
          assert.equal(subject.resolvedIncidents.length, 1)
          assert.deepEqual(subject.resolvedIncidents[0].slice(0, 2), [
            tenant.organizationId, `tenant:${tenant.id}:sync:${subject.resource}`,
          ])
          assert.equal((subject.resolvedIncidents[0][2] as Record<string, unknown>).eventType, 'tenant.sync_recovered')
          assert.ok(subject.events.indexOf('snapshot commit resolved') < subject.events.indexOf('SUCCEEDED'))
          assert.ok(subject.events.indexOf('SUCCEEDED') < subject.events.indexOf('incident resolved'))
        }
      } finally {
        subject.commitCompletion.resolve()
        await outcome
      }
    })
  }
}
