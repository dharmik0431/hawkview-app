import assert from 'node:assert/strict'
import test from 'node:test'
import { TenantSyncService } from './tenant-sync.service.js'
import {
  buildRelatedExchangeRuleAuditResponse,
  normalizeRelatedExchangeRuleAuditRequest,
  projectRelatedExchangeRuleAuditCandidate,
  RELATED_EXCHANGE_RULE_AUDIT_CANDIDATE_LIMIT,
  RELATED_EXCHANGE_RULE_AUDIT_OPERATIONS,
  RELATED_EXCHANGE_RULE_AUDIT_RESULT_LIMIT,
  RELATED_EXCHANGE_RULE_AUDIT_WINDOW_DAYS,
} from './exchange-rule-related-audit.js'

const now = new Date('2026-08-20T12:00:00.000Z')
const request = normalizeRelatedExchangeRuleAuditRequest('victim@contoso.com', 'Move invoices')!

function row(overrides: Record<string, unknown> = {}) {
  return {
    microsoftRecordId: 'audit-1',
    eventDateTime: '2026-08-20T11:00:00.000Z',
    operation: 'Set-InboxRule',
    actorId: 'admin@contoso.com',
    objectId: 'not-the-rule-id',
    result: 'Succeeded',
    raw: {
      MailboxOwnerUPN: 'victim@contoso.com',
      Parameters: [{ Name: 'RuleName', Value: 'Move invoices' }],
    },
    ...overrides,
  }
}

test('requires exact mailbox and only strengthens a match for an exact rule name', () => {
  const exact = projectRelatedExchangeRuleAuditCandidate(row(), request, now)
  assert.equal(exact?.matchBasis, 'exact_mailbox_and_rule_name')
  assert.equal(exact?.microsoftReportedActor, 'admin@contoso.com')
  assert.equal(exact?.microsoftEventTime, '2026-08-20T11:00:00.000Z')

  const partialName = projectRelatedExchangeRuleAuditCandidate(row({
    raw: {
      MailboxOwnerUPN: 'VICTIM@contoso.com',
      Parameters: [{ Name: 'RuleName', Value: 'Move invoices copy' }],
    },
  }), request, now)
  assert.equal(partialName?.matchBasis, 'exact_mailbox')

  const wrongMailbox = projectRelatedExchangeRuleAuditCandidate(row({
    raw: { MailboxOwnerUPN: 'other@contoso.com', Parameters: [{ Name: 'RuleName', Value: 'Move invoices' }] },
  }), request, now)
  assert.equal(wrongMailbox, null)
})

test('missing correlation name stays mailbox-only while an explicit literal fallback-like Microsoft name can strengthen', () => {
  const mailboxOnlyRequest = normalizeRelatedExchangeRuleAuditRequest('victim@contoso.com', undefined)!
  assert.equal(mailboxOnlyRequest.ruleName, null)
  assert.equal(projectRelatedExchangeRuleAuditCandidate(row(), mailboxOnlyRequest, now)?.matchBasis, 'exact_mailbox')

  const explicitLiteralRequest = normalizeRelatedExchangeRuleAuditRequest(
    'victim@contoso.com',
    'Unnamed inbox rule',
  )!
  const explicitLiteral = projectRelatedExchangeRuleAuditCandidate(row({
    raw: {
      MailboxOwnerUPN: 'victim@contoso.com',
      Parameters: [{ Name: 'RuleName', Value: 'Unnamed inbox rule' }],
    },
  }), explicitLiteralRequest, now)
  assert.equal(explicitLiteral?.matchBasis, 'exact_mailbox_and_rule_name')
})

test('retains duplicate rule-name candidates as possible events without claiming identity', () => {
  const response = buildRelatedExchangeRuleAuditResponse([
    row({ microsoftRecordId: 'audit-1' }),
    row({ microsoftRecordId: 'audit-2', operation: 'New-InboxRule' }),
  ], request, { now })
  assert.deepEqual(response.events.map((event) => event.id), ['audit-1', 'audit-2'])
  assert.ok(response.events.every((event) => event.kind === 'possible_related_microsoft_audit_event'))
  assert.match(response.disclaimer, /do not prove/)
  assert.doesNotMatch(JSON.stringify(response), /Created by|Created at|current rule actor/i)
})

