// QA PRE-REGISTRATION — the publish path's properties shown to be EXPRESSIBLE, and the states that
// must not exist shown to be UNCONSTRUCTIBLE, before the code exists.
//
// A register that only lists properties is a wish. This builds, for each property, THE TWO STATES
// IT SEPARATES and confirms they differ; and for each forbidden state, the code that would produce
// it, recording that the compiler refuses. Every negative is an `@ts-expect-error` and an unused
// directive fails the build — so **this file type-checking is the evidence**.
//
// I have read none of Engineer's implementation.
import { ALERT_CATALOG } from './alert-catalog.js'
import { TYPE_FOR_SHAPE } from './reconciliation.js'
import type { KeyShape as PublicationKind } from './reconciliation.js'
import type { Severity } from './alert-type.js'
import {
  PRE_REGISTERED_PUBLISH_PATH,
  type DispositionSnapshot, type IgnoredSetting, type OrganisationSettings,
  type PublishDecision, type Publishable, type TypeForKind,
} from './qa-publish-path-contract.js'

const ORG = 'org-1'
const AT = new Date('2026-09-13T09:00:00Z')

// ── P5. WITHHOLDING HAS ONE CONSTRUCTOR, AND IT CARRIES ITS EVIDENCE ────────────────────────
// THE ONE THAT MATTERS. The cheap wrong implementation silences when a lookup fails. Here it has
// nothing to return: there is no arm for it, and the arm that exists demands a resolved type and a
// stored RECORD_ONLY.
export const theOnlyWayToWithhold: PublishDecision = {
  kind: 'WITHHELD', alertTypeId: 'monitoring.tenant_disconnected', disposition: 'RECORD_ONLY',
}
// @ts-expect-error a lookup failure has no withhold to return
export const cannotWithholdBecauseTheLookupFailed: PublishDecision = { kind: 'WITHHELD', because: 'SETTINGS_UNREADABLE' }
// @ts-expect-error nor one without a resolved type — a withhold names what it silenced
export const cannotWithholdWithoutAType: PublishDecision = { kind: 'WITHHELD', disposition: 'RECORD_ONLY' }
// @ts-expect-error and RECORD_ONLY is a literal, so a withhold cannot be built from a permissive tier
export const cannotWithholdOnAPermissiveTier: PublishDecision = { kind: 'WITHHELD', alertTypeId: 'x', disposition: 'ACT_TODAY' }
// @ts-expect-error a withhold carries no staleness, because stale evidence may not silence anything
export const cannotWithholdOnStaleEvidence: PublishDecision = { kind: 'WITHHELD', alertTypeId: 'x', disposition: 'RECORD_ONLY', onStaleEvidence: true }

// ── P1, P2, P3, P4. THE FAIL-OPEN DIRECTIONS, each with its own reason ──────────────────────
const settingsFor = (m: ReadonlyMap<string, Severity>): OrganisationSettings => ({ kind: 'READ', byAlertTypeId: m })

const snapshot = (settings: OrganisationSettings, ignored: readonly IgnoredSetting[] = []): DispositionSnapshot => ({
  takenAt: AT, ignored, forOrganisation: () => settings,
})

/** The five ways a decision can be reached without a usable setting. Each is a DIFFERENT reason,
 * which is P6: an operator must be able to tell a working policy from a broken lookup. */
export const theFailOpenPaths: readonly PublishDecision[] = [
  { kind: 'PUBLISH', because: 'SETTINGS_UNREADABLE', alertTypeId: 'monitoring.tenant_disconnected', onStaleEvidence: false },
  { kind: 'PUBLISH', because: 'NO_SNAPSHOT', alertTypeId: 'monitoring.tenant_disconnected', onStaleEvidence: false },
  { kind: 'PUBLISH', because: 'STORED_VALUE_UNREADABLE', alertTypeId: 'monitoring.tenant_disconnected', onStaleEvidence: false },
  { kind: 'PUBLISH', because: 'STORED_KEY_UNRECOGNISED', alertTypeId: 'monitoring.tenant_disconnected', onStaleEvidence: false },
  { kind: 'PUBLISH', because: 'KIND_HAS_NO_DECLARED_TYPE', alertTypeId: null, onStaleEvidence: false },
]

