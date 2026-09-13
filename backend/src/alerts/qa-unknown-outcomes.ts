// QA — the claim that an unrecognised sign-in error code silences a tenant's rule for a whole run.
//
// RELAYED TO ME, NOT READ BY ME, so it is attacked rather than confirmed. The chain has three links:
// `classify()` recognises only 50126, 0 and 50076; an UNKNOWN outcome adds `UNKNOWN_OUTCOMES` to the
// reasons; and the reasons are said to make the run PARTIAL with nobody assessed.
//
// THE CASE WHERE THE TWO MUST DIFFER is constructed here rather than argued: one window whose events
// are entirely within the known three, and the SAME window with one extra event carrying an
// unrecognised code. If the first reports and the second does not, the chain is established by
// behaviour.
//
// AND THE CONTROL THAT MATTERS AS MUCH: does the first case actually report? A window of only-known
// codes that ALSO fails would mean the classifier is a coincidence and the cause is elsewhere —
// the possibility where everybody is confidently wrong in the same direction.
import { evaluateAuthenticationRules } from '../risky-users-auth/evaluate.js'
import { evaluation, event, failures } from '../risky-users-auth/fixtures.js'
import type { AuthNormalizedEvent } from '../risky-users-auth/contract.js'

/** An event carrying a code the classifier does not recognise. 50053 is smart lockout — an account
 * locked after repeated failed sign-ins, which is the evidence the rules exist to detect. */
const unknownCoded = (id: string, minutes: number): AuthNormalizedEvent =>
  event(id, minutes, { outcome: 'UNKNOWN', errorCode: 50053 })

const look = (label: string, events: readonly AuthNormalizedEvent[]) => {
  const result = evaluateAuthenticationRules(evaluation(events))
  return {
    label,
    events: events.length,
    findings: result.findings.length,
    rules: result.rules.map((r) => ({ ruleId: r.ruleId, status: r.status, reasonCodes: r.reasonCodes })),
    admittedEventCount: result.admittedEventCount,
    // The caveats a finding carries, because a finding that still lands may land qualified.
    caveatsOnFindings: [...new Set(result.findings.flatMap((f) => f.caveats))].sort(),
  }
}

// ── A. TEN FAILURES, ALL KNOWN CODES. The positive control: this must report. ────────────────
const tenKnown = failures(10, -10)
const a = look('A — ten 50126 failures, nothing else', tenKnown)

// ── B. THE SAME WINDOW PLUS ONE UNRECOGNISED CODE. One row is the whole difference. ──────────
const b = look('B — the same ten, plus ONE event carrying 50053', [...tenKnown, unknownCoded('locked-out', -5)])

// ── C. THE PRODUCTION SHAPE PM MEASURED: 5 × 50053, 3 × success, 3 × 50126. ──────────────────
// Reproduced as a window rather than described, because the interesting question is whether the
// unrecognised codes are what stops it — or whether three failures were never enough anyway.
const productionShape: AuthNormalizedEvent[] = [
  ...Array.from({ length: 5 }, (_, i) => unknownCoded(`locked-${i}`, -20 + i)),
  // DISTINCT IDS. The shipped `success()` helper uses a fixed event id, so three calls to it are
  // three rows with the same id — which the evaluator correctly treated as CONFLICTING_DUPLICATES
  // and admitted 8 of 11. That was my fixture distorting the window, not the product.
  ...Array.from({ length: 3 }, (_, i) => event(`success-${i}`, -12 + i, { outcome: 'SUCCESS', errorCode: 0 })),
  ...Array.from({ length: 3 }, (_, i) => event(`invalid-${i}`, -8 + i)),
]
const c = look('C — the production window: 5 × 50053, 3 × success, 3 × 50126', productionShape)

// ── D. THE SAME PRODUCTION SHAPE WITH THE FIVE UNKNOWNS REMOVED. ─────────────────────────────
// If C and D agree, the unrecognised codes are not what stopped that window.
const d = look('D — the same window with the five 50053 rows deleted', productionShape.filter((e) => e.outcome !== 'UNKNOWN'))

console.log(JSON.stringify({
  QA_UNKNOWN_OUTCOMES: {
    cases: { a, b, c, d },

    // ══ THE POSITIVE CONTROL, FIRST ════════════════════════════════════════════════════════
    THE_KNOWN_ONLY_WINDOW_REPORTS: a.findings > 0,

    // ══ DOES ONE UNRECOGNISED ROW SILENCE THE RUN? ═════════════════════════════════════════
    ONE_UNKNOWN_ROW_REMOVES_THE_FINDINGS: a.findings > 0 && b.findings === 0,
    findingsA: a.findings,
    findingsB: b.findings,
    // If the finding survives, the claim as stated is wrong at THIS layer and what changes is the
    // qualification rather than the result.
    WHAT_CHANGED_INSTEAD: {
      reasonCodesA: a.rules.map((r) => r.reasonCodes),
      reasonCodesB: b.rules.map((r) => r.reasonCodes),
      caveatsA: a.caveatsOnFindings,
      caveatsB: b.caveatsOnFindings,
      statusesA: a.rules.map((r) => r.status),
      statusesB: b.rules.map((r) => r.status),
    },

    // ══ AND THE PRODUCTION WINDOW, WHICH IS THE CLAIM THAT MATTERS ═════════════════════════
    THE_PRODUCTION_WINDOW_PRODUCES: c.findings,
    WITHOUT_ITS_UNKNOWNS_IT_PRODUCES: d.findings,
    UNKNOWNS_ARE_WHAT_STOPPED_IT: c.findings === 0 && d.findings > 0,
    // The alternative explanation, which has to be eliminated rather than assumed away.
    IT_NEVER_HAD_ENOUGH_FAILURES_EITHER_WAY: c.findings === 0 && d.findings === 0,
  },
}, null, 2))
