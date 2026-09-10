import assert from 'node:assert/strict'
import test from 'node:test'
import { evaluate } from '../evaluate.js'
import { externalForwardingDetector, type MailboxForwardingArtefact } from './external-forwarding.js'
import type { Coverage } from '../contract.js'
import { figure } from '../test-support.js'

/** Defaults to a mailbox whose binding RESOLVED and said "not a person" — a
 * proven shared or resource mailbox. That is the case where a user count of zero
 * is exactly true. The unresolved case is written out explicitly where it is
 * meant, so no test asserts a confident zero by accident. */
const mailbox = (ref: string, parts: Partial<MailboxForwardingArtefact> = {}): MailboxForwardingArtefact => ({
  subject: { kind: 'MAILBOX', mailboxRef: ref, binding: 'RESOLVED_NEGATIVE' },
  observedAt: '2026-09-10T00:00:00.000Z',
  forwardingSmtpAddress: null,
  forwardingAddress: null,
  deliverToMailboxAndForward: false,
  rules: [],
  ...parts,
})

const rule = (parts: Partial<MailboxForwardingArtefact['rules'][number]> = {}) => ({
  enabled: true, redirectTo: [], forwardTo: [], forwardAsAttachmentTo: [], ...parts,
})

const detector = externalForwardingDetector({ verifiedDomains: ['contoso.com', 'Contoso.co.uk'] })
const coverage = (applies: number, parts: Partial<Coverage> = {}): Coverage =>
  ({ collectionScope: { declared: true, asked: 'test fixture: all rows' }, applies, doesNotApply: {}, unknown: {}, unprocessable: {}, ...parts })

const assess = (mailboxes: readonly MailboxForwardingArtefact[], detectors = [detector]) =>
  evaluate<MailboxForwardingArtefact>({
    evidence: { availability: 'READ', applies: mailboxes, coverage: coverage(mailboxes.length), timeOf: () => 0 },
    detectors, budget: { maxEvents: 500 },
  })

test('forwarding outside the tenant is found wherever Exchange reports it', () => {
  const found = [
    mailbox('a', { forwardingSmtpAddress: 'exfil@evil.example' }),
    mailbox('b', { forwardingAddress: 'exfil@evil.example' }),
    mailbox('c', { rules: [rule({ redirectTo: ['exfil@evil.example'] })] }),
    mailbox('d', { rules: [rule({ forwardTo: ['exfil@evil.example'] })] }),
    mailbox('e', { rules: [rule({ forwardAsAttachmentTo: ['exfil@evil.example'] })] }),
  ]
  const result = assess(found)
  assert.deepEqual(
    result.findings.items.map(finding => finding.subject.kind === 'MAILBOX' ? finding.subject.mailboxRef : null).sort(),
    ['a', 'b', 'c', 'd', 'e'])
  // Five mailboxes found, and zero *users* — exactly, because every mailbox was
  // read and the detector ran. None of these were bound to a directory user, so
  // none may be counted as a person. The findings are reported in full; it is
  // the user total they stay out of.
  assert.deepEqual(figure(result.count), { accuracy: 'EXACT', value: 0 })
  assert.equal(result.findings.items.length, 5)
})

test('a zero user count beside real findings is coherent when the mailbox is provably not a person', () => {
  // Binding resolved and said "resource mailbox". Zero people really are
  // affected, and the finding is still reported. The count answers "how many
  // people", the findings answer "what did we find" — different questions.
  const result = assess([mailbox('reception-room', { forwardingSmtpAddress: 'exfil@evil.example' })])
  assert.deepEqual(figure(result.count), { accuracy: 'EXACT', value: 0 })
  assert.equal(result.findings.items.length, 1)
  assert.equal(result.claim.permitted, true)
})

