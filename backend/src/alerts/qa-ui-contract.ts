// QA PRE-REGISTRATION — THE ALERTS UI, written before the surface exists.
//
// ═════════════════════════════════════════════════════════════════════════════
// THE SEAM ATTACK, SPENT FIRST. Ten for ten.
//
// The obvious shape is `GET /alerts/settings` returning `{ alertTypeId, disposition }[]` and a
// `PUT` to change one. Seven things it cannot express:
//
// 1. "DOES THE SETTING CHANGE BEHAVIOUR" IS NOT A PROPERTY OF THE ENDPOINT AT ALL. The endpoint
//    writes a row. Whether the PIPELINE reads that row — same table, same key shape, same
//    organisation scoping — is a different fact, and both halves can be correct while the seam
//    between them is not connected. **This is `cancelStatement` with no caller, one layer up:
//    a toggle that writes a row nobody reads is a decorative button.** It is only askable end
//    to end: write through the path the UI writes through, then run the decision, and observe
//    the outcome change.
//
// 2. AN OVERRIDE IS INVISIBLE UNLESS THE CONTRACT CARRIES WHAT IT DEPARTED FROM.
//    `{ disposition: 'ACT_NOW' }` cannot tell anybody whether that is the catalogue's judgement
//    or a departure from it. **A departure nobody can see they made is how a setting becomes a
//    mystery** — and the question "have I changed this?" has no answer in that payload.
//
// 3. AN EMPTY LIST IS THE SAME PAYLOAD FOR "NOTHING HAPPENED" AND "WE HAVE NEVER LOOKED".
//    This ships into a database with zero findings, so **the empty state IS the product on day
//    one** — and this codebase already contains a source reporting READY and CURRENT while
//    having observed no events. Answering it wrong here is the house defect, in the one place
//    every MSP will look first.
//
// 4. A TIER NAME CANNOT SAY WHAT IT DOES TODAY. `ACT_NOW` is a tier; whether it phones anybody
//    is a CHANNEL fact, and it changed when SMS was deferred. **A label rendered from the tier
//    name will promise a phone call for as long as the tier exists.** The contract has to carry
//    the channels that are live now, not the tier alone.
//
// 5. HIDING UNMAPPED RULES IS INDISTINGUISHABLE FROM THEM NOT EXISTING. Six catalogue rules
//    deliberately produce no alert type. A list that omits them tells an MSP the product detects
//    less than it does; `mapped: false` has to be a FIELD rather than an omission.
//
// 6. A SECOND READ MODEL IS A SECOND SET OF COUNTS THAT WILL DISAGREE. Read and dismissed state
//    already lives per notification per user. An alerts view with its own read model produces a
//    bell and a list that disagree about the same message, and neither is wrong.
//
// 7. AND A SETTING WRITTEN MID-TICK DOES NOT APPLY TO THAT TICK. Intake reads dispositions once
//    per run. That is correct — a tick is a snapshot — but a UI that says "saved" while meaning
//    "from the next run" has made a promise the pipeline does not keep.
// ═════════════════════════════════════════════════════════════════════════════

/** What the product judges, and what the MSP has said, SIDE BY SIDE — never merged into one
 * effective value, because a merged value cannot be asked whether it is a departure. */
export interface AlertTypeSetting {
  readonly alertTypeId: string
  /** The catalogue's judgement. Travels so a departure is visible AS a departure. */
  readonly catalogueSeverity: 'ACT_NOW' | 'ACT_TODAY' | 'RECORD_ONLY'
  /** What this MSP chose, or null when they have not chosen. NULL IS NOT A VALUE TO RENDER —
   * it means "the catalogue's", and collapsing it loses the distinction in point 2. */
  readonly chosen: 'ACT_NOW' | 'ACT_TODAY' | 'RECORD_ONLY' | null
  /** Derived, and present so nobody re-derives it differently in the UI. */
  readonly isOverride: boolean
  /** WHAT THIS DOES TODAY, not what the tier is called. Empty means nothing is delivered. */
  readonly liveChannels: readonly ('EMAIL' | 'IN_APP')[]
  /** False for a catalogue rule with no alert type. SHOWN, not omitted. */
  readonly mapped: boolean
}

/** WHY A LIST IS EMPTY, which an empty array cannot say. */
export type Emptiness =
  | Readonly<{ kind: 'NOT_EMPTY' }>
  | Readonly<{ kind: 'NOTHING_MATCHED'; since: string; sourcesObserved: number }>
  | Readonly<{ kind: 'NEVER_OBSERVED'; because: string }>
  | Readonly<{ kind: 'NOT_ENTITLED' }>

export interface AlertsView {
  readonly alerts: readonly Readonly<{ incidentKey: string; alertTypeId: string; unread: boolean }>[]
  readonly emptiness: Emptiness
  /** The same per-user state the bell uses. NOT a second read model. */
  readonly unreadCount: number
}

/** THE PROPERTIES. Pre-registered, binding on me.
 *
 * U1 A SETTING CHANGES BEHAVIOUR, END TO END. An MSP moves a type from ACT_TODAY to ACT_NOW
 *    through the interface, and the pipeline's next decision routes it as ACT_NOW. **Neither
 *    half proves this.** The endpoint writing a row proves the endpoint; the pipeline reading
 *    a row proves the pipeline; only the two together prove the toggle is connected.
 * U2 AN OVERRIDE IS VISIBLE AS ONE. `catalogueSeverity` and `chosen` both travel, and
 *    `chosen: null` means "the catalogue's" rather than any renderable value.
 * U3 AN EMPTY LIST SAYS WHY IT IS EMPTY, and "nothing matched" is a different arm from "we have
 *    never been able to look".
 * U4 A CONTROL SAYS WHAT IT DOES TODAY. `liveChannels` carries the channels actually delivered;
 *    ACT_NOW must not claim a phone call while SMS is deferred.
 * U5 UNMAPPED RULES ARE SHOWN WITH `mapped: false`, never omitted.
 * U6 READ, DISMISS AND THE COUNT USE THE SAME PER-USER STATE AS THE BELL. One read model, so
 *    two surfaces cannot disagree about the same message.
 * U7 A SETTING TAKES EFFECT FROM THE NEXT TICK, and the interface does not imply otherwise.
 * U8 A SETTING IS SCOPED TO ITS ORGANISATION. One MSP's choice cannot alter another's routing —
 *    the same isolation rule as everywhere else in this product.
 */
export const PRE_REGISTERED_UI = [
  'U1 a setting changes behaviour, end to end',
  'U2 an override is visible as one',
  'U3 an empty list says why it is empty',
  'U4 a control says what it does today',
  'U5 unmapped rules are shown, not omitted',
  'U6 one read model, shared with the bell',
  'U7 a setting takes effect from the next tick',
  'U8 a setting is scoped to its organisation',
] as const

/** WHAT BINDS ME AND WHAT DOES NOT. U1-U8 are pre-registered and binding. The types above are a
 * PROPOSAL; if the implementer picks another shape the properties stay and my checks get
 * rewritten. What I will not accept is a property becoming unaskable.
 *
 * U1 IS THE ONE I WILL NOT TRADE. A settings surface whose writes the pipeline does not read is
 * the defect this project has now found three times: an incident with no job, a stop button with
 * no caller, and a queue with no consumer. **Each was correct code on both sides of a seam
 * nobody had crossed.** */
