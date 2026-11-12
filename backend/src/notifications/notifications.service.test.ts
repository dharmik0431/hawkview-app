import assert from 'node:assert/strict'
import test from 'node:test'
import { NotificationsService } from './notifications.service.js'

const hostile = 'user@example.test access_token=never password=never https://private.example/path'

test('notification operational logs never include hostile caller event types on success or failure', async () => {
  const messages: string[] = []
  const success = new NotificationsService({
    notification: { upsert: async () => ({ id: 'notification-private', occurrenceCount: 1, eventType: hostile }) },
    notificationUserState: { deleteMany: async () => ({ count: 0 }) },
  } as any)
  ;(success as any).logger = { log: (message: string) => messages.push(message), error: (message: string) => messages.push(message) }
  const input = { organizationId: 'org-private', eventType: hostile, category: 'warning' as const, title: 'safe', description: 'safe', dedupeKey: 'private', source: 'test' }
  await success.publishIncident(input)

  const failure = new NotificationsService({
    notification: { upsert: async () => { throw new Error(hostile) } },
  } as any)
  ;(failure as any).logger = { log: (message: string) => messages.push(message), error: (message: string) => messages.push(message) }
  assert.equal(await failure.publishIncident(input), null)

  const resolveSuccess = new NotificationsService({
    notification: {
      findUnique: async () => ({ id: hostile, resolvedAt: null, occurrenceCount: 1 }),
      update: async () => ({}),
    },
  } as any)
  ;(resolveSuccess as any).logger = { log: (message: string) => messages.push(message), error: (message: string) => messages.push(message) }
  await resolveSuccess.resolveIncident(hostile, hostile)

  const resolveFailure = new NotificationsService({
    notification: { findUnique: async () => { throw new Error(hostile) } },
  } as any)
  ;(resolveFailure as any).logger = { log: (message: string) => messages.push(message), error: (message: string) => messages.push(message) }
  assert.equal(await resolveFailure.resolveIncident(hostile, hostile), null)

  assert.deepEqual(messages.map((message) => JSON.parse(message)), [
    { event: 'notification.published', outcome: 'COMPLETED', occurrenceCount: 1 },
    { event: 'notification.publish_failed', outcome: 'FAILED', reasonCode: 'PERSISTENCE_UNAVAILABLE' },
    { event: 'notification.resolved', outcome: 'COMPLETED' },
    { event: 'notification.resolve_failed', outcome: 'FAILED', reasonCode: 'PERSISTENCE_UNAVAILABLE' },
  ])
  for (const message of messages) {
    assert.equal(message.includes('user@example.test'), false)
    assert.equal(message.includes('access_token'), false)
    assert.equal(message.includes('private.example'), false)
    const event = JSON.parse(message)
    assert.equal(typeof event.event, 'string')
    assert.equal('eventType' in event, false)
  }
})

test('typed incident resolution only closes an unresolved matching warning', async () => {
  const rows = new Map([
    ['warning', { eventType: 'tenant.initial_sync_in_progress', resolvedAt: null as Date | null }],
    ['success', { eventType: 'tenant.initial_sync_completed', resolvedAt: null as Date | null }],
  ])
  const service = new NotificationsService({
    notification: {
      updateMany: async ({ where, data }: any) => {
        assert.equal(where.organizationId, 'org')
        assert.equal(where.resolvedAt, null)
        const row = rows.get(where.dedupeKey)
        if (!row || row.resolvedAt || !where.eventType.in.includes(row.eventType)) return { count: 0 }
        row.resolvedAt = data.resolvedAt
        return { count: 1 }
      },
    },
  } as any)
  ;(service as any).logger = { log: () => undefined, error: () => undefined }
  const allowed = ['tenant.initial_sync_in_progress', 'tenant.initial_sync_action_required']

  assert.equal(await service.resolveIncidentIfEventType('org', 'success', allowed), false)
  assert.equal(rows.get('success')?.resolvedAt, null)
  assert.equal(await service.resolveIncidentIfEventType('org', 'warning', allowed), true)
  assert.ok(rows.get('warning')?.resolvedAt instanceof Date)
  assert.equal(await service.resolveIncidentIfEventType('org', 'warning', allowed), false)
})