test('fails closed for unsupported operations, unsafe values and raw secrets', () => {
  assert.equal(projectRelatedExchangeRuleAuditCandidate(row({ operation: 'MoveToDeletedItems' }), request, now), null)
  const projected = projectRelatedExchangeRuleAuditCandidate(row({
    actorId: 'password=hunter2',
    result: 'access_token=secret',
    raw: {
      MailboxOwnerUPN: 'victim@contoso.com',
      Parameters: [
        { Name: 'RuleName', Value: 'Move invoices' },
        { Name: 'client_secret', Value: 'must-not-leak' },
      ],
      access_token: 'raw-secret',
    },
  }), request, now)
  assert.equal(projected?.microsoftReportedActor, null)
  assert.equal(projected?.result, null)
  assert.doesNotMatch(JSON.stringify(projected), /hunter2|secret|must-not-leak|access_token/)
})

test('bounds result count independently from the bounded candidate scan', () => {
  const response = buildRelatedExchangeRuleAuditResponse(
    Array.from({ length: RELATED_EXCHANGE_RULE_AUDIT_RESULT_LIMIT + 2 }, (_, index) => row({ microsoftRecordId: `audit-${index}` })),
    request,
    { now },
  )
  assert.equal(response.events.length, RELATED_EXCHANGE_RULE_AUDIT_RESULT_LIMIT)
  assert.equal(response.truncated, true)
})

test('service scopes the indexed query by authorized organization, tenant, time and exact operations', async () => {
  const organizationId = '11111111-1111-4111-8111-111111111111'
  const customerTenantId = '22222222-2222-4222-8222-222222222222'
  let auditQuery: any = null
  const prisma = {
    user: {
      findUnique: async () => ({
        disabledAt: null,
        memberships: [{ organizationId }],
      }),
    },
    customerTenant: {
      findFirst: async ({ where }: any) => {
        assert.equal(where.id, customerTenantId)
        assert.deepEqual(where.organizationId.in, [organizationId])
        return {
          id: customerTenantId,
          organizationId,
          microsoftTenantId: '33333333-3333-4333-8333-333333333333',
          displayName: 'Contoso',
          primaryDomain: 'contoso.com',
          status: 'ACTIVE',
          connection: null,
        }
      },
    },
    m365AuditRecord: {
      findMany: async (query: any) => {
        auditQuery = query
        return [row({ eventDateTime: new Date(Date.now() - 60_000) })]
      },
    },
  }
  const service = new TenantSyncService(
    prisma as never, {} as never, {} as never, {} as never, {} as never, {} as never,
  )
  const response = await service.getRelatedExchangeRuleAuditForIdentity(
    { subject: 'auth-user' } as never,
    customerTenantId,
    'victim@contoso.com',
    'Move invoices',
  )

  assert.equal(auditQuery.where.organizationId, organizationId)
  assert.equal(auditQuery.where.customerTenantId, customerTenantId)
  assert.deepEqual(auditQuery.where.operation.in, [...RELATED_EXCHANGE_RULE_AUDIT_OPERATIONS])
  assert.equal(auditQuery.take, RELATED_EXCHANGE_RULE_AUDIT_CANDIDATE_LIMIT + 1)
  assert.equal(auditQuery.orderBy.eventDateTime, 'desc')
  const querySpanDays = (auditQuery.where.eventDateTime.lte.getTime() - auditQuery.where.eventDateTime.gte.getTime()) / 86_400_000
  assert.equal(querySpanDays, RELATED_EXCHANGE_RULE_AUDIT_WINDOW_DAYS)
  assert.equal(response.events.length, 1)
})

test('authorization failure prevents any audit-record query across organizations', async () => {
  let auditQueried = false
  const prisma = {
    user: { findUnique: async () => ({ disabledAt: null, memberships: [{ organizationId: 'org-a' }] }) },
    customerTenant: { findFirst: async () => null },
    m365AuditRecord: { findMany: async () => { auditQueried = true; return [] } },
  }
  const service = new TenantSyncService(
    prisma as never, {} as never, {} as never, {} as never, {} as never, {} as never,
  )
  await assert.rejects(
    service.getRelatedExchangeRuleAuditForIdentity(
      { subject: 'auth-user' } as never,
      'tenant-in-other-org',
      'victim@contoso.com',
      'Move invoices',
    ),
    /Customer tenant was not found/,
  )
  assert.equal(auditQueried, false)
})
