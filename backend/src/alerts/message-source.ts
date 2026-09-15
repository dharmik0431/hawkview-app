import { type AlertTypeId } from './alert-catalog.js'
import {
  needsAttention, type Investigation, type ObservedCondition, type Ownership,
} from './alert-lifecycle.js'
import {
  operatorAddressOf,
  type Body, type OperatorAddress,
} from './email-delivery.js'
import { type VerifiedRecipient } from './routing-policy.js'
import { type SendJob } from './send-queue.js'
import { type MessageSource, type Resolution, type WithdrawnReason } from './send-worker.js'

/**
 * WHAT THE MESSAGE SAYS, REBUILT AT SEND TIME.
 *
 * A send job carries a message id, an idempotency key and a retry budget, and nothing about
 * content — no recipient, no body. That is the design rather than a gap: "honour current
 * preferences and suppression at send time rather than at queue time" is unsatisfiable if the
 * message was frozen when it was queued, because an operator who turns a type off between queue
 * and send has changed their mind and a frozen decision ignores them.
 *
 * THE WHOLE OF THE LINK IS IN THE MESSAGE ID, and it is worth saying where it comes from. The
 * pipeline mints `incident/<organizationId>|<incidentKey>` — one message per INCIDENT, derived
 * from the incident rather than the finding, so a second finding on the same incident cannot
 * produce a second email. Parsing it back is therefore reading a key the producer wrote, not
 * inferring structure from a string that happens to have a slash in it. `parseMessageId` refuses
 * anything else rather than guessing.
 *
 * EVERY REFUSAL IS A DECISION SOMEBODY MADE, and that is why the reasons are closed. A free-text
 * "because" here is how "why was this MSP never told" becomes unanswerable six months later.
 */

// ---------------------------------------------------------------------------------------
// THE LINK
// ---------------------------------------------------------------------------------------

export type MessageRef = Readonly<{ organizationId: string; incidentKey: string }>

/** Read a message id back into the incident it was minted from.
 *
 * NULL RATHER THAN A THROW, and null becomes `MESSAGE_CONTENT_UNAVAILABLE` rather than an error:
 * a job whose id this layer cannot read is a job that must leave the queue saying so, not one
 * that fails a worker which a scheduler shares a process with.
 *
 * THE SPLIT IS ON THE FIRST `|` ONLY. An incident key may contain one — it is composed from rule
 * and subject upstream — and splitting on every separator would truncate the key and match the
 * wrong incident, or none. The organisation id cannot contain one, so the first is the boundary. */
export function parseMessageId(messageId: string): MessageRef | null {
  const PREFIX = 'incident/'
  if (!messageId.startsWith(PREFIX)) return null
  const rest = messageId.slice(PREFIX.length)
  const separator = rest.indexOf('|')
  if (separator <= 0 || separator === rest.length - 1) return null
  return {
    organizationId: rest.slice(0, separator),
    incidentKey: rest.slice(separator + 1),
  }
}

// ---------------------------------------------------------------------------------------
// WHAT CURRENT STATE HAS TO ANSWER
// ---------------------------------------------------------------------------------------

/** The incident as it stands NOW, not as it stood when the job was queued. */
export interface IncidentNow {
  readonly alertTypeId: AlertTypeId
  /** **THE LIFECYCLE'S OWN TYPE, NOT A STRING.** It was `string`, and that is exactly how this
   * module came to test for `CLOSED` and `RESOLVED` — two values `alert_incidents_condition_check`
   * would refuse on insert, described here in a comment as "the lifecycle vocabulary". A `string`
   * accepts any vocabulary, including an invented one.
   *
   * ALL THREE AXES CARRY THEIR OWN TYPE for that reason, not just this one. Two of us fixed the
   * invented-vocabulary defect independently and neither fix was complete: typing `condition`
   * stops an invented CONDITION, and it cannot stop the module ignoring the axis a person
   * actually moves. */
  readonly condition: ObservedCondition
  /** UNACKNOWLEDGED | ACKNOWLEDGED. Required because a CLEARED condition on an UNACKNOWLEDGED
   * incident STILL wants attention: the situation stopping is not the same as anybody having
   * seen that it stopped. */
  readonly ownership: Ownership
  /** OPEN | RESOLVED | NONE — the axis a PERSON moves. Reading it is the difference between
   * honouring an operator's judgement and emailing them about work they have already closed. */
  readonly investigation: Investigation
  /** NULL WHEN NOTHING HAS BEEN OBSERVED, not an empty string. An incident whose notifications
   * have been pruned has no window, and a window is a claim about when something happened —
   * emitting one built from absent rows puts a date range in an email nothing observed. */
  readonly firstSeenIso: string | null
  readonly lastSeenIso: string | null
  readonly tenantsAffected: number
  readonly incidentsAffected: number
}