test('a mailbox we could not attribute refuses the exact zero rather than implying nobody', () => {
  // The other half, and the one that was a real defect before this. Binding was
  // attempted and failed, so we found something and cannot say whether a person
  // is behind it. The honest answer is not zero — it is unknown, between zero
  // and one — so the exact claim is refused instead of reading as "nobody".
  const unattributed = mailbox('orphan', { forwardingSmtpAddress: 'exfil@evil.example' })
  const result = assess([{ ...unattributed, subject: { kind: 'MAILBOX', mailboxRef: 'orphan', binding: 'UNRESOLVED' } }])
  assert.equal(result.findings.items.length, 1, 'still found, still reported')
  assert.deepEqual(result.claim, { permitted: false, because: ['UNRESOLVED_SUBJECT_IDENTITY'] })
  assert.deepEqual(figure(result.count), { accuracy: 'NOT_AVAILABLE', value: null })

  // And it does not erase what we could attribute: a known user still yields a
  // floor. One person for certain, possibly two — never "exactly one".
  const withKnownUser = evaluate<MailboxForwardingArtefact>({
    evidence: {
      availability: 'READ',
      applies: [{ ...unattributed, subject: { kind: 'MAILBOX', mailboxRef: 'orphan', binding: 'UNRESOLVED' } }],
      coverage: coverage(1),
      timeOf: () => 0,
    },
    detectors: [detector, {
      id: 'user-side',
      monotonic: true,
      run: () => ({
        status: 'RAN' as const, considered: 1, declined: {},
        findings: [{
          detectorId: 'user-side',
          subject: { kind: 'DIRECTORY_USER', userRef: 'alice', correlation: { available: true, shape: 'DIRECTORY_OBJECT_ID', ref: 'guid-alice' } } as const,
          observedAt: '2026-09-10T00:00:00.000Z',
        }],
      }),
    }],
    budget: { maxEvents: 500 },
  })
  assert.deepEqual(figure(withKnownUser.count), { accuracy: 'AT_LEAST', value: 1 })
})

test('a mailbox that resolved to a real person counts as that person', () => {
  // Promotion happens in the layer that can query the directory; the detector
  // passes the resolved subject through untouched.
  const bound = mailbox('alice-mailbox', { forwardingSmtpAddress: 'exfil@evil.example' })
  const result = assess([{
    ...bound,
    subject: {
      kind: 'DIRECTORY_USER',
      userRef: 'alice',
      // Graph evidence, so the directory object id is available and this user
      // can be matched against Microsoft's own risk channel.
      correlation: { available: true, shape: 'DIRECTORY_OBJECT_ID', ref: 'guid-alice' },
    },
  }])
  assert.deepEqual(figure(result.count), { accuracy: 'EXACT', value: 1 })
  assert.equal(result.claim.permitted, true)
})

test('a subject can say it has no correlation key rather than leaving the field empty', () => {
  // The audit-log path has no directory GUID and resolves by UPN, and a tenant
  // without Entra ID P2 has no Microsoft risk channel to correlate against at
  // all. Both are true statements about capability, and an absent field would
  // have rendered as "Microsoft did not report this user" — which on one tenant
  // would have been wrong 919 times, because Microsoft did report them, through
  // sign-in logs rather than the risk API.
  const upnBound = mailbox('audit-tenant', { forwardingSmtpAddress: 'exfil@evil.example' })
  const byUpn = assess([{
    ...upnBound,
    subject: {
      kind: 'DIRECTORY_USER',
      userRef: 'alice',
      correlation: { available: true, shape: 'USER_PRINCIPAL_NAME', ref: 'opaque-upn-handle' },
    },
  }])
  assert.deepEqual(figure(byUpn.count), { accuracy: 'EXACT', value: 1 })

  const noChannel = assess([{
    ...upnBound,
    subject: {
      kind: 'DIRECTORY_USER',
      userRef: 'alice',
      correlation: { available: false, because: "Microsoft's risky-users channel requires Entra ID P2." },
    },
  }])
  // It does not withhold the claim: not being able to cross-check Microsoft is
  // a limit on what we can *say about* the finding, not on the finding itself.
  assert.deepEqual(figure(noChannel.count), { accuracy: 'EXACT', value: 1 })
  assert.equal(noChannel.claim.permitted, true)
  const subject = noChannel.findings.items[0]?.subject
  assert.equal(subject?.kind === 'DIRECTORY_USER' && subject.correlation.available, false)
})

