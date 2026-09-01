import assert from 'node:assert/strict'
import test from 'node:test'
import {
  M365ManagementActivityService,
  M365AuditBudgetError,
  M365_ACTIVITY_CONTENT_TYPES,
  compactManagementEvidence,
  classifyManagementActivity,
  isPrimaryManagementActivity,
  managementActivityRoleFromEvidence,
  managementContentWindows,
  readBoundedJson,
  readBoundedText,
  retryDelayMs,
  validateManagementUrl,
} from './m365-management-activity.service.js'

const tenant = {
  id: '11111111-1111-1111-1111-111111111111',
  organizationId: '22222222-2222-2222-2222-222222222222',
  microsoftTenantId: '33333333-3333-3333-3333-333333333333',
  connection: {
    connectionMode: 'HAWKVIEW_MANAGED',
    clientId: '44444444-4444-4444-4444-444444444444',
    credentialReference: null,
  },
}

const content = {
  id: '55555555-5555-5555-5555-555555555555',
  contentType: 'Audit.Exchange',
  microsoftContentId: 'blob-1',
  contentUri: `https://manage.office.com/api/v1.0/${tenant.microsoftTenantId}/activity/feed/audit/20260817120000000000000$20260817130000000000000$audit_exchange$Audit_Exchange`,
  attemptCount: 0,
}
const publisherIdentifier = '66666666-6666-6666-6666-666666666666'

function record(overrides: Record<string, unknown> = {}) {
  return {
    Id: 'record-1',
    OrganizationId: tenant.microsoftTenantId,
    CreationTime: '2026-08-17T12:30:00.000Z',
    Operation: 'Set-Mailbox',
    Workload: 'Exchange',
    ResultStatus: 'Succeeded',
    UserId: 'admin@example.test',
    ObjectId: 'mailbox@example.test',
    ...overrides,
  }
}

test('keeps genuine M365 administration changes and excludes routine user activity', () => {
  for (const [operation, workload] of [
    ['Set-Mailbox', 'Exchange'],
    ['Add-MailboxPermission', 'Exchange'],
    ['New-TransportRule', 'Exchange'],
    ['Remove-TransportRule', 'Exchange'],
    ['Set-InboxRule', 'Exchange'],
    ['Set-AcceptedDomain', 'Exchange'],
    ['SiteCollectionAdminAdded', 'SharePoint'],
    ['SharingSet', 'SharePoint'],
    ['AddedToSecureLink', 'SharePoint'],
    ['Set-SPOTenant', 'SharePoint'],
    ['TeamSettingChanged', 'MicrosoftTeams'],
    ['MemberAdded', 'MicrosoftTeams'],
    ['MemberRemoved', 'MicrosoftTeams'],
    ['ChannelDeleted', 'MicrosoftTeams'],
    ['TeamCreated', 'MicrosoftTeams'],
    ['Update conditional access policy', 'AzureActiveDirectory'],
    ['Add service principal credentials', 'AzureActiveDirectory'],
    ['Consent to application', 'AzureActiveDirectory'],
  ] as const) {
    assert.equal(isPrimaryManagementActivity(record({ Operation: operation, Workload: workload })), true, operation)
  }
  for (const operation of [
    'UserLoggedIn',
    'FileAccessed',
    'FileDeleted',
    'FilePreviewed',
    'FileDownloaded',
    'FolderCreated',
    'PageViewed',
    'SearchQueryPerformed',
    'MailItemsAccessed',
    'MessageAccessed',
  ]) {
    assert.equal(isPrimaryManagementActivity(record({ Operation: operation })), false, operation)
  }
  assert.equal(isPrimaryManagementActivity(record({ ResultStatus: 'Failed' })), false)
  for (const operation of ['Move', 'Delete', 'MoveToDeletedItems', 'SoftDelete', 'HardDelete']) {
    assert.equal(
      classifyManagementActivity(record({ Operation: operation })),
      'security_supporting_activity',
      operation,
    )
  }
  assert.equal(classifyManagementActivity(record({ Operation: 'Set-InboxRule' })), 'primary_change')
  assert.equal(classifyManagementActivity(record({ Operation: 'Create' })), 'routine_activity')
  assert.equal(classifyManagementActivity(record({ Operation: 'Update' })), 'routine_activity')
  assert.equal(classifyManagementActivity(record({ Operation: 'FileAccessed' })), 'routine_activity')
})

test('fails closed for read, sync, Teams message, To Do, and legacy-promoted telemetry', () => {
  for (const candidate of [
    record({ Operation: 'Features_Get', Workload: 'AzureActiveDirectory' }),
    record({ Operation: 'Policy_GetDetails', Workload: 'AzureActiveDirectory' }),
    record({ Operation: 'CollectorSyncCompleted', Workload: 'Microsoft365' }),
    record({ Operation: 'MessageCreated', Workload: 'MicrosoftTeams' }),
    record({ Operation: 'ChatMessageUpdated', Workload: 'MicrosoftTeams' }),
    record({ Operation: 'TaskCreated', Workload: 'Microsoft To Do' }),
  ]) {
    assert.equal(classifyManagementActivity(candidate), 'routine_activity', String(candidate.Operation))
  }
  assert.equal(managementActivityRoleFromEvidence({
    operationName: 'MessageCreated', workload: 'MicrosoftTeams',
    raw: { hawkviewEvidenceRole: 'primary_change', Operation: 'MessageCreated', Workload: 'MicrosoftTeams' },
  }), 'routine_activity')
})

