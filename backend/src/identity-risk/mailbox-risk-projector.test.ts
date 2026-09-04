import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { projectMailboxEvidence, MailboxRiskProjector, MAILBOX_FIRST_SLICE_FLAGS } from './mailbox-risk-projector.service.js'
import { mailboxSourceDigest, verifiedOrganizationDomains, MAILBOX_SOURCE_MAX_AGE_MS, MAILBOX_PROJECTOR_MAX_RULES } from './mailbox-source-attestation.js'
import { IdentityRiskPseudonymProvider } from './identity-risk-pseudonym.js'
import { approvedIdentitySignalDetectors } from './identity-risk-approved-evaluator.adapter.js'
import { mailboxScope, mailboxKey, mailboxNow, syntheticManagedProvider, mailboxRule, mailboxSnapshots, attested } from './mailbox-risk.test-fixtures.js'
import type { PrismaService } from '../prisma/prisma.service.js'

const session = () => syntheticManagedProvider().pin(mailboxKey, Date.now() + 30000)
async function evaluate(rules: unknown[]) {
  const batch = await projectMailboxEvidence(mailboxScope, mailboxNow, mailboxSnapshots(rules), await session())
  const detectors = approvedIdentitySignalDetectors({ readiness: 'READY', featureFlags: MAILBOX_FIRST_SLICE_FLAGS })
  assert.equal(detectors.length, 1)
  const results = await detectors[0]!.evaluate({ ...batch.context, capability: batch.capability,
    sources: { EXCHANGE_MAILBOX_RULES: batch.sourceEnvelopes.map((row) => row.payload) } })
  return { batch, results }
}

test('only MBX001: outside exact verified domains is an investigation lead, not compromise', async () => {
  for (const address of ['partner@outside.invalid', 'partner@sub.tenant.invalid']) {
    const { batch, results } = await evaluate([mailboxRule(address)])
    assert.equal(batch.capability, 'FULL')
    assert.equal(results[0]?.outcome, 'MATCHED')
    assert.equal(results[0]?.severity, 'HIGH')
    assert.match(results[0]?.subjectId ?? '', /^hvr1_mailbox_[a-f0-9]{64}$/)
    assert.doesNotMatch(JSON.stringify(results), /partner@|mailbox-1|private@/)
    assert.equal(batch.pseudonymKeyVersionId, mailboxKey.id)
  }
  for (const rule of [mailboxRule('user@TENANT.invalid'), mailboxRule(undefined, { isEnabled: false }), mailboxRule(undefined, { actions: { markAsRead: true } })]) {
    assert.equal((await evaluate([rule])).results[0]?.outcome, 'NOT_MATCHED')
  }
})

test('multiple actions, mailbox-local rule IDs, IDNA and replay remain deterministic', async () => {
  const rows = [mailboxRule(), mailboxRule('other@outside.invalid', { mailboxUserId: 'mailbox-2' })]
  const first = await evaluate(rows)
  const second = await evaluate([...rows].reverse())
  assert.deepEqual(first.batch.sourceEnvelopes, second.batch.sourceEnvelopes)
  assert.notEqual(first.results[0]?.subjectId, first.results[1]?.subjectId)
  assert.equal((await evaluate([mailboxRule(undefined, { actions: { redirectTo: [{ emailAddress: { address: 'a@outside.invalid' } }], forwardAsAttachmentTo: [{ emailAddress: { address: 'b@tenant.invalid' } }] } })])).results[0]?.outcome, 'MATCHED')
  const snapshots = mailboxSnapshots([mailboxRule('a@bücher.invalid')])
  snapshots[1] = attested('EXCHANGE_ACCEPTED_DOMAINS', [{ domain: 'xn--bcher-kva.invalid' }])
  const batch = await projectMailboxEvidence(mailboxScope, mailboxNow, snapshots, await session())
  const candidate = batch.sourceEnvelopes[0]!.payload.candidate
  assert.ok('recipientAddresses' in candidate)
  assert.deepEqual(candidate.recipientAddresses, ['a@xn--bcher-kva.invalid'])
})

