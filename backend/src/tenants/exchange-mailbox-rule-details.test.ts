import assert from 'node:assert/strict'
import test from 'node:test'
import { TenantSyncService } from './tenant-sync.service.js'
import {
  exchangeMailboxRuleCompoundId,
  projectExchangeMailboxRuleDetails,
  safeExchangeMailboxRuleCollectedAt,
  safeExchangeMailboxRuleText,
  summarizeExchangeMailboxRuleActions,
} from './exchange-mailbox-rule-details.js'

test('projects internal and external forwarding destinations without inferring risk or causation', () => {
  const details = projectExchangeMailboxRuleDetails({
    conditions: {
      fromAddresses: [{ emailAddress: { name: 'Accounts', address: 'billing@contoso.com' } }],
      subjectContains: ['Invoice', 'Urgent'],
    },
    actions: {
      forwardTo: [
        { emailAddress: { name: 'Internal Review', address: 'review@contoso.com' } },
        { emailAddress: { name: 'External Archive', address: 'archive@example.net' } },
      ],
      redirectTo: [{ emailAddress: { address: 'redirect@example.org' } }],
    },
  })

  assert.deepEqual(details.conditions.map(({ key, values }) => ({ key, values })), [
    { key: 'fromAddresses', values: ['Accounts <billing@contoso.com>'] },
    { key: 'subjectContains', values: ['Invoice', 'Urgent'] },
  ])
  assert.deepEqual(details.actions.map(({ key, values, emphasis }) => ({ key, values, emphasis })), [
    {
      key: 'forwardTo',
      values: ['Internal Review <review@contoso.com>', 'External Archive <archive@example.net>'],
      emphasis: 'destination',
    },
    { key: 'redirectTo', values: ['redirect@example.org'], emphasis: 'destination' },
  ])
  assert.doesNotMatch(JSON.stringify(details), /risk|compromis|actor|caus/i)
})

test('projects multiple move, copy, delete, read-state and processing actions truthfully', () => {
  const details = projectExchangeMailboxRuleDetails({
    conditions: {
      hasAttachments: true,
      importance: 'high',
      recipientContains: ['@contoso.com'],
      withinSizeRange: { minimumSize: 64, maximumSize: 2048 },
    },
    exceptions: {
      recipientContains: ['service@example.net'],
      senderContains: ['trusted.example'],
      withinSizeRange: { minimumSize: 1, maximumSize: 32 },
    },
    actions: {
      copyToFolder: 'Archive',
      delete: true,
      markAsRead: true,
      moveToFolder: 'Deleted Items',
      permanentDelete: true,
      stopProcessingRules: true,
    },
  })

  assert.deepEqual(details.conditions.map((fact) => fact.key), ['hasAttachments', 'importance', 'recipientContains', 'withinSizeRange'])
  assert.deepEqual(details.exceptions.map((fact) => fact.key), ['recipientContains', 'senderContains', 'withinSizeRange'])
  assert.deepEqual(details.conditions.find((fact) => fact.key === 'withinSizeRange')?.values, ['Minimum 64 KB', 'Maximum 2048 KB'])
  assert.deepEqual(details.exceptions.find((fact) => fact.key === 'withinSizeRange')?.values, ['Minimum 1 KB', 'Maximum 32 KB'])
  assert.deepEqual(details.actions.map((fact) => fact.key), [
    'copyToFolder', 'delete', 'markAsRead', 'moveToFolder', 'permanentDelete', 'stopProcessingRules',
  ])
  assert.equal(details.actions.find((fact) => fact.key === 'moveToFolder')?.values[0], 'Deleted Items')
  assert.match(summarizeExchangeMailboxRuleActions(details) ?? '', /Copy to folder ID: Archive/)
  assert.match(summarizeExchangeMailboxRuleActions(details) ?? '', /Move message to Deleted Items/)
})

test('backend safe-string policy rejects unsafe and encoded URL secrets while preserving rule evidence', () => {
  const rejected = [
    'javascript:alert(1)',
    'data:text/plain,secret',
    'https://user:pass@example.com/path?credential=hunter2',
    'https://example.com/path?token=secret',
    'https://example.com/path?sig=secret',
    'https://example.com/path?code=secret',
    'https://example.com/path?%74oken=secret',
    'https://example.com/path?value=access_token%3Dsecret',
    'Message contains https://example.com/path?token=secret',
    'https%3A%2F%2Fexample.com%2Fpath%3Fcredential%3Dhunter2',
    'https%253A%252F%252Fexample.com%252Fpath%253Fsig%253Dsecret',
    'javascript%253Aalert(1)',
    'https://example.com/path#token',
  ]
  for (const value of rejected) assert.equal(safeExchangeMailboxRuleText(value), null, value)

  for (const value of ['user@contoso.com', 'contoso.com', 'AQMkADAwATM0MDAAMS0wMAItAAAAAA==', 'RE: quarterly invoice']) {
    assert.equal(safeExchangeMailboxRuleText(value), value)
  }
})

