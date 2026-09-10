import assert from 'node:assert/strict'
import test from 'node:test'
import { evaluate } from '../evaluate.js'
import { externalForwardingDetector, type MailboxForwardingArtefact } from './external-forwarding.js'
import type { Coverage } from '../contract.js'

const mailbox = (ref: string, parts: Partial<MailboxForwardingArtefact> = {}): MailboxForwardingArtefact => ({
  mailboxRef: ref,
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
  evaluate({ applies: mailboxes, coverage: coverage(mailboxes.length), detectors, budget: { maxEvents: 500 }, collected: true, readable: true })

test('forwarding outside the tenant is found wherever Exchange reports it', () => {
  const found = [
    mailbox('a', { forwardingSmtpAddress: 'exfil@evil.example' }),
    mailbox('b', { forwardingAddress: 'exfil@evil.example' }),
    mailbox('c', { rules: [rule({ redirectTo: ['exfil@evil.example'] })] }),
    mailbox('d', { rules: [rule({ forwardTo: ['exfil@evil.example'] })] }),
    mailbox('e', { rules: [rule({ forwardAsAttachmentTo: ['exfil@evil.example'] })] }),
  ]
  const result = assess(found)
  assert.deepEqual(result.findings.map(finding => finding.subject).sort(), ['a', 'b', 'c', 'd', 'e'])
  // Every mailbox was read and the detector ran, so this is an exact total
  // rather than a floor — findings do not by themselves make a count uncertain.
  assert.deepEqual(result.count, { accuracy: 'EXACT', value: 5 })
})

test('the tenant\'s own domains are not exfiltration, case and subdomain handled', () => {
  const result = assess([
    mailbox('internal-lower', { forwardingSmtpAddress: 'colleague@contoso.com' }),
    mailbox('internal-upper', { forwardingSmtpAddress: 'Colleague@CONTOSO.COM' }),
    mailbox('second-domain', { forwardingSmtpAddress: 'colleague@contoso.co.uk' }),
    // A lookalike domain is external however much it resembles the tenant's.
    mailbox('lookalike', { forwardingSmtpAddress: 'attacker@contoso.com.evil.example' }),
  ])
  assert.deepEqual(result.findings.map(finding => finding.subject), ['lookalike'])
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

  // And the coverage rules apply unchanged: an artefact nobody could read
  // withholds the clean claim without suppressing what was found elsewhere.
  const partial = evaluate({
    applies: [mailbox('a', { forwardingSmtpAddress: 'exfil@evil.example' })],
    coverage: coverage(1, { unprocessable: { MAILBOX_UNREADABLE: 1 } }),
    detectors: [detector], budget: { maxEvents: 500 }, collected: true, readable: true,
  })
  assert.equal(partial.findings.length, 1)
  assert.deepEqual(partial.claim, { permitted: false, because: 'UNINTERPRETED_EVENTS' })
  assert.deepEqual(partial.count, { accuracy: 'AT_LEAST', value: 1 })
})