/** Everything the resolver needs, and nothing else. Narrow on purpose: this seam cannot reach a
 * finding, a user record, or anything it could leak into a subject line. */
export interface CurrentState {
  incident(ref: MessageRef): Promise<IncidentNow | null>
  /** The disposition the operator holds for this type TODAY. `RECORD_ONLY` means they have
   * chosen to stop being told. */
  disposition(organizationId: string, alertTypeId: AlertTypeId): Promise<string | null>
  /** Who would receive it now. An MSP-side inbox somebody verified, or null. */
  recipient(organizationId: string): Promise<VerifiedRecipient | null>
  /** WHY THIS INCIDENT IS NOT VISIBLE IN THE PRODUCT — THREE STATES, NOT A BOOLEAN.
   *
   * The drain reads the CURRENT disposition, and that is not enough: a job queued while a type
   * was enabled, withheld while it was record-only, and drained after the operator re-enabled
   * the type will find the disposition sendable again and go. The decision recorded at the time
   * is what settles it, and the current setting cannot recover it.
   *
   * Asked as "is there a notification for this incident" rather than by reading
   * `alert_withheld_notices` directly, because that table is keyed on
   * (organization_id, dedupe_key) and carries NO incident_key -- there is no join from a
   * per-incident message id to it. The two are complementary by construction: the pipeline
   * writes a notification only where no withheld notice exists for the same dedupe key, so an
   * incident with no notifications is one whose findings were all withheld.
   *
   * THERE IS NO 'WITHHELD' STATE, AND ITS ABSENCE IS THE POINT.
   *
   * "No notification" has two causes — the finding was withheld, or its notification was pruned
   * — and only the first would justify `ALERT_TYPE_DISABLED`. I previously distinguished them
   * by asking whether a withheld notice existed for this organisation and alert type, and that
   * does not establish provenance: ANOTHER INCIDENT's withheld record would mislabel this
   * incident's pruned content as a deliberate suppression. It was the same substitution one
   * level along — "recorded as withheld for this finding" replaced by "something was withheld
   * for this org and type".
   *
   * EXACT LINKAGE IS NOT AVAILABLE. `alert_withheld_notices` carries `finding_id` and
   * `dedupe_key` but no `incident_key`, and an incident key is DERIVED at pipeline time from
   * the finding's subject by `incidentGrouping`. Recomputing that derivation in SQL would put
   * a second copy of the keying rule in the database, which is the defect class this release
   * exists to close. So the honest report is that origin cannot be established here.
   *
   * What remains is true and sufficient: nothing about this incident is visible in the product,
   * so there is no message to build. It still does not send — emailing about a finding nobody
   * can find is the original harm — and it no longer asserts a history it cannot support. */
  visibility(ref: MessageRef): Promise<'SURFACED' | 'CONTENT_UNAVAILABLE'>
}

// ---------------------------------------------------------------------------------------
// THE RESOLVER
// ---------------------------------------------------------------------------------------

/** WHO DECIDES WHETHER THIS STILL WANTS ATTENTION: `alert-lifecycle.ts`, not this file.
 *
 /** WHO DECIDES WHETHER THIS STILL WANTS ATTENTION: `alert-lifecycle.ts`, not this file.
 *
 * TWO INDEPENDENT FIXES MET HERE AND NEITHER WAS ENOUGH ALONE.
 *
 * One typed `condition` as `ObservedCondition` and narrowed the withdrawing set to
 * `['CLEARED']`, which kills the invented `CLOSED`/`RESOLVED` spellings at compile time — a
 * guarantee a list cannot give. But `RESOLVED` is an INVESTIGATION value, and that module never
 * read the investigation axis, so resolving an incident still did not stop its email.
 *
 * The other split the sets by axis and then delegated here, which catches `RESOLVED` and
 * `NONE` — a record that never opened an investigation, which `needsAttention` returns false
 * for — and catches that `CLEARED` does NOT settle it while ownership is `UNACKNOWLEDGED`.
 * But it left all three axes as `string`, so an invented value was still expressible.
 *
 * Combined: the lifecycle's types make an invented value a compile error, and the lifecycle's
 * own rule decides what the real values mean. No set is maintained in this file, because a
 * second place deciding "actionable" is the defect class this release closes.
 *
 * `UNKNOWN` IS DELIBERATELY NOT A WITHDRAWAL. It means HawkView cannot currently see whether the
 * condition still holds, which is not the same as knowing it has gone — and treating "we cannot
 * tell" as "nothing to say" is the absence-reads-as-reassurance failure this product exists to
 * prevent. `needsAttention` keeps it sending, and a control pins it. */

