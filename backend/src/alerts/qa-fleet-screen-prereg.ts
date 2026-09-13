// QA PRE-REGISTRATION — the fleet screen's properties, shown to be EXPRESSIBLE before the code
// exists, and the bad states shown to be UNCONSTRUCTIBLE.
//
// A register that only lists properties is a wish. This file does the two things that make one
// binding: for each property it builds THE TWO STATES THE PROPERTY SEPARATES and confirms they
// differ, and for each forbidden state it writes the code that would produce it and records that
// the compiler refuses. Every negative is an `@ts-expect-error`, and an unused directive fails the
// build — so THIS FILE TYPE-CHECKING IS THE EVIDENCE.
//
// I have read none of Engineer 2's branch.
import {
  PRE_REGISTERED_FLEET_SCREEN,
  type Assurance, type CoveredCount, type Emptiness, type FleetClaim, type FleetSize,
  type TenantContribution, type Total,
} from './qa-fleet-screen-contract.js'

const AS_OF = new Date('2026-09-13T00:00:00Z')

// ── THE THREE FLEETS THE WHOLE REGISTER TURNS ON ────────────────────────────────────────────
/** Four tenants, all assessed, nothing found. The only state a green shield may describe. */
const allClear: CoveredCount = {
  contributions: [0, 1, 2, 3].map((i): TenantContribution =>
    ({ kind: 'ASSESSED', tenantId: 'ten-' + i, found: 0 })),
  fleet: { kind: 'KNOWN', tenants: 4 },
  asOf: AS_OF,
}

/** THE ONE FROM THE BUG REPORT: three of four could not be assessed, and the one that could found
 * nothing. Under the obvious shape this is `0`, identical to `allClear`. */
const threeOfFourUnreadable: CoveredCount = {
  contributions: [
    { kind: 'ASSESSED', tenantId: 'ten-0', found: 0 },
    { kind: 'NOT_ASSESSED', tenantId: 'ten-1', because: 'consent revoked' },
    { kind: 'NOT_ASSESSED', tenantId: 'ten-2', because: 'Graph 503, retried twice' },
    { kind: 'NOT_ASSESSED', tenantId: 'ten-3', because: 'never onboarded' },
  ],
  fleet: { kind: 'KNOWN', tenants: 4 },
  asOf: AS_OF,
}

/** Nothing assessed at all, and the fleet size itself unknown. */
const nothingKnown: CoveredCount = {
  contributions: [],
  fleet: { kind: 'UNKNOWN', because: 'the tenant list call failed' },
  asOf: AS_OF,
}

// Derived the same way for every fleet, so a count and its coverage cannot come apart.
const assessed = (c: CoveredCount) => c.contributions.filter((x) => x.kind === 'ASSESSED').length
const unassessed = (c: CoveredCount) => c.contributions.filter((x) => x.kind === 'NOT_ASSESSED').length
const found = (c: CoveredCount) =>
  c.contributions.reduce((n, x) => n + (x.kind === 'ASSESSED' ? x.found : 0), 0)

// ── R1/R2. AN UNREADABLE TENANT IS NEVER A ZERO ─────────────────────────────────────────────
// The sum above can only reach `found` through the ASSESSED arm, because the other arm HAS NO
// SUCH FIELD. This is the Priority Action Queue defect made unwriteable rather than reviewed for.
// @ts-expect-error an unassessed tenant has no count to contribute
export const cannotContributeAZero: TenantContribution = { kind: 'NOT_ASSESSED', tenantId: 't', because: 'x', found: 0 }

// AND THE COVERAGE IS DERIVED FROM THE SAME LIST AS THE COUNT, so there is no second field to
// drift. A caller cannot supply a coverage that disagrees, because it cannot supply one at all.
// @ts-expect-error coverage is not an input; it is read off the contributions
export const cannotSupplyACoverage: CoveredCount = { ...allClear, assessedTenants: 4 }

// ── R3. THREE STATES, AND THEY DIFFER ───────────────────────────────────────────────────────
const emptinessOf = (c: CoveredCount): Emptiness =>
  assessed(c) === 0 ? { kind: 'COULD_NOT_LOOK', unassessedTenants: unassessed(c), because: 'nothing was assessed' }
    : unassessed(c) > 0 ? { kind: 'NOTHING_FOUND_IN_A_PARTIAL_READ', assessedTenants: assessed(c), unassessedTenants: unassessed(c) }
      : { kind: 'NOTHING_FOUND', over: c }

// THE DISCRIMINATION, DEMONSTRATED RATHER THAN ASSERTED: the three fleets land on three arms.
export const r3 = {
  allClear: emptinessOf(allClear).kind,
  partial: emptinessOf(threeOfFourUnreadable).kind,
  none: emptinessOf(nothingKnown).kind,
  THREE_DISTINCT_ARMS: new Set([
    emptinessOf(allClear).kind, emptinessOf(threeOfFourUnreadable).kind, emptinessOf(nothingKnown).kind,
  ]).size === 3,
  // AND THE COLLAPSE THAT PROVES THE GATE IS DOING WORK: under the obvious shape all three are 0.
  underABareNumber: [found(allClear), found(threeOfFourUnreadable), found(nothingKnown)],
  BARE_NUMBER_CANNOT_TELL_THEM_APART:
    new Set([found(allClear), found(threeOfFourUnreadable), found(nothingKnown)]).size === 1,
}

// `NOTHING_FOUND` takes the whole covered count, so it cannot be claimed from a bare zero.
// @ts-expect-error a bare number is not evidence that nothing was found
export const cannotClaimNothingFoundFromANumber: Emptiness = { kind: 'NOTHING_FOUND', over: 0 }

