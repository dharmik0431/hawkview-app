import { type Investigation, type ObservedCondition, type Ownership } from './alert-lifecycle.js'
import { type CurrentState, type IncidentNow, type MessageRef } from './message-source.js'

/** THE UNIONS AS RUNTIME SETS, exhaustive BY THE COMPILER rather than by my care.
 *
 * Each is a Record keyed on its union, so adding a lifecycle state upstream fails to compile
 * here instead of silently becoming a value this module refuses to recognise. A plain array of
 * literals would have compiled while missing one -- which is the same absent-member blind spot
 * that let an INSERT omit a required column. */
const CONDITIONS: Readonly<Record<ObservedCondition, true>> = { ACTIVE: true, CLEARED: true, UNKNOWN: true }
const INVESTIGATIONS: Readonly<Record<Investigation, true>> = { OPEN: true, RESOLVED: true, NONE: true }
const OWNERSHIPS: Readonly<Record<Ownership, true>> = { UNACKNOWLEDGED: true, ACKNOWLEDGED: true }
const known = <T extends string>(set: Readonly<Record<T, true>>, value: string): T | null =>
  Object.prototype.hasOwnProperty.call(set, value) ? (value as T) : null
import { type SqlRunner } from './pipeline-store.js'
import { type VerifiedRecipient } from './routing-policy.js'

/**
 * `CurrentState`, COMPOSED FROM THE DATABASE — the half of the drain-time seam that was missing.
 *
 * `messageSourceOf(state).resolve` already refuses a job whose type has since become
 * record-only. It has never run in production because nothing built the `state` it reads, so
 * the refusal existed and was unreachable. This is that composition.
 *
 * WHY `recipients` IS A REQUIRED ARGUMENT AND NOT A QUERY IN HERE.
 *
 * `VerifiedRecipient` carries `verifiedAt`, and the type's own comment says why: an unverified
 * inbox is a guess about who is listening. **The schema records no such verification.**
 * `notification_preferences` holds `email_enabled`, which is a preference rather than an address
 * or a verification; `users.email` has no verification column; the only `last_verified_at`
 * columns in the schema belong to M365 subscriptions and tenant connections. Every
 * `VerifiedRecipient` in this repository is built in a test.
 *
 * So this cannot honestly answer `recipient()`, and the two available ways to pretend otherwise
 * are both refused here rather than left to a reader's discretion: deriving `verifiedAt` from
 * `email_enabled` invents a verification nobody performed, and defaulting to `null` silently
 * turns every send into `NO_VERIFIED_RECIPIENT` — a silence, which is the worse failure.
 *
 * Making it a required parameter means the caller has to say where verification comes from, and
 * the gap is visible at every call site instead of buried in one function. When operator email
 * verification is built, this is the argument that gets replaced by a query.
 */
export type RecipientSource = (organizationId: string) => Promise<VerifiedRecipient | null>