test('adding a mailbox finding never moves the user count, colliding ref or not', () => {
  // Note on how this is built: asserting only the colliding case would pass even
  // if the two namespaces were compared as bare strings, because merging a
  // colliding mailbox into an existing user also yields 1. The non-colliding
  // case is what actually discriminates, so both are here.
  const userSide = (userRef: string) => ({
    id: `user-${userRef}`,
    monotonic: true,
    // Reports what it was actually handed. An earlier version claimed to have
    // considered one event even when given none, which the core now rejects as
    // an account it cannot trust — it caught this fixture immediately.
    run: (applicable: readonly MailboxForwardingArtefact[]) => ({
      status: 'RAN' as const,
      considered: applicable.length,
      declined: {},
      findings: [{
        detectorId: `user-${userRef}`,
        subject: { kind: 'DIRECTORY_USER', userRef, correlation: { available: true, shape: 'DIRECTORY_OBJECT_ID', ref: 'guid-' + userRef } } as const,
        observedAt: '2026-09-10T00:00:00.000Z',
      }],
    }),
  })
  // Always at least one mailbox, so the user-side detector has something to have
  // looked at. The variable under test is which *extra* mailbox is present.
  const benign = mailbox('nothing-to-see', { forwardingSmtpAddress: 'colleague@contoso.com' })
  const withMailboxes = (mailboxes: readonly MailboxForwardingArtefact[]) => evaluate<MailboxForwardingArtefact>({
    evidence: {
      availability: 'READ',
      applies: [benign, ...mailboxes],
      coverage: coverage(mailboxes.length + 1),
      timeOf: () => 0,
    },
    detectors: [detector, userSide('shared-billing')],
    budget: { maxEvents: 500 },
  })

  const exfiltrating = (ref: string) => mailbox(ref, { forwardingSmtpAddress: 'exfil@evil.example' })
  assert.deepEqual(figure(withMailboxes([]).count), { accuracy: 'EXACT', value: 1 })
  // A mailbox whose ref happens to spell the same string as a user is still a
  // mailbox — it is not evidence of a second person, nor of that person.
  assert.deepEqual(figure(withMailboxes([exfiltrating('shared-billing')]).count), { accuracy: 'EXACT', value: 1 })
  // And an unrelated mailbox does not become a second person either. This is the
  // case that fails if the two namespaces are ever compared as bare strings.
  assert.deepEqual(figure(withMailboxes([exfiltrating('reception-room')]).count), { accuracy: 'EXACT', value: 1 })
  assert.equal(withMailboxes([exfiltrating('reception-room')]).findings.items.length, 2, 'still reported, just not counted')
})

test('the tenant\'s own domains are not exfiltration, case and subdomain handled', () => {
  const result = assess([
    mailbox('internal-lower', { forwardingSmtpAddress: 'colleague@contoso.com' }),
    mailbox('internal-upper', { forwardingSmtpAddress: 'Colleague@CONTOSO.COM' }),
    mailbox('second-domain', { forwardingSmtpAddress: 'colleague@contoso.co.uk' }),
    // A lookalike domain is external however much it resembles the tenant's.
    mailbox('lookalike', { forwardingSmtpAddress: 'attacker@contoso.com.evil.example' }),
  ])
  assert.deepEqual(result.findings.items.map(finding =>
    finding.subject.kind === 'MAILBOX' ? finding.subject.mailboxRef : null), ['lookalike'])
})