// ── R4. A FLOOR IS A DIFFERENT CONSTRUCTOR FROM A TOTAL ─────────────────────────────────────
const totalOf = (c: CoveredCount): Total =>
  assessed(c) === 0 ? { kind: 'NOT_MEASURED', unassessedTenants: unassessed(c), because: 'nothing was assessed' }
    : unassessed(c) > 0 ? { kind: 'AT_LEAST', value: found(c), unassessedTenants: unassessed(c) }
      : { kind: 'EXACTLY', value: found(c) }

export const r4 = {
  allClear: totalOf(allClear).kind,
  partial: totalOf(threeOfFourUnreadable).kind,
  none: totalOf(nothingKnown).kind,
  A_PARTIAL_READ_IS_NOT_EXACT: totalOf(threeOfFourUnreadable).kind === 'AT_LEAST',
}

// AND THE UNMEASURED ARM HAS NO VALUE TO RENDER, so a screen cannot print a zero for it.
// @ts-expect-error there is no number on NOT_MEASURED, deliberately
export const unmeasuredHasNoNumber: Total = { kind: 'NOT_MEASURED', unassessedTenants: 4, because: 'x', value: 0 }

// ── R5. A REASSURING RENDERING HAS NO CONSTRUCTOR OVER AN INCOMPLETE READ ────────────────────
// THE ONE THAT MATTERS. The empty state under a green ShieldCheck is a claim, and this is where it
// is made unwriteable: `everyTenantAssessed: true` is a LITERAL TYPE, so the only way to build
// REASSURING is to have the fact.
export const reassuringOverAClearFleet: Assurance = {
  kind: 'REASSURING', everyTenantAssessed: true, assessedTenants: assessed(allClear),
}

// ON ONE LINE ON PURPOSE. `@ts-expect-error` suppresses the NEXT LINE only, and my first version
// put the directive above a multi-line literal whose error landed two lines down — which the build
// reported as an UNUSED directive rather than letting it pass. The mechanism failed loudly.
// @ts-expect-error a reassuring claim cannot be made while admitting the read was partial
export const cannotReassureOverAPartialRead: Assurance = { kind: 'REASSURING', everyTenantAssessed: false, assessedTenants: 1 }
// @ts-expect-error and it cannot carry the unassessed count either — that is the QUALIFIED arm
export const reassuringCannotCarryAGap: Assurance = { kind: 'REASSURING', everyTenantAssessed: true, assessedTenants: 1, unassessedTenants: 3 }

// ── R6. NO INVENTED DENOMINATOR ─────────────────────────────────────────────────────────────
// @ts-expect-error an unknown fleet size has no number to be measured against
export const unknownFleetHasNoCount: FleetSize = { kind: 'UNKNOWN', because: 'x', tenants: 0 }
// @ts-expect-error and a known one must actually say how many
export const knownFleetMustSayHowMany: FleetSize = { kind: 'KNOWN' }

// ── R7. ONE INSTANT FOR THE WHOLE FIGURE ────────────────────────────────────────────────────
// There is exactly one `asOf` on `CoveredCount` and no second timestamp anywhere, so a count and a
// coverage from different moments cannot be assembled. The negative is that there is nothing to
// write: a per-field timestamp has no home.
// @ts-expect-error the coverage does not get its own clock
export const noSecondClock: CoveredCount = { ...allClear, coverageAsOf: new Date(0) }

// ── R8. WHICH TENANTS, NOT JUST HOW MANY ────────────────────────────────────────────────────
const claimFor = (c: CoveredCount): FleetClaim => ({
  total: totalOf(c),
  assurance: unassessed(c) === 0 && assessed(c) > 0
    ? { kind: 'REASSURING', everyTenantAssessed: true, assessedTenants: assessed(c) }
    : assessed(c) === 0
      ? { kind: 'UNKNOWN', because: 'nothing was assessed' }
      : { kind: 'QUALIFIED', assessedTenants: assessed(c), unassessedTenants: unassessed(c) },
  emptiness: found(c) === 0 ? emptinessOf(c) : null,
  unassessed: c.contributions.flatMap((x) =>
    x.kind === 'NOT_ASSESSED' ? [{ tenantId: x.tenantId, because: x.because }] : []),
})

export const r8 = {
  namedTenants: claimFor(threeOfFourUnreadable).unassessed.map((u) => u.tenantId),
  EACH_CARRIES_A_REASON: claimFor(threeOfFourUnreadable).unassessed.every((u) => u.because.length > 0),
}

// ── R9. THE ASSEMBLED SCREEN, which is the half no unit test has ever caught ─────────────────
// The recurring defect in this product is A TRUE SENTENCE IN THE WRONG COMPANY, and every instance
// passed its own tests. So the check I will run is a RENDER of the built screen over the three
// fleets above, reading what a person would see — the icon and its colour included, because the
// reassurance was in the icon and the text may well be accurate.
//
// The three fleets must produce three visibly different screens. If any two render alike, that is
// the finding, and no assertion about the underlying numbers changes it.
export const r9 = {
  theThreeFixtures: ['allClear', 'threeOfFourUnreadable', 'nothingKnown'],
  whatIWillRead: ['the count and whether it reads as a floor', 'the empty-state wording',
    'the icon and its colour', 'whether the missed tenants are nameable from the screen'],
  theFailure: 'any two of the three rendering alike',
}

console.log(JSON.stringify({
  QA_FLEET_SCREEN_PREREG: {
    registered: PRE_REGISTERED_FLEET_SCREEN,
    readOfEngineer2sBranch: 'nothing — not a diff, not a file, not a commit message',
    r3, r4, r8, r9,
    evidence: 'this file type-checking at all, with every forbidden state an @ts-expect-error that '
      + 'would fail the build if the compiler stopped refusing it',
  },
}, null, 2))
