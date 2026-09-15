import {
  providerMessageId,
  type BounceClass, type MessageId, type Outcome, type ProviderMessageId,
  type AuthenticEvent, type RawWebhook, type UnmatchedEvent,
} from './email-delivery.js'

/**
 * WHAT ARRIVES AT THE WEBHOOK, AND WHERE IT GOES. Pure — no Nest, no request, no secret.
 *
 * The controller's job shrinks to: pull the raw bytes, ask the verifier, call `parseResendEvent`,
 * call `authenticate`, call `outcomeRow`, write it. Everything that can be got wrong is in here
 * and testable without an HTTP server.
 */

// ---------------------------------------------------------------------------------------
// PARSING. A body we did not send ourselves, so every field is suspect.
// ---------------------------------------------------------------------------------------

/** Resend's event names for the three outcomes we model. Anything else is not an error and not
 * an outcome — see `parseResendEvent`. */
const KIND_BY_EVENT: Readonly<Record<string, Outcome['kind']>> = {
  'email.delivered': 'DELIVERED',
  'email.bounced': 'BOUNCED',
  'email.complained': 'COMPLAINED',
}

export type ParseResult =
  | Readonly<{ parsed: true; raw: RawWebhook }>
  /** NOT AN ERROR AND NOT AN OUTCOME. Resend sends event types we do not model — `email.sent`,
   * `email.opened` — and an endpoint that treated an unmodelled type as a failure would log an
   * alarm every time the provider added a feature. It is also not recordable as an unmatched
   * event, because `UnmatchedEvent` is about events we could not TIE TO A JOB, not events we
   * chose not to model; conflating them would bury a real forged-event signal under routine
   * traffic. */
  | Readonly<{ parsed: false; because: 'EVENT_NOT_MODELLED' | 'MALFORMED' }>

/** Read Resend's JSON into our vocabulary.
 *
 * TAKES THE STRING, NOT A PARSED OBJECT, so the one place that parses is the one place that can
 * fail to — and a caller cannot hand this a re-serialised body, which is the mistake that makes a
 * genuine signature look invalid.
 *
 * THE TIMESTAMP IS THE PROVIDER'S, NOT OURS. `created_at` is when the provider says it happened;
 * when we heard about it is a different fact and lives in `recorded_at`. A webhook delayed by an
 * hour of retries would otherwise record an hour-late delivery as having just occurred.
 */
export function parseResendEvent(body: string): ParseResult {
  let json: unknown
  try {
    json = JSON.parse(body)
  } catch {
    return { parsed: false, because: 'MALFORMED' }
  }
  if (typeof json !== 'object' || json === null || Array.isArray(json)) {
    return { parsed: false, because: 'MALFORMED' }
  }

  const event = json as Record<string, unknown>

  // THE ORDER OF THESE TWO CHECKS IS THE DISTINCTION, and the first version had it wrong: an
  // absent `type` fell through to the lookup and came back EVENT_NOT_MODELLED. "The provider
  // sent an event we do not model" and "the provider sent something that is not a webhook" are
  // different facts with different remedies — the first is routine and the second means a parser
  // or an endpoint is wrong — and reading a malformed body as unmodelled makes a real failure
  // indistinguishable from ordinary traffic we deliberately ignore.
  if (typeof event.type !== 'string' || event.type === '') {
    return { parsed: false, because: 'MALFORMED' }
  }
  const kind = KIND_BY_EVENT[event.type]
  if (kind === undefined) return { parsed: false, because: 'EVENT_NOT_MODELLED' }

  const data = typeof event.data === 'object' && event.data !== null
    ? event.data as Record<string, unknown>
    : {}
  const emailId = typeof data.email_id === 'string' ? data.email_id : ''
  if (emailId === '') return { parsed: false, because: 'MALFORMED' }

  const createdAt = typeof event.created_at === 'string' ? event.created_at : ''
  const atMs = Date.parse(createdAt)
  if (!Number.isFinite(atMs)) return { parsed: false, because: 'MALFORMED' }

  return {
    parsed: true,
    raw: {
      providerId: providerMessageId(emailId),
      kind,
      atIso: new Date(atMs).toISOString(),
      bounce: kind === 'BOUNCED' ? bounceClassOf(data) : null,
    },
  }
}

