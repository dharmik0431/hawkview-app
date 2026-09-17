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
