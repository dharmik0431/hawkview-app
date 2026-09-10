import assert from 'node:assert/strict'
import test from 'node:test'
import { evaluate } from '../evaluate.js'
import { externalForwardingDetector, type MailboxForwardingArtefact } from './external-forwarding.js'
import type { Coverage } from '../contract.js'

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
  ({ applies, doesNotApply: {}, unknown: {}, unprocessable: {}, ...parts })

const assess = (mailboxes: readonly MailboxForwardingArtefact[], detectors = [detector]) =>
  evaluate<MailboxForwardingArtefact>({
    evidence: { availability: 'READ', applies: mailboxes, coverage: coverage(mailboxes.length), order: 'OLDEST_FIRST' },
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
    result.findings.map(finding => finding.subject.kind === 'MAILBOX' ? finding.subject.mailboxRef : null).sort(),
    ['a', 'b', 'c', 'd', 'e'])
  // Five mailboxes found, and zero *users* — exactly, because every mailbox was
  // read and the detector ran. None of these were bound to a directory user, so
  // none may be counted as a person. The findings are reported in full; it is
  // the user total they stay out of.
  assert.deepEqual(result.count, { accuracy: 'EXACT', value: 0 })
  assert.equal(result.findings.length, 5)
})

test('a zero user count beside real findings is coherent when the mailbox is provably not a person', () => {
  // Binding resolved and said "resource mailbox". Zero people really are
  // affected, and the finding is still reported. The count answers "how many
  // people", the findings answer "what did we find" — different questions.
  const result = assess([mailbox('reception-room', { forwardingSmtpAddress: 'exfil@evil.example' })])
  assert.deepEqual(result.count, { accuracy: 'EXACT', value: 0 })
  assert.equal(result.findings.length, 1)
  assert.equal(result.claim.permitted, true)
})

test('a mailbox we could not attribute refuses the exact zero rather than implying nobody', () => {
  // The other half, and the one that was a real defect before this. Binding was
  // attempted and failed, so we found something and cannot say whether a person
  // is behind it. The honest answer is not zero — it is unknown, between zero
  // and one — so the exact claim is refused instead of reading as "nobody".
  const unattributed = mailbox('orphan', { forwardingSmtpAddress: 'exfil@evil.example' })
  const result = assess([{ ...unattributed, subject: { kind: 'MAILBOX', mailboxRef: 'orphan', binding: 'UNRESOLVED' } }])
  assert.equal(result.findings.length, 1, 'still found, still reported')
  assert.deepEqual(result.claim, { permitted: false, because: 'UNRESOLVED_SUBJECT_IDENTITY' })
  assert.deepEqual(result.count, { accuracy: 'NOT_AVAILABLE', value: null })

  // And it does not erase what we could attribute: a known user still yields a
  // floor. One person for certain, possibly two — never "exactly one".
  const withKnownUser = evaluate<MailboxForwardingArtefact>({
    evidence: {
      availability: 'READ',
      applies: [{ ...unattributed, subject: { kind: 'MAILBOX', mailboxRef: 'orphan', binding: 'UNRESOLVED' } }],
      coverage: coverage(1),
      order: 'OLDEST_FIRST',
    },
    detectors: [detector, {
      id: 'user-side',
      run: () => ({
        considered: 1,
        findings: [{
          detectorId: 'user-side',
          subject: { kind: 'DIRECTORY_USER', userRef: 'alice' } as const,
          observedAt: '2026-09-10T00:00:00.000Z',
        }],
      }),
    }],
    budget: { maxEvents: 500 },
  })
  assert.deepEqual(withKnownUser.count, { accuracy: 'AT_LEAST', value: 1 })
})

test('a mailbox that resolved to a real person counts as that person', () => {
  // Promotion happens in the layer that can query the directory; the detector
  // passes the resolved subject through untouched.
  const bound = mailbox('alice-mailbox', { forwardingSmtpAddress: 'exfil@evil.example' })
  const result = assess([{ ...bound, subject: { kind: 'DIRECTORY_USER', userRef: 'alice' } }])
  assert.deepEqual(result.count, { accuracy: 'EXACT', value: 1 })
  assert.equal(result.claim.permitted, true)
})