/** HARD unless the provider says otherwise, and the asymmetry is deliberate.
 *
 * `record()` already reads a missing class as HARD, for the reason stated there: an unclassified
 * bounce treated as soft retries forever against an address that may never work, and stopping is
 * the recoverable mistake. This keeps the same reading at the parse boundary so the two places
 * cannot disagree — but it returns null rather than HARD when the field is absent, so the single
 * decision stays in `record()` rather than being taken twice. */
function bounceClassOf(data: Record<string, unknown>): BounceClass | null {
  const bounce = typeof data.bounce === 'object' && data.bounce !== null
    ? data.bounce as Record<string, unknown>
    : {}
  const stated = typeof bounce.type === 'string' ? bounce.type.toUpperCase()
    : typeof data.bounce_type === 'string' ? data.bounce_type.toUpperCase()
      : ''
  if (stated.includes('HARD') || stated === 'PERMANENT') return 'HARD'
  if (stated.includes('SOFT') || stated === 'TRANSIENT') return 'SOFT'
  return null
}

// ---------------------------------------------------------------------------------------
// PERSISTENCE SHAPE. One row per verified event, matched or not.
// ---------------------------------------------------------------------------------------

export interface OutcomeRow {
  readonly providerId: ProviderMessageId
  /** Null exactly when `kind` is UNMATCHED. Enforced by a CHECK in the migration too, because
   * this is the column that answers "which send killed this address". */
  readonly messageId: MessageId | null
  readonly kind: Outcome['kind'] | 'UNMATCHED'
  readonly bounce: BounceClass | null
  readonly because: UnmatchedEvent['because'] | null
  readonly occurredAtIso: string
}

/** Turn a VERIFIED event into the row that records it.
 *
 * **IT TAKES AN `AuthenticEvent`, NOT A `Received`, AND THAT IS THE POINT.** The only way to
 * obtain one is `authenticate`, so an unverified event has no path to this function — the same
 * move the branded type was built for, extended one step further.
 *
 * IT USED TO ACCEPT `Received` AND HANDLE THE UNVERIFIED ARM. That was correct until the
 * unauthenticated write path was bounded: unverifiable requests are now counted per hour rather
 * than stored, and a CHECK forbids their verdicts in this table. A function that can still build
 * a row the schema rejects is worse than one that cannot, because it reads as a supported path —
 * so the branch is gone rather than left as defensive code nothing may call.
 *
 * **EVERY VERIFIED EVENT PRODUCES A ROW, INCLUDING THE ONES THAT MATCHED NOTHING.** That is the
 * half worth having: an event whose provider id ties to no job is a fact about this system — a
 * job we lost, an id never recorded, or a replay inside the signature's tolerance — and all
 * three look like nothing happening if the row is dropped for want of something to attach it to.
 * Those require the signing secret, so their volume is bounded by the provider's traffic. */
export function outcomeRow(event: AuthenticEvent, matched: MessageId | null): OutcomeRow {
  if (matched === null) {
    return {
      providerId: event.providerId,
      messageId: null,
      kind: 'UNMATCHED',
      bounce: null,
      because: 'NO_SUCH_JOB',
      occurredAtIso: event.atIso,
    }
  }
  return {
    providerId: event.providerId,
    messageId: matched,
    kind: event.kind,
    // Only a bounce carries a class, matching the CHECK in the migration. `record()` decides that
    // an unclassified bounce is HARD; this preserves what the provider actually said so a wrong
    // suppression can be argued with afterwards.
    bounce: event.kind === 'BOUNCED' ? event.bounce : null,
    because: null,
    occurredAtIso: event.atIso,
  }
}

/** Whether this outcome means the address must never be written to again.
 *
 * SEPARATE FROM THE ROW, and deliberately mirrors `suppressesAddress` on the send side: the
 * message's fate and the address's fate are two subjects. A COMPLAINT suppresses too — somebody
 * marked it as spam, and continuing to write to them is both useless and a reputation cost. */
export function suppressesOnOutcome(row: OutcomeRow): boolean {
  return (row.kind === 'BOUNCED' && row.bounce === 'HARD') || row.kind === 'COMPLAINED'
}