test('a disabled rule is configuration, not exfiltration', () => {
  const result = assess([mailbox('a', { rules: [rule({ enabled: false, forwardTo: ['exfil@evil.example'] })] })])
  assert.deepEqual(result.findings.items, [])
  // Considered and cleared, which is what lets this read as a genuine zero.
  assert.deepEqual(result.detectors, [{ detectorId: 'external-mailbox-forwarding', status: 'RAN', considered: 1, declined: {}, matched: 0 }])
  assert.deepEqual(figure(result.count), { accuracy: 'EXACT', value: 0 })
})

test('without verified domains it declares itself inapplicable rather than flagging everyone', () => {
  // Every address would look external, so the honest answer is that this check
  // cannot be asked here — not a page of findings asserting the whole tenant is
  // exfiltrating, and not a run that "considered nothing", which is
  // indistinguishable from a dead detector.
  const blind = externalForwardingDetector({ verifiedDomains: [] })
  const result = assess([mailbox('a', { forwardingSmtpAddress: 'colleague@contoso.com' })], [blind])
  assert.deepEqual(result.findings.items, [])
  assert.deepEqual(result.detectors, [{
    detectorId: 'external-mailbox-forwarding',
    status: 'INAPPLICABLE',
    because: "The tenant's verified domains are unknown, so internal and external recipients cannot be told apart.",
  }])

  // An inapplicable check does not withhold on its own account — nothing was
  // lost, the question could not be asked. But this tenant has only that one
  // check, so nothing examined anything, and a zero resting on no examined
  // evidence is a zero resting on nothing. Withheld, and it says which.
  assert.deepEqual(result.claim.permitted === false && result.claim.because, ['NO_CHECK_EXAMINED_EVIDENCE'])
  assert.deepEqual(result.count.scope.covered, [])
  assert.equal(result.count.scope.notCovered.length, 1)

  // Beside a second check that did examine something, the inapplicable one
  // still does not gate — it only narrows the scope.
  const alongside = assess([mailbox('a', { forwardingSmtpAddress: 'colleague@contoso.com' })], [
    blind,
    {
      id: 'looked-at-it',
      monotonic: true,
      run: applicable => ({ status: 'RAN' as const, considered: applicable.length, declined: {}, findings: [] }),
    },
  ])
  assert.deepEqual(alongside.claim, { permitted: true })
  assert.deepEqual(alongside.count.scope.covered, ['looked-at-it'])
  assert.equal(alongside.count.scope.notCovered.length, 1)
})

test('the detector plugs into the core without the core knowing anything about mailboxes', () => {
  // The seam being proven. The core is generic over the event type, holds no
  // mailbox vocabulary, and reaches its claim the same way it would for any
  // other evidence stream.
  const clean = assess([mailbox('a', { forwardingSmtpAddress: 'colleague@contoso.com' })])
  assert.deepEqual(clean.claim, { permitted: true })
  assert.deepEqual(figure(clean.count), { accuracy: 'EXACT', value: 0 })
  assert.deepEqual(clean.findings.items, [], 'nothing found, as distinct from nothing counted')

  // And the coverage rules apply unchanged: an artefact nobody could read
  // withholds the clean claim without suppressing what was found elsewhere.
  const partial = evaluate<MailboxForwardingArtefact>({
    evidence: {
      availability: 'READ',
      applies: [mailbox('a', { forwardingSmtpAddress: 'exfil@evil.example' })],
      coverage: coverage(1, { unprocessable: { MAILBOX_UNREADABLE: 1 } }),
      timeOf: () => 0,
    },
    detectors: [detector], budget: { maxEvents: 500 },
  })
  assert.equal(partial.findings.items.length, 1)
  assert.deepEqual(partial.claim, { permitted: false, because: ['UNINTERPRETED_EVENTS'] })
  // No user was identified, so there is no floor to state about people — and a
  // lower bound of zero is not a statement. The mailbox finding is still
  // reported; it simply is not evidence about how many humans are affected.
  assert.deepEqual(figure(partial.count), { accuracy: 'NOT_AVAILABLE', value: null })
})