test('accepts only valid non-future snapshot observation timestamps', () => {
  const now = new Date('2026-08-20T12:00:00.000Z')
  assert.equal(
    safeExchangeMailboxRuleCollectedAt(new Date('2026-08-20T11:45:00.000Z'), now),
    '2026-08-20T11:45:00.000Z',
  )
  assert.equal(safeExchangeMailboxRuleCollectedAt('2026-08-20T11:45:00.000Z', now), '2026-08-20T11:45:00.000Z')
  assert.equal(safeExchangeMailboxRuleCollectedAt('2026-08-20T12:00:00.001Z', now), null)
  assert.equal(safeExchangeMailboxRuleCollectedAt('not-a-date', now), null)
  assert.equal(safeExchangeMailboxRuleCollectedAt('August 20, 2026 11:45 UTC', now), null)
  assert.equal(safeExchangeMailboxRuleCollectedAt('2026-08-20T11:45:00Z', now), null)
  assert.equal(safeExchangeMailboxRuleCollectedAt('2026-08-20T11:45:00.000Z\u0000', now), null)
  assert.equal(safeExchangeMailboxRuleCollectedAt({ toISOString: () => '2026-08-20T11:45:00.000Z' }, now), null)
})

test('returns an explicit empty detail contract when Microsoft did not provide usable values', () => {
  assert.deepEqual(projectExchangeMailboxRuleDetails(null), { conditions: [], exceptions: [], actions: [] })
  assert.deepEqual(projectExchangeMailboxRuleDetails({
    conditions: { subjectContains: [], hasAttachments: false },
    actions: { forwardTo: [], delete: false },
  }), { conditions: [], exceptions: [], actions: [] })
})

test('drops hostile and arbitrary nested data while bounding arrays and preserving safe values', () => {
  const patterns = [
    'safe-1',
    'access_token=do-not-return',
    'Bearer eyJhbGciOiJIUzI1NiJ9.secret.signature',
    'control\u0000text',
    ...Array.from({ length: 24 }, (_, index) => `safe-${index + 2}`),
  ]
  const details = projectExchangeMailboxRuleDetails({
    conditions: {
      subjectContains: patterns,
      unknownCondition: { access_token: 'raw-secret' },
    },
    actions: {
      forwardTo: [
        { emailAddress: { address: 'safe@example.net' } },
        { emailAddress: { address: 'password=hunter2' } },
        { arbitrary: { nested: 'not-allowed' } },
      ],
      moveToFolder: 'x'.repeat(321),
      unknownAction: { client_secret: 'raw-secret' },
    },
    access_token: 'top-level-secret',
  })

  const serialized = JSON.stringify(details)
  assert.doesNotMatch(serialized, /do-not-return|hunter2|raw-secret|client_secret|access_token|unknownAction|unknownCondition/)
  assert.equal(details.conditions[0]?.key, 'subjectContains')
  assert.equal(details.conditions[0]?.truncated, true)
  assert.ok((details.conditions[0]?.values.length ?? 0) <= 20)
  assert.deepEqual(details.actions[0]?.values, ['safe@example.net'])
  assert.equal(details.actions.some((fact) => fact.key === 'moveToFolder'), false)

  const inherited = Object.create({ subjectContains: ['inherited'] })
  assert.deepEqual(projectExchangeMailboxRuleDetails({ conditions: inherited }).conditions, [])
})

test('preserves compound mailbox and Microsoft rule identity', () => {
  assert.equal(exchangeMailboxRuleCompoundId({ mailboxUserId: 'mailbox-1', id: 'rule-1' }), 'mailbox-1::rule-1')
  assert.equal(exchangeMailboxRuleCompoundId({ id: 'rule-only' }), 'rule-only')
  assert.equal(exchangeMailboxRuleCompoundId({ mailboxUserId: 'mailbox-1', id: 'access_token=secret' }), null)
})