export const p6 = {
  reasons: theFailOpenPaths.map((d) => (d.kind === 'PUBLISH' ? d.because : 'WITHHELD')),
  FIVE_DISTINCT_REASONS: new Set(theFailOpenPaths.map((d) => (d.kind === 'PUBLISH' ? d.because : ''))).size === 5,
  // And none of them is the reason a READ setting gives, so a fail-open can never be mistaken for
  // a permission. That is the collapse the boolean shape could not avoid.
  NONE_IS_PERMITTED_BY_SETTING: theFailOpenPaths.every((d) => d.kind === 'PUBLISH' && d.because !== 'PERMITTED_BY_SETTING'),
}

// AND THE TWO THAT MUST NOT COLLAPSE, constructed side by side.
const silencedByPolicy: PublishDecision = {
  kind: 'WITHHELD', alertTypeId: 'monitoring.tenant_disconnected', disposition: 'RECORD_ONLY',
}
const publishedBecauseWeCouldNotLook: PublishDecision = {
  kind: 'PUBLISH', because: 'SETTINGS_UNREADABLE', alertTypeId: 'monitoring.tenant_disconnected', onStaleEvidence: false,
}
/** Read through a parameter rather than off the constants, because TypeScript narrows a `const`
 * initialised with a literal and then calls the comparison unintentional — which is the compiler
 * telling me the assertion is statically true, and a statically true assertion tests nothing. */
const outcomeOf = (d: PublishDecision) => d.kind

export const p1 = {
  policy: outcomeOf(silencedByPolicy),
  failure: outcomeOf(publishedBecauseWeCouldNotLook),
  THEY_ARE_DIFFERENT_OUTCOMES: outcomeOf(silencedByPolicy) !== outcomeOf(publishedBecauseWeCouldNotLook),
  // The collapse the obvious shape forces: through `Promise<boolean>` the failure returns `true`
  // and a permission returns `true`, so this pair is one value.
  UNDER_A_BOOLEAN_THEY_WOULD_BE: [false, true],
}

// ── P4. AN UNMAPPED KIND IS NOT A SILENCED KIND ─────────────────────────────────────────────
// `alertTypeId: null` is only available on the PUBLISH arm. There is no way to spell "no type, so
// withheld", which is the mistake that is easy to make and impossible to see afterwards.
// @ts-expect-error a kind with no type cannot be withheld, because a withhold must name a type
export const cannotSilenceAnUnmappedKind: PublishDecision = { kind: 'WITHHELD', alertTypeId: null, disposition: 'RECORD_ONLY' }

// ── P7. PURE AND SYNCHRONOUS, so nothing can reject into a collection ────────────────────────
// The seam returns a `PublishOutcome`, not a promise of one. A plan that did I/O could not satisfy
// the type without lying about it, and the negative is that there is nothing to write: an async
// implementation does not fit.
// @ts-expect-error a plan that awaits anything cannot satisfy a synchronous total function
export const aPlanCannotBeAsync: import('./qa-publish-path-contract.js').PublishPlan = async () => ({ decisions: [], ignored: [] })

// ── P2. NO SNAPSHOT IS A LEGITIMATE INPUT, not an error ─────────────────────────────────────
// `snapshot: DispositionSnapshot | null` is in the seam's parameter type, so a caller with nothing
// loaded has something valid to pass. A shape that demanded a snapshot would force the caller to
// invent one, and an invented snapshot is a measurement that did not happen.
export const nullIsAValidInput: { snapshot: DispositionSnapshot | null } = { snapshot: null }

// ── P9. THE AGREEMENT PROPERTY, over the WHOLE vocabulary rather than a sample ───────────────
// This is the check that protects the MSP: the settings page walks the catalogue, so if the publish
// path resolves kinds any other way, somebody silences a type and keeps receiving it.
//
// THE REFERENCE IS DERIVED FROM THE OTHER SIDE OF THE BOUNDARY — from the catalogue's own `covers`
// declarations, not from `TYPE_FOR_SHAPE`, so agreement is not by construction. `TYPE_FOR_SHAPE` is
// then compared against it as a control on my own derivation.
const fromTheCatalogue: ReadonlyMap<string, string> = new Map(
  ALERT_CATALOG.flatMap((type) =>
    ('covers' in type ? (type.covers as readonly string[]) : []).map((kind) => [kind, type.id] as const)))

