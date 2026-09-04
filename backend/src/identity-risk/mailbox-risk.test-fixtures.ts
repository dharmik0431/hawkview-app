// Synthetic fixtures only. Never imported by runtime modules.
import { createHmac } from 'node:crypto'
import { ManagedHmacPseudonymProvider, type PseudonymKeyVersion } from './identity-risk-pseudonym.js'
import { mailboxSourceDigest, MAILBOX_SOURCE_VERSION, type MailboxSourceResource } from './mailbox-source-attestation.js'
import type { AttestedMailboxSnapshot } from './mailbox-risk-projector.service.js'

export const mailboxScope = { organizationId: '11111111-1111-4111-8111-111111111111', customerTenantId: '22222222-2222-4222-8222-222222222222' }
export const mailboxKey: PseudonymKeyVersion = { ...mailboxScope, id: '44444444-4444-4444-8444-444444444444', environment: 'test',
  provider: 'AWS_KMS_HMAC_256', immutableKeyId: 'arn:aws:kms:us-east-1:000000000000:key/44444444-4444-4444-8444-444444444444' }
export const mailboxNow = new Date('2026-09-03T12:00:00Z')
export const syntheticManagedProvider = () => new ManagedHmacPseudonymProvider({
  describe: async (keyId) => ({ keyId, enabled: true, keySpec: 'HMAC_256', keyUsage: 'GENERATE_VERIFY_MAC' }),
  generateMac: async (keyId, message) => ({ keyId, macAlgorithm: 'HMAC_SHA_256',
    mac: createHmac('sha256', 'SYNTHETIC-TEST-ONLY-NOT-A-DEPLOYABLE-KEY').update(message).digest() }),
})
export function mailboxRule(address = 'partner@outside.invalid', overrides: Record<string, unknown> = {}) {
  return { id: 'rule-1', mailboxUserId: 'mailbox-1', mailboxUpn: 'private@tenant.invalid', isEnabled: true, hasError: false,
    actions: { forwardTo: [{ emailAddress: { address } }] }, ...overrides }
}
export function attested(resourceType: MailboxSourceResource, payload: unknown, observedAt = new Date(mailboxNow.getTime() - 1000)): AttestedMailboxSnapshot {
  return { ...mailboxScope, resourceType, payload, observedAt, state: 'COMPLETE', source: MAILBOX_SOURCE_VERSION,
    digest: mailboxSourceDigest(mailboxScope, resourceType, observedAt, payload), attestedAt: observedAt,
    syncStatus: 'SUCCEEDED', lastSuccessfulAt: observedAt, lastAttemptAt: observedAt }
}
export function mailboxSnapshots(rules: unknown[] = [mailboxRule()]) {
  return [attested('EXCHANGE_MAILBOX_RULES', rules), attested('EXCHANGE_ACCEPTED_DOMAINS', [{ domain: 'tenant.invalid' }])]
}

export function boundedMailboxSnapshots(ruleCount: number, domainCount: number) {
  return [attested('EXCHANGE_MAILBOX_RULES', Array.from({ length: ruleCount }, (_, index) => mailboxRule(undefined, { id: `rule-${index}` }))),
    attested('EXCHANGE_ACCEPTED_DOMAINS', Array.from({ length: domainCount }, (_, index) => ({ domain: `domain-${index}.tenant.invalid` })))]
}