test('adding a mailbox finding never moves the user count, colliding ref or not', () => {
  // Note on how this is built: asserting only the colliding case would pass even
  // if the two namespaces were compared as bare strings, because merging a
  // colliding mailbox into an existing user also yields 1. The non-colliding
  // case is what actually discriminates, so both are here.
  const userSide = (userRef: string) => ({
    id: `user-${userRef}`,
    run: () => ({
      considered: 1,
      findings: [{
        detectorId: `user-${userRef}`,
        subject: { kind: 'DIRECTORY_USER', userRef } as const,
        observedAt: '2026-09-10T00:00:00.000Z',
      }],
    }),
  })
  const withMailboxes = (mailboxes: readonly MailboxForwardingArtefact[]) => evaluate<MailboxForwardingArtefact>({
    evidence: { availability: 'READ', applies: mailboxes, coverage: coverage(Math.max(mailboxes.length, 1)), order: 'OLDEST_FIRST' },
    detectors: [detector, userSide('shared-billing')],
    budget: { maxEvents: 500 },
  })

  const exfiltrating = (ref: string) => mailbox(ref, { forwardingSmtpAddress: 'exfil@evil.example' })
  assert.deepEqual(withMailboxes([]).count, { accuracy: 'EXACT', value: 1 })
  // A mailbox whose ref happens to spell the same string as a user is still a
  // mailbox — it is not evidence of a second person, nor of that person.
  assert.deepEqual(withMailboxes([exfiltrating('shared-billing')]).count, { accuracy: 'EXACT', value: 1 })
  // And an unrelated mailbox does not become a second person either. This is the
  // case that fails if the two namespaces are ever compared as bare strings.
  assert.deepEqual(withMailboxes([exfiltrating('reception-room')]).count, { accuracy: 'EXACT', value: 1 })
  assert.equal(withMailboxes([exfiltrating('reception-room')]).findings.length, 2, 'still reported, just not counted')
})

test('the tenant\'s own domains are not exfiltration, case and subdomain handled', () => {
  const result = assess([
    mailbox('internal-lower', { forwardingSmtpAddress: 'colleague@contoso.com' }),
    mailbox('internal-upper', { forwardingSmtpAddress: 'Colleague@CONTOSO.COM' }),
    mailbox('second-domain', { forwardingSmtpAddress: 'colleague@contoso.co.uk' }),
    // A lookalike domain is external however much it resembles the tenant's.
    mailbox('lookalike', { forwardingSmtpAddress: 'attacker@contoso.com.evil.example' }),
  ])
  assert.deepEqual(result.findings.map(finding =>
    finding.subject.kind === 'MAILBOX' ? finding.subject.mailboxRef : null), ['lookalike'])
})

test('a disabled rule is configuration, not exfiltration', () => {
  const result = assess([mailbox('a', { rules: [rule({ enabled: false, forwardTo: ['exfil@evil.example'] })] })])
  assert.deepEqual(result.findings, [])
  // Considered and cleared, which is what lets this read as a genuine zero.
  assert.deepEqual(result.detectors, [{ detectorId: 'external-mailbox-forwarding', status: 'RAN', considered: 1, matched: 0 }])
  assert.deepEqual(result.count, { accuracy: 'EXACT', value: 0 })
})

test('without verified domains it considers nothing rather than flagging everyone', () => {
  // Every address would look external, so the honest answer is that it could
  // not run — not a page of findings asserting the whole tenant is exfiltrating.
  const blind = externalForwardingDetector({ verifiedDomains: [] })
  const result = assess([mailbox('a', { forwardingSmtpAddress: 'colleague@contoso.com' })], [blind])
  assert.deepEqual(result.findings, [])
  assert.deepEqual(result.detectors, [{ detectorId: 'external-mailbox-forwarding', status: 'RAN', considered: 0, matched: 0 }])
  // Considered-none is exactly what the per-detector accounting exists to
  // surface: this reads differently from a detector that examined the mailboxes.
  assert.equal(result.detectors[0]?.status === 'RAN' && result.detectors[0].considered, 0)
})

test('the detector plugs into the core without the core knowing anything about mailboxes', () => {
  // The seam being proven. The core is generic over the event type, holds no
  // mailbox vocabulary, and reaches its claim the same way it would for any
  // other evidence stream.
  const clean = assess([mailbox('a', { forwardingSmtpAddress: 'colleague@contoso.com' })])
  assert.deepEqual(clean.claim, { permitted: true })
  assert.deepEqual(clean.count, { accuracy: 'EXACT', value: 0 })
  assert.deepEqual(clean.findings, [], 'nothing found, as distinct from nothing counted')

  // And the coverage rules apply unchanged: an artefact nobody could read
  // withholds the clean claim without suppressing what was found elsewhere.
  const partial = evaluate<MailboxForwardingArtefact>({
    evidence: {
      availability: 'READ',
      applies: [mailbox('a', { forwardingSmtpAddress: 'exfil@evil.example' })],
      coverage: coverage(1, { unprocessable: { MAILBOX_UNREADABLE: 1 } }),
      order: 'OLDEST_FIRST',
    },
    detectors: [detector], budget: { maxEvents: 500 },
  })
  assert.equal(partial.findings.length, 1)
  assert.deepEqual(partial.claim, { permitted: false, because: 'UNINTERPRETED_EVENTS' })
  // No user was identified, so there is no floor to state about people — and a
  // lower bound of zero is not a statement. The mailbox finding is still
  // reported; it simply is not evidence about how many humans are affected.
  assert.deepEqual(partial.count, { accuracy: 'NOT_AVAILABLE', value: null })
})