test('retains investigation fields while redacting secrets named inside Microsoft parameter arrays', () => {
  const compact = compactManagementEvidence(record({
    Authorization: 'Bearer secret',
    Parameters: [
      { Name: 'ClientSecret', Value: 'do-not-store' },
      { Name: 'DisplayName', Value: 'Useful rule name' },
    ],
    ModifiedProperties: [
      { DisplayName: 'PasswordCredential', OldValue: 'old-secret', NewValue: 'new-secret' },
    ],
    UnneededLargeField: 'not retained',
  })) as any
  assert.equal(compact.Authorization, undefined)
  assert.equal(compact.Parameters[0].Value, '[REDACTED]')
  assert.equal(compact.Parameters[1].Value, 'Useful rule name')
  assert.equal(compact.ModifiedProperties[0].OldValue, '[REDACTED]')
  assert.equal(compact.ModifiedProperties[0].NewValue, '[REDACTED]')
  assert.equal(compact.UnneededLargeField, undefined)
})

test('accepts only HTTPS Management Activity URLs for the exact connected tenant', () => {
  assert.doesNotThrow(() => validateManagementUrl(content.contentUri, tenant.microsoftTenantId))
  assert.throws(
    () => validateManagementUrl(content.contentUri.replace(tenant.microsoftTenantId, 'other-tenant'), tenant.microsoftTenantId),
    /outside the connected tenant/,
  )
  assert.throws(
    () => validateManagementUrl(content.contentUri.replace('manage.office.com', 'evil.example'), tenant.microsoftTenantId),
    /outside the connected tenant/,
  )
})

test('honors Retry-After and bounds JSON bodies before parsing', async () => {
  assert.equal(retryDelayMs(5, 17), 17_000)
  assert.equal(retryDelayMs(0, null, () => 0), 800)
  const valid = new Response(JSON.stringify({ ok: true }))
  assert.deepEqual(await readBoundedJson(valid, 100), { ok: true })
  const oversized = new Response('x'.repeat(101))
  await assert.rejects(() => readBoundedJson(oversized, 100), /100-byte safety limit/)
})