export function currentStateFrom(runner: SqlRunner, recipients: RecipientSource): CurrentState {
  return {
    /**
     * THE INCIDENT AS IT STANDS NOW, which is the entire point of reading it here rather than
     * trusting what the job was queued with.
     *
     * The four descriptive fields are aggregates over the notification rows that share the
     * incident key, because the incident row itself holds only lifecycle state and timestamps —
     * `alert_incidents` has no first-seen, no last-seen and no counts. A LEFT JOIN, so an
     * incident whose notifications have been pruned still resolves rather than vanishing:
     * a missing incident means MESSAGE_CONTENT_UNAVAILABLE and a drained queue, and an incident
     * with no occurrences is not the same fact as no incident.
     */
    incident: async (ref: MessageRef): Promise<IncidentNow | null> => {
      const rows = await runner.query<{
        alert_type_id: string
        condition: string
        investigation: string
        ownership: string
        first_seen: Date | string | null
        last_seen: Date | string | null
        tenants_affected: string | number | null
        incidents_affected: string | number | null
      }>(
        `SELECT i.alert_type_id,
                i.condition,
                i.investigation,
                i.ownership,
                MIN(n.created_at)                      AS first_seen,
                MAX(n.created_at)                      AS last_seen,
                COUNT(DISTINCT n.customer_tenant_id)   AS tenants_affected,
                COUNT(DISTINCT peer.incident_key)      AS incidents_affected
           FROM alert_incidents i
           LEFT JOIN notifications n
             ON n.organization_id = i.organization_id
            AND n.incident_key = i.incident_key
           -- TYPE_COUNT IS A ROLLUP ACROSS THE ALERT TYPE, not a count of this one incident's
           -- rows. COUNT(n.id) counted NOTIFICATIONS and reported them as incidents, which is
           -- two different things wearing one name. Distinct incident keys of the same type in
           -- the same organisation is what the field says it is.
           LEFT JOIN alert_incidents peer
             ON peer.organization_id = i.organization_id
            AND peer.alert_type_id = i.alert_type_id
          WHERE i.organization_id = $1::uuid
            AND i.incident_key = $2
          GROUP BY i.alert_type_id, i.condition, i.investigation, i.ownership`,
        [ref.organizationId, ref.incidentKey])

      const row = rows[0]
      if (row === undefined) return null

      // A NULL AGGREGATE IS "NO OCCURRENCES", NOT "UNKNOWN TIME". The LEFT JOIN produces nulls
      // for an incident with no notification rows, and the window in the body must not be
      // invented from them — so the incident's own existence carries no timestamps and the
      // caller sees an empty window rather than a fabricated one.
      // NULL STAYS NULL. An empty string is a value that renders, sorts and compares as
      // though it were a time, and the LEFT JOIN produces nulls for an incident with no
      // notification rows. Those mean "nothing observed", never "observed at the epoch".
      const iso = (value: Date | string | null): string | null =>
        value === null ? null : value instanceof Date ? value.toISOString() : new Date(value).toISOString()
      const count = (value: string | number | null): number =>
        value === null ? 0 : typeof value === 'number' ? value : Number.parseInt(value, 10)

      // NARROWED, NOT CAST. The lifecycle types refuse a raw database string, and an `as` here
      // would silence exactly the mismatch this defect was made of: a value the code believes in
      // that the column cannot hold. The CHECK constraints make an unrecognised value unreachable
      // and the vocabulary guard keeps the unions equal to the constraints -- so null here means a
      // real integrity surprise, and the job leaves the queue as MESSAGE_CONTENT_UNAVAILABLE
      // rather than this module guessing what an unknown lifecycle state means.
      const condition = known<ObservedCondition>(CONDITIONS, row.condition)
      const investigation = known<Investigation>(INVESTIGATIONS, row.investigation)
      const ownership = known<Ownership>(OWNERSHIPS, row.ownership)
      if (condition === null || investigation === null || ownership === null) return null

      return {
        alertTypeId: row.alert_type_id as IncidentNow['alertTypeId'],
        condition,
        investigation,
        ownership,
        firstSeenIso: iso(row.first_seen),
        lastSeenIso: iso(row.last_seen),
        tenantsAffected: count(row.tenants_affected),
        incidentsAffected: count(row.incidents_affected),
      }
    },

    /**
     * THE DISPOSITION THE OPERATOR HOLDS TODAY. This is the line the repair turns on: a job
     * queued while the type was enabled must be refused if the type is record-only NOW.
     *
     * Absent means no row, which is not RECORD_ONLY — the catalogue default applies upstream and
     * an organisation that has never expressed a preference has not chosen to stop being told.
     * Returning a tier here for a row that does not exist would be inventing their choice.
     */
    disposition: async (organizationId: string, alertTypeId: string): Promise<string | null> => {
      const rows = await runner.query<{ disposition: string }>(
        `SELECT disposition
           FROM alert_rule_dispositions
          WHERE organization_id = $1::uuid
            AND alert_type_id = $2`,
        [organizationId, alertTypeId])
      return rows[0]?.disposition ?? null
    },

    /** ONE QUESTION, because only one can be answered honestly. The withheld table cannot be
     *  linked to an incident — see the contract — so asking it would produce a provenance claim
     *  this query cannot support. */
    visibility: async (ref) => {
      const rows = await runner.query<{ one: number }>(
        `SELECT 1 AS one
           FROM notifications
          WHERE organization_id = $1::uuid
            AND incident_key = $2
          LIMIT 1`,
        [ref.organizationId, ref.incidentKey])
      // A query that returned nothing has told us nothing, and defaulting an unanswered question
      // to the sending direction is how this defect started.
      return rows.length > 0 ? 'SURFACED' : 'CONTENT_UNAVAILABLE'
    },

    recipient: (organizationId: string) => recipients(organizationId),
  }
}