test('republished initial-sync notice changes event type with its deduped status', async () => {
  const key = 'tenant:tenant-1:initial-sync'
  const row = {
    id: 'notice-1', organizationId: 'org-1', dedupeKey: key,
    eventType: 'tenant.initial_sync_in_progress', resolvedAt: null as Date | null,
    occurrenceCount: 1,
  }
  const service = new NotificationsService({
    notification: {
      upsert: async ({ where, update }: any) => {
        assert.deepEqual(where.organizationId_dedupeKey, { organizationId: 'org-1', dedupeKey: key })
        Object.assign(row, update, { occurrenceCount: row.occurrenceCount + 1 })
        return row
      },
      updateMany: async ({ where, data }: any) => {
        assert.equal(where.organizationId, row.organizationId)
        assert.equal(where.dedupeKey, row.dedupeKey)
        if (row.resolvedAt || !where.eventType.in.includes(row.eventType)) return { count: 0 }
        row.resolvedAt = data.resolvedAt
        return { count: 1 }
      },
    },
    notificationUserState: { deleteMany: async () => ({ count: 0 }) },
  } as any)
  ;(service as any).logger = { log: () => undefined, error: () => undefined }
  const publish = (eventType: string) => service.publishIncident({
    organizationId: 'org-1', customerTenantId: 'tenant-1', eventType,
    category: 'info', title: eventType, description: 'Current status',
    dedupeKey: key, source: 'tenant-sync',
  })
  const warningTypes = ['tenant.initial_sync_in_progress', 'tenant.initial_sync_action_required']

  await publish('tenant.initial_sync_completed')
  assert.equal(row.eventType, 'tenant.initial_sync_completed')
  assert.equal(await service.resolveIncidentIfEventType('org-1', key, warningTypes), false)
  assert.equal(row.resolvedAt, null)

  await publish('tenant.initial_sync_in_progress')
  assert.equal(row.eventType, 'tenant.initial_sync_in_progress')
  assert.equal(await service.resolveIncidentIfEventType('org-1', key, warningTypes), true)
  assert.ok((row.resolvedAt as Date | null) instanceof Date)
})

test('limited sign-in passes replace stale incident reason and action without republishing or resolving it', async () => {
  const oldAction = '/tenants/tenant-1/settings'
  const rows = [
    { organizationId: 'org-1', customerTenantId: 'tenant-1', dedupeKey: 'tenant:tenant-1:sync:SIGN_INS', eventType: 'tenant.sync_failed', resolvedAt: null as Date | null, title: 'Sign ins require attention', description: 'Review Microsoft permissions.', actionUrl: oldAction, actionLabel: 'Review permissions', severity: 'high', metadata: { reasonCode: 'MICROSOFT_PERMISSION_DENIED' }, occurrenceCount: 3 },
    { organizationId: 'other-org', customerTenantId: 'tenant-1', dedupeKey: 'tenant:tenant-1:sync:SIGN_INS', eventType: 'tenant.sync_failed', resolvedAt: null as Date | null, title: 'Foreign incident', description: 'Foreign', actionUrl: oldAction, actionLabel: 'Review permissions', severity: 'high', metadata: {}, occurrenceCount: 1 },
    { organizationId: 'org-1', customerTenantId: 'tenant-2', dedupeKey: 'tenant:tenant-2:sync:SIGN_INS', eventType: 'tenant.sync_failed', resolvedAt: new Date(), title: 'Resolved incident', description: 'Old', actionUrl: oldAction, actionLabel: 'Review permissions', severity: 'high', metadata: {}, occurrenceCount: 1 },
    { organizationId: 'org-1', customerTenantId: 'tenant-3', dedupeKey: 'tenant:tenant-3:sync:SIGN_INS', eventType: 'tenant.sync_recovered', resolvedAt: null as Date | null, title: 'Recovery notice', description: 'Recovered', actionUrl: oldAction, actionLabel: 'View tenant', severity: 'info', metadata: {}, occurrenceCount: 1 },
  ]
  const service = new NotificationsService({
    notification: {
      updateMany: async ({ where, data }: any) => {
        const matching = rows.filter(row => row.organizationId === where.organizationId && row.customerTenantId === where.customerTenantId && row.dedupeKey === where.dedupeKey && row.eventType === where.eventType && row.resolvedAt === where.resolvedAt)
        matching.forEach(row => Object.assign(row, data))
        return { count: matching.length }
      },
      upsert: async () => { throw new Error('Refreshing must not republish') },
    },
    notificationUserState: { deleteMany: async () => { throw new Error('Refreshing must retain user state') } },
  } as any)
  ;(service as any).logger = { error: () => undefined }

  assert.equal(await service.refreshOpenSignInIncident('org-1', 'tenant-1', 'LIMITED'), true)
  assert.equal(rows[0]?.title, 'Sign in coverage limited')
  assert.match(rows[0]?.description ?? '', /full Microsoft Graph sign in coverage is not yet verified/i)
  assert.equal(rows[0]?.actionUrl, '/tenants/tenant-1')
  assert.equal(rows[0]?.actionLabel, 'View synchronization')
  assert.equal(rows[0]?.severity, 'medium')
  assert.deepEqual(rows[0]?.metadata, { resourceType: 'SIGN_INS', coverageState: 'LIMITED', consecutiveFailures: 0 })
  assert.equal(rows[0]?.occurrenceCount, 3)
  assert.equal(rows[0]?.resolvedAt, null)

  assert.equal(await service.refreshOpenSignInIncident('org-1', 'tenant-1', 'INITIALIZING'), true)
  assert.equal(rows[0]?.title, 'Sign in collection initializing')
  assert.match(rows[0]?.description ?? '', /Microsoft is preparing the sign in source/i)
  assert.deepEqual(rows[0]?.metadata, { resourceType: 'SIGN_INS', coverageState: 'INITIALIZING', consecutiveFailures: 0 })
  assert.equal(await service.refreshOpenSignInIncident('org-1', 'tenant-2', 'LIMITED'), false)
  assert.equal(await service.refreshOpenSignInIncident('org-1', 'tenant-3', 'LIMITED'), false)
  assert.equal(rows[1]?.title, 'Foreign incident')
  assert.equal(rows[2]?.title, 'Resolved incident')
  assert.equal(rows[3]?.title, 'Recovery notice')
})