const EVERY_KIND: readonly PublicationKind[] = [
  'DIRECTORY_AUDIT', 'TENANT_SYNC', 'TENANT_CONNECTION', 'TENANT_INITIAL_SYNC',
  'TENANT_ONBOARDING', 'RECOVERY', 'UNRECOGNISED',
]

/** What the publish path must answer for every kind. Engineer's implementation is checked against
 * THIS when it lands; today it establishes that the reference itself is well formed. */
export const theAgreedResolution: TypeForKind = (kind) => fromTheCatalogue.get(kind) ?? null

// **THE REFERENCE IS EMPTY ON THIS BRANCH, AND THE REGISTER SAYS SO RATHER THAN SCORING IT.**
// `covers` was added to the catalogue at 6017f23, which this QA branch predates. So on a checkout
// without it `fromTheCatalogue` has no entries and every comparison against `TYPE_FOR_SHAPE` would
// read as a disagreement — a result computed over an empty input, which is the exact defect this
// register exists to catch. P9 is therefore reported as NOT EVALUABLE here and is evaluated on the
// implementation branch, where both sides exist.
const catalogueDeclaresCovers = fromTheCatalogue.size > 0

export const p9 = {
  catalogueDeclaresCovers,
  perKind: EVERY_KIND.map((kind) => ({
    kind,
    fromCatalogueCovers: theAgreedResolution(kind),
    fromTypeForShape: TYPE_FOR_SHAPE[kind],
    agree: theAgreedResolution(kind) === TYPE_FOR_SHAPE[kind],
  })),
  EVERY_KIND_COVERED: EVERY_KIND.every((k) => k in TYPE_FOR_SHAPE),
  THE_TWO_EXISTING_SOURCES_ALREADY_AGREE: catalogueDeclaresCovers
    ? EVERY_KIND.every((k) => theAgreedResolution(k) === TYPE_FOR_SHAPE[k])
    : 'NOT EVALUABLE ON THIS BRANCH — the catalogue here declares no `covers`, so the reference '
      + 'side of the comparison is empty and an answer either way would be meaningless',
  kindsWithNoType: catalogueDeclaresCovers
    ? EVERY_KIND.filter((k) => theAgreedResolution(k) === null)
    : 'NOT EVALUABLE ON THIS BRANCH',
}

// ── P10. STALENESS QUALIFIES A PUBLISH AND CANNOT REACH A WITHHOLD ───────────────────────────
export const staleStillPublishes: PublishDecision = {
  kind: 'PUBLISH', because: 'PERMITTED_BY_SETTING', alertTypeId: 'monitoring.recovered', onStaleEvidence: true,
}

// ── P8 IS NOT A TYPE PROPERTY, AND SAYING SO IS THE POINT ───────────────────────────────────
// "A collection completes when the lookup fails" cannot be established by any signature: a pure
// synchronous decision makes it very hard to break, but the collector could still await the
// SNAPSHOT LOAD in the wrong place and inherit its failure that way. P8 is therefore a RUNTIME
// check I will perform against the built thing: fail the load in the middle of a sync and confirm
// the collection's own rows are written — not that the code catches something.
export const p8 = {
  whatIWillDo: 'inject a failure into the snapshot load during a sync, then read the collection\'s '
    + 'own rows out of the database',
  whatWouldNotCount: 'a test asserting that a catch block ran, or that the publish path returned '
    + 'a value — the claim is about the collection finishing, so the evidence is its rows',
  whyItIsNotATypeProperty: 'the seam being synchronous removes the failure from the DECISION path, '
    + 'and does not stop a caller awaiting the LOAD somewhere that can fail a sync',
}

console.log(JSON.stringify({
  QA_PUBLISH_PATH_PREREG: {
    registered: PRE_REGISTERED_PUBLISH_PATH,
    readOfEngineersBranch: 'nothing — not a diff, not a file, not a commit message',
    p1, p6, p9, p8,
    evidence: 'this file type-checking at all, with every forbidden state an @ts-expect-error that '
      + 'would fail the build if the compiler stopped refusing it',
  },
}, null, 2))