test('legacy, malformed, capped, failed, partial, foreign and filtered-to-empty never become clean', async () => {
  for (const modify of [
    (rows: ReturnType<typeof mailboxSnapshots>) => { rows[0]!.digest = null },
    (rows: ReturnType<typeof mailboxSnapshots>) => { rows[0]!.state = 'PARTIAL' },
    (rows: ReturnType<typeof mailboxSnapshots>) => { rows[0]!.syncStatus = 'FAILED' },
    (rows: ReturnType<typeof mailboxSnapshots>) => { rows[0]!.attestedAt = new Date(0) },
    (rows: ReturnType<typeof mailboxSnapshots>) => { rows[0]!.payload = [] },
    (rows: ReturnType<typeof mailboxSnapshots>) => { rows[1]!.payload = [] },
    (rows: ReturnType<typeof mailboxSnapshots>) => { rows[0]!.payload = null },
    (rows: ReturnType<typeof mailboxSnapshots>) => { rows[0]!.payload = Array(MAILBOX_PROJECTOR_MAX_RULES + 1).fill(mailboxRule()) },
  ]) {
    const rows = mailboxSnapshots(); modify(rows)
    assert.equal((await projectMailboxEvidence(mailboxScope, mailboxNow, rows, await session())).capability, 'UNAVAILABLE')
  }
  for (const overrides of [{ actions: null }, { isEnabled: undefined }, { hasError: true }, { actions: { forwardTo: [{ emailAddress: {} }] } }]) {
    assert.equal(mailboxSourceDigest(mailboxScope, 'EXCHANGE_MAILBOX_RULES', mailboxNow, [mailboxRule(undefined, overrides)]), null)
  }
  const foreign = mailboxSnapshots(); foreign[0]!.organizationId = mailboxKey.id
  await assert.rejects(() => session().then((key) => projectMailboxEvidence(mailboxScope, mailboxNow, foreign, key)), /SOURCE_SCOPE_INVALID/)
  assert.equal((await evaluate([])).batch.capability, 'FULL')
  assert.equal((await evaluate([])).results.length, 0) // Complete empty inventory: no fabricated subjects.
})

test('36-hour and future-skew boundaries are source-based; replay cannot refresh retention', async () => {
  for (const [age, expected] of [[MAILBOX_SOURCE_MAX_AGE_MS, 'FULL'], [MAILBOX_SOURCE_MAX_AGE_MS + 1, 'UNAVAILABLE'], [-300000, 'FULL'], [-300001, 'UNAVAILABLE']] as const) {
    const observed = new Date(mailboxNow.getTime() - age)
    const rows = [attested('EXCHANGE_MAILBOX_RULES', [mailboxRule()], observed), attested('EXCHANGE_ACCEPTED_DOMAINS', [{ domain: 'tenant.invalid' }], observed)]
    const batch = await projectMailboxEvidence(mailboxScope, mailboxNow, rows, await session())
    assert.equal(batch.capability, expected)
    if (expected === 'FULL') assert.equal(batch.earliestSourceExpiry?.getTime(), observed.getTime() + MAILBOX_SOURCE_MAX_AGE_MS)
  }
})

test('organization response rejects missing/foreign/multiple organizations and malformed domains without filtering', () => {
  const good = { value: [{ id: mailboxScope.customerTenantId, verifiedDomains: [{ name: 'tenant.invalid' }] }] }
  assert.equal(verifiedOrganizationDomains(good, mailboxScope.customerTenantId).length, 1)
  for (const bad of [{}, { value: [] }, { value: [good.value[0], good.value[0]] }, { value: [{ ...good.value[0], id: mailboxScope.organizationId }] },
    { value: [{ ...good.value[0], verifiedDomains: [{ name: 'tenant.invalid' }, { name: null }] }] },
    { value: [{ ...good.value[0], verifiedDomains: [{ name: 'tenant.invalid' }, { name: 'TENANT.invalid' }] }] }]) {
    assert.throws(() => verifiedOrganizationDomains(bad, mailboxScope.customerTenantId), /Microsoft verified-domain/)
  }
})

test('unconfigured provider prevents even registry/source reads; no hidden fake or fallback', async () => {
  const prisma = new Proxy({}, { get: () => { throw new Error('Unexpected database read') } }) as PrismaService
  await assert.rejects(() => new MailboxRiskProjector(prisma, new IdentityRiskPseudonymProvider()).load(mailboxScope, mailboxNow), /KEY_UNAVAILABLE/)
  const source = readFileSync(new URL('./mailbox-risk-projector.service.ts', import.meta.url), 'utf8')
  assert.match(source, /octet_length\(s\.payload::text\)/)
  assert.match(source, /isolationLevel: 'RepeatableRead'/)
  assert.match(source, /s\.organization_id=\$\{scope.organizationId\}/)
  assert.doesNotMatch(source, /fetch\(|accessToken|signInLog|riskyUser/)
})