const preferenceOrg = '00000000-0000-4000-8000-000000000041'
const preferenceOtherOrg = '00000000-0000-4000-8000-000000000042'
const preferenceUser = '00000000-0000-4000-8000-000000000043'
const preferenceIdentity = { subject: 'auth|preferences-unit', email: 'preferences@example.test' }

function preferenceHarness() {
  const record: Record<string, unknown> = {
    id: '00000000-0000-4000-8000-000000000044', userId: preferenceUser, organizationId: preferenceOrg,
    securityEnabled: true, connectionEnabled: true, synchronizationEnabled: true,
    accountEnabled: true, inAppEnabled: true, emailEnabled: false, minimumSeverity: 'info', digestMode: 'off',
  }
  const state = {
    disabledAt: null as Date | null, memberships: [{ organizationId: preferenceOrg, role: 'MSP_VIEWER' }],
    eligible: true, writes: 0, failRead: false, beforeWrite: () => {},
  }
  const prisma: any = {
    user: { findUnique: async () => ({ id: preferenceUser, disabledAt: state.disabledAt, memberships: state.memberships }) },
    notificationPreference: {
      findUnique: async () => ({ ...record }),
      upsert: async ({ where }: any) => {
        if (state.failRead) throw new Error('preference read unavailable')
        assert.deepEqual(where, { userId_organizationId: { userId: preferenceUser, organizationId: preferenceOrg } })
        return { ...record }
      },
      update: async ({ where, data }: any) => {
        assert.deepEqual(where, { userId_organizationId: { userId: preferenceUser, organizationId: preferenceOrg } })
        state.writes++
        Object.assign(record, data)
        return { ...record }
      },
    },
    $queryRaw: async () => state.eligible ? [{ id: preferenceUser, role: state.memberships[0].role }] : [],
    $transaction: async (body: (tx: any) => unknown) => { state.beforeWrite(); return body(prisma) },
  }
  return { service: new NotificationsService(prisma), record, state }
}

test('personal GET retains defaults and separates personal access from workspace policy authority', async () => {
  const { service, record } = preferenceHarness()
  const response = await service.preferences(preferenceIdentity, preferenceOrg)
  for (const field of Object.keys(record)) assert.equal((response as any)[field], record[field])
  assert.equal(response.canManagePolicy, false)
  assert.equal(response.capabilities.readState, 'AVAILABLE')
  assert.deepEqual(response.capabilities.supportedDigestModes, ['off'])
})