test('tenant bundle scopes the rule snapshot by organization and tenant and emits only the safe projection', async () => {
  const expectedScope = { organizationId: 'org-1', customerTenantId: 'tenant-1' }
  const scoped = (where: Record<string, unknown>) => {
    assert.equal(where.organizationId, expectedScope.organizationId)
    assert.equal(where.customerTenantId, expectedScope.customerTenantId)
  }
  const successfulAt = new Date('2026-08-19T12:00:00.000Z')
  const snapshots = [{
    resourceType: 'EXCHANGE_MAILBOX_RULES',
    observedAt: successfulAt,
    payload: [{
      id: 'rule-1', mailboxUserId: 'mailbox-1', mailboxUpn: 'user@contoso.com',
      displayName: 'Forward invoices', sequence: 2, isEnabled: true, hasError: false, isReadOnly: true,
      conditions: {
        recipientContains: ['@contoso.com'],
        subjectContains: ['Invoice'],
        withinSizeRange: { minimumSize: 64, maximumSize: 2048 },
        injected: { token: 'secret' },
      },
      exceptions: {
        recipientContains: ['service@example.net'],
        withinSizeRange: { minimumSize: 1, maximumSize: 32 },
      },
      actions: { forwardTo: [{ emailAddress: { address: 'audit@example.net' } }], injected: { token: 'secret' } },
      rawSecret: 'must-not-serialize',
    }, {
      id: 'rule-2', mailboxUserId: 'mailbox-1', mailboxUpn: 'user@contoso.com',
      displayName: 'Microsoft omitted state', conditions: {}, actions: {},
    }],
  }]
  const prisma = {
    directoryUser: { findMany: async ({ where }: any) => (scoped(where), []) },
    directoryGroup: { findMany: async ({ where }: any) => (scoped(where), []) },
    tenantLicense: { findMany: async ({ where }: any) => (scoped(where), []) },
    tenantDomain: { findMany: async ({ where }: any) => (scoped(where), []) },
    syncState: { findMany: async ({ where }: any) => {
      assert.equal(where.customerTenantId, expectedScope.customerTenantId)
      return [{ resourceType: 'EXCHANGE_MAILBOX_RULES', status: 'SUCCEEDED', lastAttemptAt: successfulAt, lastSuccessfulAt: successfulAt }]
    } },
    tenantEntraSnapshot: { findMany: async ({ where }: any) => (scoped(where), snapshots) },
    tenantCollectionFieldState: { findMany: async ({ where }: any) => (scoped(where), []) },
    signInLog: { findMany: async ({ where }: any) => (scoped(where), []) },
    directoryAuditLog: { findMany: async ({ where }: any) => (scoped(where), []) },
    m365ActivitySubscription: { findMany: async ({ where }: any) => (scoped(where), []) },
    m365ActivityContent: {
      groupBy: async ({ where }: any) => (scoped(where), []),
      findFirst: async ({ where }: any) => (scoped(where), null),
    },
    m365AuditDailyUsage: {
      findUnique: async ({ where }: any) => {
        assert.equal(where.customerTenantId_usageDate.customerTenantId, expectedScope.customerTenantId)
        return null
      },
      aggregate: async ({ where }: any) => (scoped(where), { _sum: { downloadedBytes: null, recordsStored: null, blobsProcessed: null } }),
    },
  }
  const service = new TenantSyncService(
    prisma as never, {} as never, {} as never, {} as never, {} as never, {} as never
  )
  const result = await (service as any).buildBundle({
    id: expectedScope.customerTenantId,
    organizationId: expectedScope.organizationId,
    microsoftTenantId: '11111111-1111-4111-8111-111111111111',
    displayName: 'Contoso', primaryDomain: 'contoso.com', status: 'CONNECTED',
    connection: { lastVerifiedAt: successfulAt },
  })
  const rule = result.bundle.exchange.rules[0]

  assert.equal(rule.id, 'mailbox-1::rule-1')
  assert.equal(rule.mailboxUserId, 'mailbox-1')
  assert.equal(rule.description, 'Forward to: audit@example.net')
  assert.equal(rule.configurationCollectedAt, '2026-08-19T12:00:00.000Z')
  assert.equal(rule.hasError, false)
  assert.equal(rule.isReadOnly, true)
  assert.deepEqual(rule.conditions, ['recipientContains', 'subjectContains', 'withinSizeRange'])
  assert.deepEqual(rule.exceptions, ['recipientContains', 'withinSizeRange'])
  assert.deepEqual(rule.actions, ['forwardTo'])
  assert.deepEqual(rule.details.actions[0].values, ['audit@example.net'])
  assert.deepEqual(rule.details.conditions.find((fact: any) => fact.key === 'recipientContains')?.values, ['@contoso.com'])
  assert.deepEqual(rule.details.conditions.find((fact: any) => fact.key === 'withinSizeRange')?.values, ['Minimum 64 KB', 'Maximum 2048 KB'])
  assert.deepEqual(rule.details.exceptions.find((fact: any) => fact.key === 'recipientContains')?.values, ['service@example.net'])
  assert.deepEqual(rule.details.exceptions.find((fact: any) => fact.key === 'withinSizeRange')?.values, ['Minimum 1 KB', 'Maximum 32 KB'])
  assert.doesNotMatch(JSON.stringify(rule), /must-not-serialize|rawSecret|injected|secret/)
  assert.equal(result.bundle.exchange.rules[1].enabled, null)
  assert.equal(result.bundle.exchange.rules[1].priority, null)
  assert.equal(result.bundle.exchange.rules[1].description, null)
  assert.equal(result.bundle.exchange.rules[1].hasError, null)
  assert.equal(result.bundle.exchange.rules[1].isReadOnly, null)
  assert.equal(result.bundle.exchange.rules[1].configurationCollectedAt, '2026-08-19T12:00:00.000Z')
  assert.deepEqual(result.bundle.exchange.rules[1].details, { conditions: [], exceptions: [], actions: [] })
})