export function messageSourceOf(state: CurrentState): MessageSource {
  return {
    resolve: async (job: SendJob): Promise<Resolution> => {
      const ref = parseMessageId(job.messageId)
      if (ref === null) return withdrawn('MESSAGE_CONTENT_UNAVAILABLE')

      const incident = await state.incident(ref)
      // A job whose incident has been pruned or never existed. Not an error: the queue must be
      // drainable when the thing it was about is gone.
      if (incident === null) return withdrawn('MESSAGE_CONTENT_UNAVAILABLE')

      // DELEGATED, ALL THREE AXES.
      //
      // AN EARLIER VERSION OF THIS COMMENT CLAIMED THE RULE FAILS CLOSED. IT DOES NOT.
      // needsAttention ends in `condition !== 'CLEARED' || ownership === 'UNACKNOWLEDGED'`, so
      // a condition nobody recognises is not CLEARED and therefore SENDS. The safety here comes
      // from somewhere else entirely: the values are constrained by the database, the unions are
      // held equal to those CHECK constraints by a guard, and currentStateFrom NARROWS each
      // column rather than casting — an unrecognised value makes the incident unreadable before
      // it ever reaches this line.
      //
      // That is a real protection and a different one, and the distinction matters because the
      // day someone composes CurrentState without narrowing, this rule will send on a value it
      // has never seen. A comment asserting a guarantee is a claim, and that one outran its code.
      if (!needsAttention(incident)) {
        return withdrawn('INCIDENT_NO_LONGER_ACTIONABLE')
      }

      // THE DECISION RECORDED AT THE TIME, which the current disposition cannot recover. This
      // is the re-enable case: type record-only when the finding arrived, so nothing was
      // surfaced; type enabled again by the time the queued job drains.
      // NOT ALERT_TYPE_DISABLED. That reason asserts somebody turned the type off, and this
      // query cannot know whether they did — see the contract above.
      if ((await state.visibility(ref)) === 'CONTENT_UNAVAILABLE') {
        return withdrawn('MESSAGE_CONTENT_UNAVAILABLE')
      }

      // READ NOW, NOT AT QUEUE TIME. This is the line the whole seam exists for.
      const disposition = await state.disposition(ref.organizationId, incident.alertTypeId)
      if (disposition === 'RECORD_ONLY') return withdrawn('ALERT_TYPE_DISABLED')

      const recipient = await state.recipient(ref.organizationId)
      if (recipient === null) return withdrawn('NO_VERIFIED_RECIPIENT')

      return {
        send: true,
        // THE ONLY CONSTRUCTOR FOR AN ADDRESS TAKES A VERIFIED RECIPIENT, so "never a customer
        // end user" is not a rule this function follows — it is a value it cannot build.
        to: operatorAddressOf(recipient) satisfies OperatorAddress,
        body: bodyFor(incident),
      }
    },
  }
}

const withdrawn = (because: WithdrawnReason): Resolution => ({ send: false, because })

/** The body, from the incident as it stands now.
 *
 * NO SLOT HERE CAN CARRY A TENANT NAME OR A PERSON, and that is a property of `BodyLine` rather
 * than of this function: the union has four arms and none of them takes free text. What reaches
 * an inbox is a count, a window, and an opaque digest id resolved server-side behind auth.
 *
 * A BODY IS NON-EMPTY BY TYPE, so this returns a tuple rather than an array — an email that
 * announces something happened with no way to know what is worse than not sending. */
function bodyFor(incident: IncidentNow): Body {
  return [
    {
      kind: 'TYPE_COUNT',
      alertTypeId: incident.alertTypeId,
      tenantsAffected: incident.tenantsAffected,
      incidentsAffected: incident.incidentsAffected,
    },
    // THE WINDOW IS OMITTED WHEN THERE IS NONE, rather than rendered from absent values. The
    // type refused the nullable version outright, which is the right refusal: a WINDOW segment
    // is a claim that something was observed between two times, and an incident with no
    // notification rows cannot support it. One fewer sentence beats a fabricated date range.
    ...(incident.firstSeenIso !== null && incident.lastSeenIso !== null
      ? [{ kind: 'WINDOW' as const, fromIso: incident.firstSeenIso, toIso: incident.lastSeenIso }]
      : []),
  ]
}
