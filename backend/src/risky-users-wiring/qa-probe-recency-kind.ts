// QA: a recency now says what KIND of time it is. This checks the invariant
// that spans two detectors, which neither detector's own unit test can see.
//
//   repeated-credential-failure   must only ever say EVENT_OCCURRED
//   external-mailbox-forwarding   must only ever say STATE_OBSERVED
//
// It does NOT stop at the label. A label is a claim, and the defect being
// guarded against was a read time wearing an event time's clothes -- so the
// stronger question is whether `latest.at` is a value that actually came from
// where the kind says it came from:
//
//   EVENT_OCCURRED  -> must equal the time of an event in the input
//   STATE_OBSERVED  -> must equal the artefact's own observedAt
//
// A detector that mislabelled its kind but kept the right value would pass the
// label check and fail this one. A detector that stamped `now` would pass a
// "looks like a timestamp" check and fail both.
import { credentialFailureDetector } from './detectors/credential-failure.js'
import { externalForwardingDetector, type MailboxForwardingArtefact } from '../evaluation-core/detectors/external-forwarding.js'
import { normalizeSignInBatch } from '../risky-users-normalization/index.js'
import type { Subject } from '../evaluation-core/contract.js'

const scope = { organizationId: 'org', customerTenantId: 'tenant', microsoftTenantId: 'ms' }
const USER = '11111111-1111-4111-8111-111111111111'
const APP = '22222222-2222-4222-8222-222222222222'
const at = (n: number) => new Date(Date.UTC(2026, 8, 10, 0, 0, n)).toISOString()

// Six lockouts then a rejection, so both signals carry a non-null recency and
// the two are at different times -- an input where a swapped value is visible.
const rows = [
  ...Array.from({ length: 6 }, (_, i) => ({ code: 50053, n: i })),
  { code: 50126, n: 40 },
].map(({ code, n }) => ({
  organizationId: scope.organizationId, customerTenantId: scope.customerTenantId, ingestedAt: new Date(),
  raw: { id: `evt-${n}`, createdDateTime: at(n), userId: USER, userPrincipalName: 'alice@contoso.com',
    appId: APP, ipAddress: '203.0.113.9', isInteractive: true,
    status: { errorCode: code, failureReason: code === 50053
      ? "The account is locked, you've tried to sign in too many times with an incorrect user ID or password."
      : 'Error validating credentials due to invalid username or password.' } },
}))

const batch = await normalizeSignInBatch({ scope, source: 'GRAPH_SIGN_INS', rows,
  directory: [{ organizationId: scope.organizationId, customerTenantId: scope.customerTenantId,
    microsoftUserId: USER, userPrincipalName: 'alice@contoso.com', userType: 'Member' }],
  reference: async () => 'subject-ref', collectionScope: 'GRAPH_INTERACTIVE_ONLY' })

const eventTimes = new Set(batch.applies.map(event => event.eventAt))
const credential = credentialFailureDetector({ rejectionThreshold: 5 }).detector
const credentialRun = credential.run(batch.applies)
const credentialSignals = credentialRun.status === 'RAN'
  ? credentialRun.findings.flatMap(finding => finding.signals) : []
const credentialStamped = credentialSignals.filter(signal => signal.latest !== null)

// ---- forwarding ----
const OBSERVED_AT = '2026-03-01T09:00:00.000Z'   // deliberately OLD: a read time is always recent,
const mailboxSubject: Subject = { kind: 'MAILBOX', mailboxRef: 'mbx-1', binding: 'RESOLVED_NEGATIVE' }
const artefacts: readonly MailboxForwardingArtefact[] = [{
  subject: mailboxSubject, observedAt: OBSERVED_AT, forwardingAddress: null,
  deliverToMailboxAndForward: false, rules: [], forwardingSmtpAddress: 'out@evil.example',
}]
const forwardingRun = externalForwardingDetector({ verifiedDomains: ['contoso.com'] }).run(artefacts)
const forwardingSignals = forwardingRun.status === 'RAN'
  ? forwardingRun.findings.flatMap(finding => finding.signals) : []
const forwardingStamped = forwardingSignals.filter(signal => signal.latest !== null)

// GUARD. If either side produced no stamped signal there is nothing to check,
// and a clean reading would mean only that the scenario did not run.
const inputCanFail = credentialStamped.length > 0 && forwardingStamped.length > 0

const credentialKindsRight = credentialStamped.every(s => s.latest!.kind === 'EVENT_OCCURRED')
const credentialValuesRight = credentialStamped.every(s => eventTimes.has(s.latest!.at))
const forwardingKindsRight = forwardingStamped.every(s => s.latest!.kind === 'STATE_OBSERVED')
const forwardingValuesRight = forwardingStamped.every(s => s.latest!.at === OBSERVED_AT)

const held = credentialKindsRight && credentialValuesRight && forwardingKindsRight && forwardingValuesRight

console.log(JSON.stringify({
  QA_RECENCY_KIND: {
    credential: {
      signals: credentialStamped.map(s => ({ signal: s.signal, count: s.count, at: s.latest!.at, kind: s.latest!.kind })),
      everyKindIsEventOccurred: credentialKindsRight,
      everyValueIsAnEventTimeFromTheInput: credentialValuesRight,
    },
    forwarding: {
      artefactObservedAt: OBSERVED_AT,
      signals: forwardingStamped.map(s => ({ signal: s.signal, count: s.count, at: s.latest!.at, kind: s.latest!.kind })),
      everyKindIsStateObserved: forwardingKindsRight,
      everyValueIsTheArtefactReadTime: forwardingValuesRight,
    },
    inputCanFail,
    verdict: !inputCanFail
      ? 'INCONCLUSIVE - one side produced no stamped signal, so nothing here could be wrong'
      : held
        ? 'PASS - each detector reports its own kind of time, and the value matches where that kind says it came from'
        : 'FAIL - a recency does not match the kind it declares',
  },
}, null, 2))