test('personal preferences reject malformed, foreign and ambiguous organization scope', async () => {
  const { service, state } = preferenceHarness()
  for (const organizationId of ['', 'not-a-uuid', null, 1, []]) {
    await assert.rejects(service.updatePreferences(preferenceIdentity, { organizationId, emailEnabled: true }), /valid organizationId/)
  }
  await assert.rejects(service.preferences(preferenceIdentity, preferenceOtherOrg), /Workspace is not available/)
  state.memberships.push({ organizationId: preferenceOtherOrg, role: 'MSP_ADMIN' })
  await assert.rejects(service.preferences(preferenceIdentity), /explicit organizationId/)
  await assert.rejects(service.updatePreferences(preferenceIdentity, { emailEnabled: true }), /explicit organizationId/)
  assert.equal(state.writes, 0)
  state.memberships.pop()
  assert.equal((await service.updatePreferences(preferenceIdentity, { emailEnabled: true })).organizationId, preferenceOrg)
})

test('personal PATCH rejects malformed boolean and minimum severity fields', async () => {
  const { service, state } = preferenceHarness()
  for (const field of ['securityEnabled', 'connectionEnabled', 'synchronizationEnabled', 'accountEnabled', 'inAppEnabled', 'emailEnabled']) {
    await assert.rejects(service.updatePreferences(preferenceIdentity, { organizationId: preferenceOrg, [field]: 'true' }), /must be a boolean/)
  }
  for (const minimumSeverity of ['warning', 'error', 'ACT_NOW', '', null, 2]) {
    await assert.rejects(service.updatePreferences(preferenceIdentity, { organizationId: preferenceOrg, minimumSeverity }), /recognized notification severity/)
  }
  assert.equal(state.writes, 0)
  for (const minimumSeverity of ['info', 'low', 'medium', 'high', 'critical']) {
    assert.equal((await service.updatePreferences(preferenceIdentity, { organizationId: preferenceOrg, minimumSeverity })).minimumSeverity, minimumSeverity)
  }
})

test('unsupported stored digests survive read and unrelated write, but cannot be newly selected', async () => {
  for (const digest of ['daily', 'weekly']) {
    const { service, record } = preferenceHarness()
    record.digestMode = digest
    assert.equal((await service.preferences(preferenceIdentity, preferenceOrg)).digestMode, digest)
    assert.equal((await service.updatePreferences(preferenceIdentity, { organizationId: preferenceOrg, emailEnabled: false })).digestMode, digest)
    assert.equal((await service.updatePreferences(preferenceIdentity, { organizationId: preferenceOrg, digestMode: digest })).digestMode, digest)
    await assert.rejects(service.updatePreferences(preferenceIdentity, { organizationId: preferenceOrg, digestMode: digest === 'daily' ? 'weekly' : 'daily' }), /Only off/)
    assert.equal((await service.updatePreferences(preferenceIdentity, { organizationId: preferenceOrg, digestMode: 'off' })).digestMode, 'off')
    await assert.rejects(service.updatePreferences(preferenceIdentity, { organizationId: preferenceOrg, digestMode: digest }), /Only off/)
  }
})

test('personal write rechecks authorization and cannot target another user', async () => {
  const { service, state, record } = preferenceHarness()
  await service.preferences(preferenceIdentity, preferenceOrg)
  state.beforeWrite = () => { state.eligible = false }
  await assert.rejects(service.updatePreferences(preferenceIdentity, { organizationId: preferenceOrg, emailEnabled: true }), /Workspace is not available/)
  assert.equal(state.writes, 0)
  assert.equal(record.emailEnabled, false)
  state.beforeWrite = () => { state.eligible = true }
  const result = await service.updatePreferences(preferenceIdentity, { organizationId: preferenceOrg, userId: 'someone-else', emailEnabled: true })
  assert.equal(result.userId, preferenceUser)
  state.disabledAt = new Date()
  await assert.rejects(service.updatePreferences(preferenceIdentity, { organizationId: preferenceOrg, emailEnabled: false }), /cannot access notifications/)
})

test('preference read failures never turn into default-looking available settings', async () => {
  const { service, state } = preferenceHarness()
  state.failRead = true
  await assert.rejects(service.preferences(preferenceIdentity, preferenceOrg), /read unavailable/)
})
