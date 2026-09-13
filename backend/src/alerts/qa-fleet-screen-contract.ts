// QA PRE-REGISTRATION — THE FLEET SCREEN (risky users, and the dashboard queue beside it).
//
// WRITTEN BEFORE THE CODE EXISTS. Engineer 2 is mid-flight on it as this is written. I have read
// NONE of their branch: not a diff, not a file, not a commit message. I confirmed only that
// `app/(protected)/risky-users/page.tsx` exists on origin/main, and did not open it. If that turns
// out to be more contact than it sounds, the properties below stand anyway — they are derived from
// the defect SHAPES, not from anybody's code.
//
// ═════════════════════════════════════════════════════════════════════════════
// THE SEAM ATTACK, SPENT FIRST
//
// The obvious shape is `{ count: number }` plus a component that renders an empty state when the
// count is zero, and picks an icon from the count. SIX OF THE PROPERTIES BELOW ARE UNPINNABLE
// THROUGH IT, and the reason is always the same: a number has no room for what it was counted
// over.
//
// 1. A COUNT AND ITS COVERAGE CANNOT DISAGREE — but `number` has nowhere to put the coverage, so
//    they are two values that travel separately and nothing makes them arrive together. That is
//    the two-homes shape, and it is why the Priority Action Queue could walk every tenant and let
//    an unreadable one contribute zero. The zero was arithmetically correct. It was an answer to
//    a question nobody asked.
//
// 2. ZERO-FOUND AND COULD-NOT-LOOK ARE THE SAME VALUE. Both are `0`, so any renderer downstream
//    has already lost the distinction before it decides what to draw. No amount of care in the
//    component recovers it; the information is gone at the boundary.
//
// 3. THE ICON IS CHOSEN FROM THE COUNT, which means a reassuring icon is CONSTRUCTIBLE over a
//    fleet nobody could assess. This is the worst instance in the product: a green shield over
//    three of four tenants unassessed. **The reassurance is in the icon**, and a test that reads
//    the text will not see it — the text may even be accurate.
//
// 4. A PARTIAL READ HAS NO REPRESENTATION. Some tenants readable, some not, is the normal case and
//    the obvious shape can only say a number. It cannot say "at least".
//
// 5. FLOOR AND TOTAL ARE THE SAME TYPE. Whether `12` means twelve or at-least-twelve is carried,
//    if at all, by a format string somewhere else — so the two can drift, and the drift is
//    invisible because both render as a number.
//
// 6. AND WHICH TENANTS WERE MISSED IS UNRECOVERABLE. A person told the number is incomplete and
//    not told where the hole is cannot act on it, so the honest label becomes noise and the next
//    change quietly removes it.
//
// WHAT MY OWN FIRST DRAFT COULD NOT EXPRESS — checked rather than assumed, because it has happened
// on every seam so far:
//
// 7. A COVERAGE THAT IS ITSELF UNKNOWN. My first shape had `assessed` and `total` as numbers, so
//    a fleet whose SIZE could not be determined had to report some number as the denominator.
//    That invents a total, which is the same fabrication one level up. `FleetSize` is therefore
//    its own union.
//
// 8. AND A COUNT MEASURED AT A DIFFERENT MOMENT FROM ITS COVERAGE. If the two are gathered by
//    different calls, a screen can show a complete-looking count beside a coverage from before the
//    failure. Both true, describing different instants — the disagreeing-pair shape for the third
//    time in this product. So they are ONE value with ONE timestamp, not two fields.
// ═════════════════════════════════════════════════════════════════════════════
//
// WHICH HALF BINDS ME. The properties R1-R9 are pre-registered and binding: they are what I will
// check, and if the built thing fails one I report it. If I later think a property was wrong I say
// so in a separately-labelled file rather than editing this one.
//
// THE TYPES BELOW ARE A PROPOSAL, NOT A REQUIREMENT. I do not get to design this screen. They
// exist because I had to answer one question honestly — CAN THESE PROPERTIES BE CHECKED AT ALL
// through the obvious shape — and the answer was no for six of nine. Any shape that keeps a count
// married to its coverage, and that gives a reassuring rendering no constructor when coverage is
// incomplete, will do. What I will not accept is a shape in which a property becomes UNASKABLE,
// because unaskable reads exactly like passing.
//
// WHAT THIS DELIBERATELY DOES NOT DECIDE: the wording, the layout, the colours, which icon library,
// whether the gap is a banner or a row, how the data is fetched, or how tenants are ordered.

/** How many tenants there are to assess — AND THIS CAN ITSELF BE UNKNOWN.
 *
 * A fleet whose size could not be determined must not be given a denominator. Inventing one turns
 * "we could not tell" into a measurement, which is the fabrication this register exists to stop,
 * one level up from the count itself. */
export type FleetSize =
  | Readonly<{ kind: 'KNOWN'; tenants: number }>
  | Readonly<{ kind: 'UNKNOWN'; because: string }>

/** What a single tenant contributed. **AN UNREADABLE TENANT IS NOT A ZERO.**
 *
 * This is the Priority Action Queue defect made unwriteable: `NOT_ASSESSED` carries no number, so
 * a summing loop cannot add it in as nothing. It has to be handled, and handling it is what
 * produces a coverage figure at all. */
export type TenantContribution =
  | Readonly<{ kind: 'ASSESSED'; tenantId: string; found: number }>
  | Readonly<{ kind: 'NOT_ASSESSED'; tenantId: string; because: string }>