test('bounds non-success bodies and refuses redirects after URL validation', async () => {
  const bounded = await readBoundedText(new Response('x'.repeat(70_000)), 64 * 1024)
  assert.equal(Buffer.byteLength(bounded) <= 64 * 1024 + Buffer.byteLength(' [TRUNCATED]'), true)
  assert.match(bounded, /\[TRUNCATED\]$/)

  const service = new M365ManagementActivityService({} as never, {} as never)
  const originalFetch = globalThis.fetch
  let redirect: RequestRedirect | undefined
  globalThis.fetch = async (_input, init) => {
    redirect = init?.redirect
    return new Response('bad request', { status: 400 })
  }
  try {
    await assert.rejects(
      () => (service as any).request(
        `https://manage.office.com/api/v1.0/${tenant.microsoftTenantId}/activity/feed/subscriptions/list`,
        { headers: {} },
        tenant.microsoftTenantId,
        publisherIdentifier,
      ),
      /HTTP 400: bad request/,
    )
    assert.equal(redirect, 'error')
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('meters actual response bytes even when Content-Length understates the body', async () => {
  const service = new M365ManagementActivityService({} as never, {} as never)
  let reserved = 0
  let released = 0
  ;(service as any).reserveDailyUsage = async (_tenant: unknown, usage: { bytes: number }) => { reserved += usage.bytes }
  ;(service as any).releaseUnusedDownloadReservation = async (_tenant: unknown, bytes: number) => { released += bytes }
  const body = JSON.stringify({ value: 'longer-than-one-byte' })
  const budget = { remainingBytes: 100 }
  const response = new Response(body, { headers: { 'Content-Length': '1' } })
  const payload = await (service as any).readMeteredJson(tenant, response, 100, budget)
  assert.deepEqual(payload, { value: 'longer-than-one-byte' })
  assert.equal(reserved, 100)
  assert.equal(released, 100 - Buffer.byteLength(body))
  assert.equal(budget.remainingBytes, 100 - Buffer.byteLength(body))
})

test('starts at most one missing subscription and persists Microsoft\'s 15-minute cooldown', async () => {
  const upserts: any[] = []
  const subscriptions: any[] = []
  const subscriptionStore = {
    findMany: async () => subscriptions,
    upsert: async (args: any) => {
      upserts.push(args)
      const contentType = args.where.customerTenantId_contentType.contentType
      const index = subscriptions.findIndex((entry) => entry.contentType === contentType)
      const next = index >= 0
        ? { ...subscriptions[index], ...args.update, contentType }
        : { ...args.create, contentType }
      if (index >= 0) subscriptions[index] = next
      else subscriptions.push(next)
      return next
    },
  }
  const prisma: any = {
    m365ActivitySubscription: subscriptionStore,
    $transaction: async (callback: any) => callback({
      $executeRawUnsafe: async () => undefined,
      m365ActivitySubscription: subscriptionStore,
    }),
  }
  const service = new M365ManagementActivityService(prisma, {} as never)
  ;(service as any).readMeteredJson = async (_tenant: unknown, response: Response, maximum: number, budget?: { remainingBytes: number }) =>
    readBoundedJson(response, maximum, budget)
  const requests: Array<{ method: string; url: URL }> = []
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (input, init) => {
    requests.push({ method: init?.method ?? 'GET', url: new URL(String(input)) })
    return new Response(init?.method === 'POST' ? '{}' : '[]')
  }
  const now = new Date('2026-08-17T12:00:00.000Z')
  try {
    const enabled = await (service as any).ensureSubscriptions(
      tenant,
      'token',
      publisherIdentifier,
      now,
    )
    assert.equal(enabled.size, 1)
    assert.equal(requests.filter((request) => request.method === 'POST').length, 1)
    assert.equal(
      requests.every((request) => request.url.searchParams.get('PublisherIdentifier') === publisherIdentifier),
      true,
    )
    assert.equal(upserts.some((entry) => entry.create.lastStartRequestedAt?.getTime() === now.getTime()), true)
  } finally {
    globalThis.fetch = originalFetch
  }

  let postCount = 0
  globalThis.fetch = async (_input, init) => {
    if (init?.method === 'POST') postCount += 1
    return new Response('[]')
  }
  try {
    await (service as any).ensureSubscriptions(
      tenant,
      'token',
      publisherIdentifier,
      new Date(now.getTime() + 5 * 60 * 1000),
    )
    assert.equal(postCount, 0)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('serializes concurrent subscription starts so only one POST occurs', async () => {
  const subscriptions: any[] = []
  let transactionTail = Promise.resolve()
  let postCount = 0
  const subscriptionStore = {
    findMany: async () => subscriptions,
    upsert: async (args: any) => {
      const contentType = args.where.customerTenantId_contentType.contentType
      const index = subscriptions.findIndex((entry) => entry.contentType === contentType)
      const next = index >= 0
        ? { ...subscriptions[index], ...args.update, contentType }
        : { ...args.create, contentType }
      if (index >= 0) subscriptions[index] = next
      else subscriptions.push(next)
      return next
    },
  }
  const prisma: any = {
    m365ActivitySubscription: subscriptionStore,
    $transaction: async (callback: any) => {
      const previous = transactionTail
      let release!: () => void
      transactionTail = new Promise<void>((resolve) => { release = resolve })
      await previous
      try {
        return await callback({
          $executeRawUnsafe: async () => undefined,
          m365ActivitySubscription: subscriptionStore,
        })
      } finally {
        release()
      }
    },
  }
  const service = new M365ManagementActivityService(prisma, {} as never)
  ;(service as any).readMeteredJson = async (_tenant: unknown, response: Response, maximum: number, budget?: { remainingBytes: number }) =>
    readBoundedJson(response, maximum, budget)
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (_input, init) => {
    if (init?.method === 'POST') postCount += 1
    return new Response(init?.method === 'POST' ? '{}' : '[]')
  }
  try {
    const now = new Date('2026-08-17T12:00:00.000Z')
    await Promise.all([
      (service as any).ensureSubscriptions(tenant, 'token', publisherIdentifier, now),
      (service as any).ensureSubscriptions(tenant, 'token', publisherIdentifier, now),
    ])
    assert.equal(postCount, 1)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('starts Azure AD audit first for the limited-license sign-in fallback and rotates past a failed workload', async () => {
  const subscriptions: any[] = []
  const starts: string[] = []
  const subscriptionStore = {
    findMany: async () => subscriptions,
    upsert: async (args: any) => {
      const contentType = args.where.customerTenantId_contentType.contentType
      const index = subscriptions.findIndex((entry) => entry.contentType === contentType)
      const next = index >= 0
        ? { ...subscriptions[index], ...args.update, contentType }
        : { ...args.create, contentType }
      if (index >= 0) subscriptions[index] = next
      else subscriptions.push(next)
      return next
    },
  }
  const prisma: any = {
    m365ActivitySubscription: subscriptionStore,
    $transaction: async (callback: any) => callback({
      $executeRawUnsafe: async () => undefined,
      m365ActivitySubscription: subscriptionStore,
    }),
  }
  const service = new M365ManagementActivityService(prisma, {} as never)
  ;(service as any).readMeteredJson = async (_tenant: unknown, response: Response) =>
    response.json()
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input))
    if (init?.method === 'POST') {
      const contentType = url.searchParams.get('contentType') ?? ''
      starts.push(contentType)
      if (contentType === 'Audit.AzureActiveDirectory') {
        return new Response(JSON.stringify({ error: { message: 'Tenant does not exist.' } }), {
          status: 400,
        })
      }
      return new Response('{}')
    }
    return new Response('[]')
  }
  try {
    const first = await (service as any).ensureSubscriptions(
      tenant,
      'token',
      publisherIdentifier,
      new Date('2026-08-17T12:00:00.000Z'),
    )
    assert.equal(first.size, 0)
    assert.equal(
      subscriptions.find((entry) => entry.contentType === 'Audit.AzureActiveDirectory')?.status,
      'FAILED',
    )

    const second = await (service as any).ensureSubscriptions(
      tenant,
      'token',
      publisherIdentifier,
      new Date('2026-08-17T12:16:00.000Z'),
    )
    assert.deepEqual(starts, ['Audit.AzureActiveDirectory', 'Audit.Exchange'])
    assert.equal(second.has('Audit.Exchange'), true)
    assert.equal(
      subscriptions.find((entry) => entry.contentType === 'Audit.AzureActiveDirectory')?.status,
      'FAILED',
    )
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('writes raw and normalized evidence and completes a content ledger in one transaction', async () => {
  const rawWrites: any[] = []
  const evidenceWrites: any[] = []
  const ledgerWrites: any[] = []
  const usageWrites: any[] = []
  const prisma: any = {
    m365ActivityContent: {
      updateMany: async () => ({ count: 1 }),
    },
    m365AuditRecord: { findMany: async () => [] },
    m365AuditDailyUsage: { updateMany: async () => ({ count: 1 }) },
    directoryAuditLog: { findMany: async () => [] },
    $transaction: async (callback: any) => callback({
      $executeRawUnsafe: async () => undefined,
      m365AuditDailyUsage: {
        findUnique: async () => null,
        aggregate: async () => ({ _sum: { downloadedBytes: 0n, recordsStored: 0 } }),
        upsert: async (args: any) => { usageWrites.push(args) },
      },
      m365AuditRecord: { createMany: async ({ data }: any) => { rawWrites.push(...data); return { count: data.length } } },
      changeEvidenceEvent: { createMany: async ({ data }: any) => evidenceWrites.push(...data) },
      m365ActivityContent: { update: async ({ data }: any) => ledgerWrites.push(data) },
    }),
  }
  const service = new M365ManagementActivityService(prisma, {} as never)
  ;(service as any).readMeteredJson = async (_tenant: unknown, response: Response, maximum: number, budget?: { remainingBytes: number }) =>
    readBoundedJson(response, maximum, budget)
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (input) => {
    assert.equal(new URL(String(input)).searchParams.get('PublisherIdentifier'), publisherIdentifier)
    return new Response(JSON.stringify([
      record(),
      record(),
      record({ Id: 'record-already-accepted-concurrently' }),
      record({ Id: 'supporting-record', Operation: 'MoveToDeletedItems', ObjectId: 'message-1', MailboxOwnerUPN: 'victim@example.test' }),
      record({ Id: 'supporting-record-2', Operation: 'MoveToDeletedItems', ObjectId: 'message-2', MailboxOwnerUPN: 'victim@example.test', CreationTime: '2026-08-17T12:31:00.000Z' }),
      record({ Id: 'routine-record', Operation: 'FileAccessed' }),
    ]))
  }
  try {
    const changes = await (service as any).processContent(tenant, 'token', publisherIdentifier, { remainingBytes: 1024 * 1024 }, content)
    assert.equal(changes.length, 2)
    assert.equal(rawWrites.length, 3)
    assert.equal(evidenceWrites.length, 2)
    assert.equal(evidenceWrites[0].source, 'M365_UNIFIED_AUDIT')
    assert.equal(evidenceWrites[0].raw.evidenceOrigin, 'microsoft_audit_event')
    const supportingSummary = rawWrites.find((entry) => entry.raw.hawkviewEvidenceRole === 'security_supporting_activity')
    assert.equal(supportingSummary?.raw.hawkviewSupportingActivityCount, 2)
    assert.deepEqual(supportingSummary?.raw.hawkviewSupportingSampleRecordIds, ['supporting-record', 'supporting-record-2'])
    assert.match(supportingSummary?.microsoftRecordId, /^support:blob-1:/)
    assert.equal(rawWrites.some((entry) => entry.microsoftRecordId === 'routine-record'), false)
    assert.equal(ledgerWrites[0].status, 'COMPLETED')
    assert.equal(usageWrites.some((entry) => entry.create.recordsStored === 3), true)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('rejects a cross-tenant content blob before evidence writes', async () => {
  const evidenceWrites: any[] = []
  const states: string[] = []
  const prisma: any = {
    m365ActivityContent: {
      updateMany: async ({ data }: any) => {
        states.push(data.status)
        return { count: 1 }
      },
    },
    m365AuditRecord: { findMany: async () => [] },
    m365AuditDailyUsage: { updateMany: async () => ({ count: 1 }) },
    directoryAuditLog: { findMany: async () => [] },
    $transaction: async (callback: any) => callback({
      $executeRawUnsafe: async () => undefined,
      m365AuditDailyUsage: {
        findUnique: async () => null,
        aggregate: async () => ({ _sum: { downloadedBytes: 0n, recordsStored: 0 } }),
        upsert: async () => undefined,
      },
      m365AuditRecord: { createMany: async () => ({ count: 1 }) },
      changeEvidenceEvent: { createMany: async ({ data }: any) => evidenceWrites.push(...data) },
      m365ActivityContent: { update: async () => undefined },
    }),
  }
  const service = new M365ManagementActivityService(prisma, {} as never)
  ;(service as any).readMeteredJson = async (_tenant: unknown, response: Response, maximum: number, budget?: { remainingBytes: number }) =>
    readBoundedJson(response, maximum, budget)
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => new Response(JSON.stringify([record({ OrganizationId: 'other-tenant' })]))
  try {
    const changes = await (service as any).processContent(tenant, 'token', publisherIdentifier, { remainingBytes: 1024 * 1024 }, content)
    assert.deepEqual(changes, [])
    assert.deepEqual(states, ['PROCESSING', 'RETRY'])
    assert.equal(evidenceWrites.length, 0)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('does not mark a blob complete when the evidence transaction fails', async () => {
  const states: string[] = []
  const prisma: any = {
    m365ActivityContent: {
      updateMany: async ({ data }: any) => {
        states.push(data.status)
        return { count: 1 }
      },
    },
    m365AuditRecord: { findMany: async () => [] },
    m365AuditDailyUsage: { updateMany: async () => ({ count: 1 }) },
    directoryAuditLog: { findMany: async () => [] },
    $transaction: async (callback: any) => callback({
      $executeRawUnsafe: async () => undefined,
      m365AuditDailyUsage: {
        findUnique: async () => null,
        aggregate: async () => ({ _sum: { downloadedBytes: 0n, recordsStored: 0 } }),
        upsert: async () => undefined,
      },
      m365AuditRecord: { createMany: async () => ({ count: 1 }) },
      changeEvidenceEvent: { createMany: async () => { throw new Error('database unavailable') } },
      m365ActivityContent: { update: async ({ data }: any) => states.push(data.status) },
    }),
  }
  const service = new M365ManagementActivityService(prisma, {} as never)
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => new Response(JSON.stringify([record()]))
  try {
    const changes = await (service as any).processContent(tenant, 'token', publisherIdentifier, { remainingBytes: 1024 * 1024 }, content)
    assert.deepEqual(changes, [])
    assert.deepEqual(states, ['PROCESSING', 'RETRY'])
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('rolls record quota reservation back with failed evidence storage so retries are not double-charged', async () => {
  let committedRecords = 0
  const states: string[] = []
  const prisma: any = {
    m365ActivityContent: {
      updateMany: async ({ data }: any) => {
        states.push(data.status)
        return { count: 1 }
      },
    },
    m365AuditRecord: { findMany: async () => [] },
    directoryAuditLog: { findMany: async () => [] },
    $transaction: async (callback: any) => {
      let workingRecords = committedRecords
      const transaction = {
        $executeRawUnsafe: async () => undefined,
        m365AuditDailyUsage: {
          findUnique: async () => ({ downloadedBytes: 0n, recordsStored: workingRecords }),
          aggregate: async () => ({ _sum: { downloadedBytes: 0n, recordsStored: workingRecords } }),
          upsert: async ({ create, update }: any) => {
            workingRecords += create?.recordsStored ?? update?.recordsStored?.increment ?? 0
          },
        },
        m365AuditRecord: { createMany: async () => ({ count: 1 }) },
        changeEvidenceEvent: { createMany: async () => { throw new Error('evidence write failed') } },
        m365ActivityContent: { update: async () => undefined },
      }
      try {
        const result = await callback(transaction)
        committedRecords = workingRecords
        return result
      } catch (error) {
        throw error
      }
    },
  }
  const service = new M365ManagementActivityService(prisma, {} as never)
  ;(service as any).reserveDailyUsage = async () => undefined
  ;(service as any).releaseUnusedDownloadReservation = async () => undefined
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => new Response(JSON.stringify([record(), record()]))
  try {
    await (service as any).processContent(tenant, 'token', publisherIdentifier, { remainingBytes: 1024 * 1024 }, content)
    await (service as any).processContent(tenant, 'token', publisherIdentifier, { remainingBytes: 1024 * 1024 }, content)
    assert.equal(committedRecords, 0)
    assert.deepEqual(states, ['PROCESSING', 'RETRY', 'PROCESSING', 'RETRY'])
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('splits 24-hour, two-day, and seven-day catch-up ranges into contiguous valid windows', () => {
  const end = new Date('2026-08-17T12:00:00.000Z')
  for (const [days, expected] of [[1, 1], [2, 2], [7, 7]] as const) {
    const start = new Date(end.getTime() - days * 24 * 60 * 60 * 1000)
    const windows = managementContentWindows(start, end)
    assert.equal(windows.length, expected)
    assert.equal(windows[0].start.getTime(), start.getTime())
    assert.equal(windows.at(-1)?.end.getTime(), end.getTime())
    for (let index = 0; index < windows.length; index += 1) {
      assert.equal(windows[index].end.getTime() - windows[index].start.getTime() <= 24 * 60 * 60 * 1000, true)
      if (index > 0) assert.equal(windows[index - 1].end.getTime(), windows[index].start.getTime())
    }
  }
})

test('discovers catch-up windows oldest first and resumes a saved page without skipping it', async () => {
  const now = new Date('2026-08-17T12:00:00.000Z')
  const requests: URL[] = []
  let state: any = {
    lastSuccessfulPollAt: new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000),
    discoveryWindowStart: null,
    discoveryWindowEnd: null,
    discoveryNextPageUri: null,
  }
  const prisma: any = {
    m365ActivitySubscription: {
      findUnique: async () => state,
      update: async ({ data }: any) => { state = { ...state, ...data }; return state },
    },
    m365ActivityContent: { createMany: async () => undefined },
  }
  const service = new M365ManagementActivityService(prisma, {} as never)
  ;(service as any).readMeteredJson = async (_tenant: unknown, response: Response, maximum: number, budget?: { remainingBytes: number }) =>
    readBoundedJson(response, maximum, budget)
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (input) => {
    requests.push(new URL(String(input)))
    return new Response('[]')
  }
  try {
    const hasBacklog = await (service as any).discoverContent(
      tenant,
      'token',
      publisherIdentifier,
      new Set(['Audit.Exchange']),
      now,
      Date.now() + 10_000,
      { remainingBytes: 20 * 1024 * 1024 },
    )
    assert.equal(hasBacklog, false)
    assert.equal(requests.length >= 2, true)
    for (const request of requests) {
      const start = new Date(request.searchParams.get('startTime')!)
      const end = new Date(request.searchParams.get('endTime')!)
      assert.equal(end.getTime() - start.getTime() <= 24 * 60 * 60 * 1000, true)
    }

    const savedNext = `https://manage.office.com/api/v1.0/${tenant.microsoftTenantId}/activity/feed/subscriptions/content?contentType=Audit.Exchange&page=resume`
    state = {
      lastSuccessfulPollAt: new Date(now.getTime() - 60 * 60 * 1000),
      discoveryWindowStart: new Date(now.getTime() - 60 * 60 * 1000),
      discoveryWindowEnd: now,
      discoveryNextPageUri: savedNext,
    }
    requests.length = 0
    await (service as any).discoverContent(
      tenant,
      'token',
      publisherIdentifier,
      new Set(['Audit.Exchange']),
      now,
      Date.now() + 10_000,
      { remainingBytes: 20 * 1024 * 1024 },
    )
    assert.equal(requests[0].pathname + requests[0].search.replace(/&PublisherIdentifier=.*/, ''), new URL(savedNext).pathname + new URL(savedNext).search)
    assert.equal(state.lastSuccessfulPollAt.getTime(), now.getTime())
    assert.equal(state.discoveryNextPageUri, null)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('checkpoints every discovery page, detects repeated links, and resumes after the 100-page run ceiling', async () => {
  const now = new Date('2026-08-17T12:00:00.000Z')
  let state: any = {
    lastSuccessfulPollAt: new Date(now.getTime() - 60 * 60 * 1000),
    discoveryWindowStart: null,
    discoveryWindowEnd: null,
    discoveryNextPageUri: null,
  }
  let page = 0
  let inserted = 0
  const prisma: any = {
    m365ActivitySubscription: {
      findUnique: async () => state,
      update: async ({ data }: any) => { state = { ...state, ...data }; return state },
    },
    m365ActivityContent: {
      createMany: async ({ data }: any) => { inserted += data.length },
    },
  }
  const service = new M365ManagementActivityService(prisma, {} as never)
  ;(service as any).readMeteredJson = async (_tenant: unknown, response: Response, maximum: number, budget?: { remainingBytes: number }) =>
    readBoundedJson(response, maximum, budget)
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => {
    page += 1
    const next = `https://manage.office.com/api/v1.0/${tenant.microsoftTenantId}/activity/feed/subscriptions/content?contentType=Audit.Exchange&page=${page + 1}`
    return new Response(JSON.stringify([{
      contentId: `blob-${page}`,
      contentUri: content.contentUri.replace('blob-1', `blob-${page}`),
    }]), { headers: { NextPageUri: next } })
  }
  try {
    const firstBacklog = await (service as any).discoverContent(
      tenant, 'token', publisherIdentifier, new Set(['Audit.Exchange']), now, Date.now() + 30_000,
      { remainingBytes: 20 * 1024 * 1024 },
    )
    assert.equal(firstBacklog, true)
    assert.equal(page, 100)
    assert.equal(inserted, 100)
    assert.equal(Boolean(state.discoveryNextPageUri), true)

    globalThis.fetch = async () => new Response('[]')
    const secondBacklog = await (service as any).discoverContent(
      tenant, 'token', publisherIdentifier, new Set(['Audit.Exchange']), now, Date.now() + 30_000,
      { remainingBytes: 20 * 1024 * 1024 },
    )
    assert.equal(secondBacklog, false)
    assert.equal(state.discoveryNextPageUri, null)

    const repeated = `https://manage.office.com/api/v1.0/${tenant.microsoftTenantId}/activity/feed/subscriptions/content?contentType=Audit.Exchange&page=repeated`
    state = {
      lastSuccessfulPollAt: new Date(now.getTime() - 60 * 60 * 1000),
      discoveryWindowStart: null,
      discoveryWindowEnd: null,
      discoveryNextPageUri: null,
    }
    globalThis.fetch = async () => new Response('[]', { headers: { NextPageUri: repeated } })
    await assert.rejects(
      () => (service as any).discoverContent(
        tenant, 'token', publisherIdentifier, new Set(['Audit.Exchange']), now, Date.now() + 30_000,
        { remainingBytes: 20 * 1024 * 1024 },
      ),
      /repeated a page URL/,
    )
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('persists more than 5,000 discovered blobs page-by-page without restarting the window', async () => {
  const now = new Date('2026-08-17T12:00:00.000Z')
  let state: any = {
    lastSuccessfulPollAt: new Date(now.getTime() - 60 * 60 * 1000),
    discoveryWindowStart: null,
    discoveryWindowEnd: null,
    discoveryNextPageUri: null,
  }
  let inserted = 0
  let insertCalls = 0
  const prisma: any = {
    m365ActivitySubscription: {
      findUnique: async () => state,
      update: async ({ data }: any) => { state = { ...state, ...data }; return state },
    },
    m365ActivityContent: {
      createMany: async ({ data }: any) => {
        inserted += data.length
        insertCalls += 1
      },
    },
  }
  const service = new M365ManagementActivityService(prisma, {} as never)
  ;(service as any).readMeteredJson = async (_tenant: unknown, response: Response, maximum: number, budget?: { remainingBytes: number }) =>
    readBoundedJson(response, maximum, budget)
  const originalFetch = globalThis.fetch
  const items = Array.from({ length: 5_001 }, (_, index) => ({
    contentId: `busy-blob-${index}`,
    contentUri: content.contentUri,
  }))
  globalThis.fetch = async () => new Response(JSON.stringify(items))
  try {
    const backlog = await (service as any).discoverContent(
      tenant, 'token', publisherIdentifier, new Set(['Audit.Exchange']), now, Date.now() + 30_000,
      { remainingBytes: 20 * 1024 * 1024 },
    )
    assert.equal(backlog, false)
    assert.equal(inserted, 5_001)
    assert.equal(insertCalls, 11)
    assert.equal(state.lastSuccessfulPollAt.getTime(), now.getTime())
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('enforces daily and monthly tenant/deployment ingestion limits under a database lock', async () => {
  const original = {
    tenantMb: process.env.M365_AUDIT_TENANT_DAILY_DOWNLOAD_MB,
    deploymentMb: process.env.M365_AUDIT_DEPLOYMENT_DAILY_DOWNLOAD_MB,
    tenantMonthlyMb: process.env.M365_AUDIT_TENANT_MONTHLY_DOWNLOAD_MB,
    deploymentMonthlyMb: process.env.M365_AUDIT_DEPLOYMENT_MONTHLY_DOWNLOAD_MB,
  }
  process.env.M365_AUDIT_TENANT_DAILY_DOWNLOAD_MB = '2'
  process.env.M365_AUDIT_DEPLOYMENT_DAILY_DOWNLOAD_MB = '2'
  process.env.M365_AUDIT_TENANT_MONTHLY_DOWNLOAD_MB = '1'
  process.env.M365_AUDIT_DEPLOYMENT_MONTHLY_DOWNLOAD_MB = '2'
  let upserted = false
  let aggregateCalls = 0
  const prisma: any = {
    $transaction: async (callback: any) => callback({
      $executeRawUnsafe: async () => undefined,
      m365AuditDailyUsage: {
        findUnique: async () => ({ downloadedBytes: 0n, recordsStored: 0 }),
        aggregate: async () => ({
          _sum: {
            downloadedBytes: aggregateCalls++ === 1 ? 1024n * 1024n : 0n,
            recordsStored: 0,
          },
        }),
        upsert: async () => { upserted = true },
      },
    }),
  }
  try {
    const service = new M365ManagementActivityService(prisma, {} as never)
    await assert.rejects(
      () => (service as any).reserveDailyUsage(tenant, { bytes: 1 }),
      M365AuditBudgetError,
    )
    assert.equal(upserted, false)
  } finally {
    if (original.tenantMb === undefined) delete process.env.M365_AUDIT_TENANT_DAILY_DOWNLOAD_MB
    else process.env.M365_AUDIT_TENANT_DAILY_DOWNLOAD_MB = original.tenantMb
    if (original.deploymentMb === undefined) delete process.env.M365_AUDIT_DEPLOYMENT_DAILY_DOWNLOAD_MB
    else process.env.M365_AUDIT_DEPLOYMENT_DAILY_DOWNLOAD_MB = original.deploymentMb
    if (original.tenantMonthlyMb === undefined) delete process.env.M365_AUDIT_TENANT_MONTHLY_DOWNLOAD_MB
    else process.env.M365_AUDIT_TENANT_MONTHLY_DOWNLOAD_MB = original.tenantMonthlyMb
    if (original.deploymentMonthlyMb === undefined) delete process.env.M365_AUDIT_DEPLOYMENT_MONTHLY_DOWNLOAD_MB
    else process.env.M365_AUDIT_DEPLOYMENT_MONTHLY_DOWNLOAD_MB = original.deploymentMonthlyMb
  }
})

test('serializes monthly quota reservations made concurrently on different UTC days', async () => {
  const names = [
    'M365_AUDIT_TENANT_DAILY_DOWNLOAD_MB',
    'M365_AUDIT_DEPLOYMENT_DAILY_DOWNLOAD_MB',
    'M365_AUDIT_TENANT_MONTHLY_DOWNLOAD_MB',
    'M365_AUDIT_DEPLOYMENT_MONTHLY_DOWNLOAD_MB',
  ] as const
  const original = Object.fromEntries(names.map((name) => [name, process.env[name]]))
  process.env.M365_AUDIT_TENANT_DAILY_DOWNLOAD_MB = '2'
  process.env.M365_AUDIT_DEPLOYMENT_DAILY_DOWNLOAD_MB = '4'
  process.env.M365_AUDIT_TENANT_MONTHLY_DOWNLOAD_MB = '1'
  process.env.M365_AUDIT_DEPLOYMENT_MONTHLY_DOWNLOAD_MB = '2'

  const usageByDay = new Map<string, bigint>()
  const lockKeys: string[] = []
  let monthLockTail = Promise.resolve()
  const prisma: any = {
    $transaction: async (callback: any) => {
      const transactionState: {
        releaseMonth?: () => void
        pending?: { day: string; bytes: bigint }
      } = {}
      const transaction = {
        $executeRawUnsafe: async (_sql: string, key: string) => {
          lockKeys.push(key)
          if (!key.includes('monthly-budget')) return
          const previous = monthLockTail
          monthLockTail = new Promise<void>((resolve) => { transactionState.releaseMonth = resolve })
          await previous
        },
        m365AuditDailyUsage: {
          findUnique: async ({ where }: any) => {
            const day = where.customerTenantId_usageDate.usageDate.toISOString()
            return { downloadedBytes: usageByDay.get(day) ?? 0n, recordsStored: 0 }
          },
          aggregate: async ({ where }: any) => {
            if (where.usageDate instanceof Date) {
              return { _sum: { downloadedBytes: usageByDay.get(where.usageDate.toISOString()) ?? 0n, recordsStored: 0 } }
            }
            const range = where.usageDate
            const total = [...usageByDay.entries()]
              .filter(([day]) => {
                const value = new Date(day)
                return value >= range.gte && value < range.lt
              })
              .reduce((sum, [, value]) => sum + value, 0n)
            return { _sum: { downloadedBytes: total, recordsStored: 0 } }
          },
          upsert: async ({ create }: any) => {
            transactionState.pending = { day: create.usageDate.toISOString(), bytes: create.downloadedBytes }
          },
        },
      }
      try {
        const result = await callback(transaction)
        const pending = transactionState.pending
        if (pending) usageByDay.set(pending.day, (usageByDay.get(pending.day) ?? 0n) + pending.bytes)
        return result
      } finally {
        transactionState.releaseMonth?.()
      }
    },
  }
  try {
    const service = new M365ManagementActivityService(prisma, {} as never)
    const results = await Promise.allSettled([
      (service as any).reserveDailyUsage(
        tenant,
        { bytes: 1024 * 1024 },
        new Date('2026-08-18T00:00:01.000Z'),
      ),
      (service as any).reserveDailyUsage(
        tenant,
        { bytes: 1024 * 1024 },
        new Date('2026-08-17T23:59:59.000Z'),
      ),
    ])
    assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1)
    assert.equal(results.filter((result) => result.status === 'rejected').length, 1)
    const monthKeys = lockKeys.filter((key) => key.includes('monthly-budget'))
    const dayKeys = lockKeys.filter((key) => key.includes('daily-budget'))
    assert.equal(new Set(monthKeys).size, 1)
    assert.equal(new Set(dayKeys).size, 2)
    assert.equal([...usageByDay.values()].reduce((sum, value) => sum + value, 0n), 1024n * 1024n)
  } finally {
    for (const name of names) {
      const value = original[name]
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  }
})

test('batches high-volume Graph reconciliation predicates', async () => {
  let calls = 0
  const prisma: any = {
    directoryAuditLog: {
      findMany: async () => { calls += 1; return [] },
    },
  }
  const service = new M365ManagementActivityService(prisma, {} as never)
  const records = Array.from({ length: 1_001 }, (_, index) => record({
    Id: `record-${index}`,
    CorrelationId: `correlation-${index}`,
  }))
  await (service as any).existingDirectoryDuplicates(tenant, records)
  assert.equal(calls, 3)
})

test('reports a backlog after blob-count, byte-budget, and runtime bounds instead of false success', async () => {
  const originalRuntime = process.env.M365_AUDIT_MAX_RUNTIME_SECONDS
  const originalBlobs = process.env.M365_AUDIT_MAX_BLOBS_PER_RUN
  process.env.M365_AUDIT_MAX_RUNTIME_SECONDS = '45'
  process.env.M365_AUDIT_MAX_BLOBS_PER_RUN = '12'
  const originalDateNow = Date.now
  try {
    for (const scenario of ['blob-count', 'byte-budget', 'runtime'] as const) {
      let pendingLeft = 25
      const syncUpdates: any[] = []
      const prisma: any = {
        syncState: {
          findUnique: async () => null,
          upsert: async () => undefined,
          update: async ({ data }: any) => { syncUpdates.push(data); return data },
        },
        m365ActivityContent: {
          count: async ({ where }: any) => {
            if (where.status === 'PENDING') return pendingLeft
            if (['PROCESSING', 'RETRY', 'FAILED'].includes(where.status)) return 0
            return pendingLeft
          },
          updateMany: async () => ({ count: 0 }),
          findMany: async ({ take }: any) => Array.from(
            { length: Math.min(take, pendingLeft) },
            (_, index) => ({ ...content, id: `content-${scenario}-${index}` }),
          ),
          deleteMany: async () => ({ count: 0 }),
        },
        m365ActivitySubscription: { findMany: async () => [] },
        m365AuditRecord: { deleteMany: async () => ({ count: 0 }) },
        m365AuditDailyUsage: { deleteMany: async () => ({ count: 0 }) },
        $transaction: async (operations: any) => Promise.all(operations),
      }
      const consent: any = {
        getTenantManagementActivityContext: async () => ({
          accessToken: 'token',
          publisherIdentifier,
        }),
      }
      const service = new M365ManagementActivityService(prisma, consent)
      ;(service as any).ensureSubscriptions = async () => new Set(M365_ACTIVITY_CONTENT_TYPES)
      ;(service as any).discoverContent = async () => false
      ;(service as any).processContent = async (
        _tenant: unknown,
        _token: string,
        _publisher: string,
        budget: { remainingBytes: number },
      ) => {
        pendingLeft -= 1
        if (scenario === 'byte-budget') budget.remainingBytes = 0
        return []
      }
      if (scenario === 'runtime') {
        let calls = 0
        Date.now = () => calls++ === 0 ? 0 : 60_000
        process.env.M365_AUDIT_MAX_RUNTIME_SECONDS = '1'
      } else {
        Date.now = originalDateNow
        process.env.M365_AUDIT_MAX_RUNTIME_SECONDS = '45'
      }
      await service.syncTenant(tenant)
      const final = syncUpdates.at(-1)
      assert.equal(final.status, 'RUNNING', scenario)
      assert.equal(final.lastErrorCode, 'm365-audit-backlog', scenario)
      assert.match(final.lastErrorMessage, /content pending=[1-9]/, scenario)
    }
  } finally {
    Date.now = originalDateNow
    if (originalRuntime === undefined) delete process.env.M365_AUDIT_MAX_RUNTIME_SECONDS
    else process.env.M365_AUDIT_MAX_RUNTIME_SECONDS = originalRuntime
    if (originalBlobs === undefined) delete process.env.M365_AUDIT_MAX_BLOBS_PER_RUN
    else process.env.M365_AUDIT_MAX_BLOBS_PER_RUN = originalBlobs
  }
})

test('reports incomplete subscription coverage as a collector failure while polling enabled workloads', async () => {
  const syncUpdates: any[] = []
  let discovered: string[] = []
  const prisma: any = {
    syncState: {
      findUnique: async () => null,
      upsert: async () => undefined,
      update: async ({ data }: any) => { syncUpdates.push(data); return data },
    },
    m365ActivityContent: {
      count: async () => 0,
      updateMany: async () => ({ count: 0 }),
      findMany: async () => [],
      deleteMany: async () => ({ count: 0 }),
    },
    m365ActivitySubscription: {
      findMany: async () => [{
        contentType: 'Audit.AzureActiveDirectory',
        status: 'FAILED',
        lastError: 'Tenant does not exist.',
      }],
    },
    m365AuditRecord: { deleteMany: async () => ({ count: 0 }) },
    m365AuditDailyUsage: { deleteMany: async () => ({ count: 0 }) },
    $transaction: async (operations: any) => Promise.all(operations),
  }
  const consent: any = {
    getTenantManagementActivityContext: async () => ({
      accessToken: 'token',
      publisherIdentifier,
    }),
  }
  const service = new M365ManagementActivityService(prisma, consent)
  ;(service as any).ensureSubscriptions = async () => new Set(['Audit.Exchange'])
  ;(service as any).discoverContent = async (
    _tenant: unknown,
    _token: string,
    _publisher: string,
    enabled: Set<string>,
  ) => {
    discovered = [...enabled]
    return false
  }

  await service.syncTenant(tenant)
  assert.deepEqual(discovered, ['Audit.Exchange'])
  assert.equal(syncUpdates.at(-1).status, 'FAILED')
  assert.equal(
    syncUpdates.at(-1).lastErrorCode,
    'm365-audit-subscription-incomplete',
  )
  assert.match(syncUpdates.at(-1).lastErrorMessage, /Audit\.AzureActiveDirectory/)
})

test('treats a daily/monthly budget stop as recoverable backpressure, not a collector failure', async () => {
  const syncUpdates: any[] = []
  const prisma: any = {
    syncState: {
      findUnique: async () => null,
      upsert: async () => undefined,
      update: async ({ data }: any) => { syncUpdates.push(data); return data },
    },
    m365ActivityContent: {
      count: async () => 1,
      updateMany: async () => ({ count: 0 }),
    },
  }
  const consent: any = {
    getTenantManagementActivityContext: async () => ({ accessToken: 'token', publisherIdentifier }),
  }
  const service = new M365ManagementActivityService(prisma, consent)
  ;(service as any).ensureSubscriptions = async () => {
    throw new M365AuditBudgetError('budget reached')
  }
  const changes = await service.syncTenant(tenant)
  assert.deepEqual(changes, [])
  assert.equal(syncUpdates.at(-1).status, 'RUNNING')
  assert.equal(syncUpdates.at(-1).lastErrorCode, 'm365-audit-budget-exhausted')
  assert.equal(syncUpdates.at(-1).consecutiveFailures, 0)
})
