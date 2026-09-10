// QA: PM's standing rule — no detector declares monotonic: true until the
// harness has run against it AND produced findings. This is that run for
// externalForwardingDetector.
//
// Pool deliberately mixes fires and non-fires, both subject kinds, and spreads
// observedAt across a wide range including events OLDER than the ones it fires
// on — because a pool of only recent events cannot generate the counterexample
// for a history-sensitive rule, which would let it pass while still exposed.
import { checkMonotonic } from './qa-monotonicity-harness.js'
import { externalForwardingDetector, type MailboxForwardingArtefact } from './detectors/external-forwarding.js'
import type { Subject } from './contract.js'

const user = (n: number): Subject => ({ kind: 'DIRECTORY_USER', userRef: `user-${n}`, correlation: { available: false, because: 'probe' } })
const box = (n: number): Subject => ({ kind: 'MAILBOX', mailboxRef: `mbx-${n}`, binding: 'RESOLVED_NEGATIVE' })
const at = (n: number) => new Date(Date.UTC(2026, 0, 1 + n)).toISOString()
const base = { forwardingAddress: null, deliverToMailboxAndForward: false, rules: [] }

const pool: readonly MailboxForwardingArtefact[] = [
  { ...base, subject: user(1), observedAt: at(0), forwardingSmtpAddress: 'out@evil.example' },   // fires, oldest
  { ...base, subject: user(2), observedAt: at(30), forwardingSmtpAddress: 'staff@contoso.com' }, // internal, no fire
  { ...base, subject: box(3), observedAt: at(60), forwardingSmtpAddress: 'leak@elsewhere.net' }, // fires, mailbox subject
  { ...base, subject: user(4), observedAt: at(90), forwardingSmtpAddress: null },                // nothing
  { ...base, subject: user(5), observedAt: at(120), forwardingSmtpAddress: null,
    rules: [{ enabled: true, redirectTo: ['exfil@outside.org'], forwardTo: [], forwardAsAttachmentTo: [] }] },  // fires via rule
  { ...base, subject: user(6), observedAt: at(150), forwardingSmtpAddress: null,
    rules: [{ enabled: false, redirectTo: ['disabled@outside.org'], forwardTo: [], forwardAsAttachmentTo: [] }] }, // disabled rule
  { ...base, subject: user(7), observedAt: at(200), forwardingSmtpAddress: 'newest@evil.example' }, // fires, newest
]

const configured = externalForwardingDetector({ verifiedDomains: ['contoso.com'] })
const unconfigured = externalForwardingDetector({ verifiedDomains: [] })

const withDomains = checkMonotonic(configured, pool, { trials: 500 })
// Domains unknown -> the detector declines. Strict mode should report that as a
// DECLINE rather than as a monotonicity violation; that split is load-bearing here.
const noDomainsStrict = checkMonotonic(unconfigured, pool, { trials: 500 })

console.log(JSON.stringify({
  QA_HARNESS_EXTERNAL_FORWARDING: {
    declaredMonotonic: configured.monotonic,
    withVerifiedDomains: withDomains.held
      ? { held: true, trials: withDomains.trials, findingsSeen: withDomains.findingsSeen, declines: withDomains.declines }
      : { held: false, kind: withDomains.kind, seed: withDomains.seed, trial: withDomains.trial, lost: withDomains.lost },
    withoutVerifiedDomains: noDomainsStrict.held
      ? { held: true, findingsSeen: noDomainsStrict.findingsSeen }
      : { held: false, kind: noDomainsStrict.kind },
    // The rule: held is not enough. It must have had material to fail on.
    satisfiesStandingRule: withDomains.held === true && withDomains.findingsSeen > 0,
    verdict: withDomains.held && withDomains.findingsSeen > 0
      ? `VERIFIED: monotonic: true is checked, not declared — ${withDomains.findingsSeen} findings observed surviving`
      : withDomains.held
        ? 'VACUOUS: held, but produced no findings, so it proves nothing'
        : 'VIOLATION: the declaration is wrong',
  },
}, null, 2))