/** A COUNT THAT CANNOT BE SEPARATED FROM WHAT IT WAS COUNTED OVER.
 *
 * One value, one timestamp. Not a number beside a coverage that a caller must remember to carry —
 * two fields that can disagree need one owner, and this product has found that three times. */
export interface CoveredCount {
  /** Every tenant that was in scope, assessed or not. The coverage is DERIVED from this rather
   * than supplied beside it, so the two cannot drift. */
  readonly contributions: readonly TenantContribution[]
  readonly fleet: FleetSize
  /** One instant for the whole figure. A count and a coverage gathered at different moments are
   * two true statements about different worlds. */
  readonly asOf: Date
}

/** WHAT A COUNT MEANS, AND THERE IS NO BARE NUMBER HERE.
 *
 * `AT_LEAST` is the normal case on a fleet product and it is a different claim from `EXACTLY`.
 * Carrying both as `number` is what lets a floor render as a total. */
export type Total =
  | Readonly<{ kind: 'EXACTLY'; value: number }>
  | Readonly<{ kind: 'AT_LEAST'; value: number; unassessedTenants: number }>
  /** Nothing was assessed. NOT a zero — there is no value member on this arm at all, so a
   * renderer cannot reach for one. */
  | Readonly<{ kind: 'NOT_MEASURED'; unassessedTenants: number; because: string }>

/** WHY A SCREEN IS SHOWING NOTHING, WHICH IS TWO DIFFERENT FACTS.
 *
 * `NOTHING_FOUND` is good news. `COULD_NOT_LOOK` is not news at all. Collapsing them is the
 * emptiness defect this product has now met on the settings page, the dispositions read, and here
 * — and here it is the one with a green shield over it. */
export type Emptiness =
  | Readonly<{ kind: 'NOTHING_FOUND'; over: CoveredCount }>
  | Readonly<{ kind: 'COULD_NOT_LOOK'; unassessedTenants: number; because: string }>
  /** Some tenants clear, others unreadable, nothing found in what WAS read. The case the obvious
   * shape cannot say, and the most common one in practice. */
  | Readonly<{ kind: 'NOTHING_FOUND_IN_A_PARTIAL_READ'; assessedTenants: number; unassessedTenants: number }>

/** THE ICON IS PART OF THE CLAIM.
 *
 * `REASSURING` is what a green shield is. It takes a witness that every tenant in scope was
 * assessed — so over an incomplete read it HAS NO CONSTRUCTOR, rather than being available to
 * anybody who reaches for it. That is the difference between a rule and a review comment. */
export type Assurance =
  | Readonly<{ kind: 'REASSURING'; everyTenantAssessed: true; assessedTenants: number }>
  | Readonly<{ kind: 'QUALIFIED'; assessedTenants: number; unassessedTenants: number }>
  | Readonly<{ kind: 'UNKNOWN'; because: string }>

/** The screen's whole claim, assembled. Rendering reads THIS, not a number and a hope. */
export interface FleetClaim {
  readonly total: Total
  readonly assurance: Assurance
  readonly emptiness: Emptiness | null
  /** WHICH tenants are missing, not merely how many. A person told a figure is incomplete and not
   * told where the hole is cannot act on it, and an unusable caveat gets deleted. */
  readonly unassessed: readonly Readonly<{ tenantId: string; because: string }>[]
}

/** THE PROPERTIES. Binding.
 *
 * R1 A COUNT AND ITS COVERAGE CANNOT DISAGREE. Every figure on the screen is derived from the
 *    same contributions as its coverage, so there is no pair to drift.
 * R2 AN UNREADABLE TENANT IS NEVER A ZERO. It cannot be summed as nothing — the arm carries no
 *    number to sum.
 * R3 NOTHING-FOUND AND COULD-NOT-LOOK ARE DIFFERENT STATES, and a partial read is a third.
 * R4 AN INCOMPLETE COUNT IS A FLOOR, VISIBLY. `AT_LEAST` is a different constructor from
 *    `EXACTLY`, and it carries how many tenants are missing.
 * R5 A REASSURING RENDERING HAS NO CONSTRUCTOR OVER AN INCOMPLETE READ. The icon, the colour and
 *    the copy are one claim, not decoration chosen downstream.
 * R6 NOTHING IS MEASURED AGAINST AN INVENTED DENOMINATOR. An unknown fleet size is its own arm.
 * R7 THE COUNT AND ITS COVERAGE SHARE ONE INSTANT.
 * R8 WHICH TENANTS WERE MISSED IS RECOVERABLE FROM THE CLAIM, not just how many.
 * R9 THE ASSEMBLED SCREEN IS CHECKED, NOT THE PARTS. A true sentence in the wrong company is this
 *    product's recurring defect and no unit test has ever seen one — so the check renders the
 *    screen and reads what a person would see, icon included.
 */
export const PRE_REGISTERED_FLEET_SCREEN = [
  'R1 a count and its coverage cannot disagree',
  'R2 an unreadable tenant is never a zero',
  'R3 nothing-found, could-not-look and a partial read are three states',
  'R4 an incomplete count is a floor, visibly',
  'R5 a reassuring rendering has no constructor over an incomplete read',
  'R6 nothing is measured against an invented denominator',
  'R7 the count and its coverage share one instant',
  'R8 which tenants were missed is recoverable, not just how many',
  'R9 the assembled screen is checked, not the parts',
] as const
