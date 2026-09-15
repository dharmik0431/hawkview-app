import { MAX_FINDINGS_PER_TICK } from './finding-pipeline.js'
import {
  asAlertTypeId, asDisposition, dispositionKey, scopedNoticeKey,
  type DispositionKey, type Dispositions, type ExistingIncident, type FindingRow,
  type IncidentWrite, type NotificationWrite, type PipelineStore, type SendJobWrite,
  type UnreadableDisposition, type WithheldNoticeWrite,
} from './finding-pipeline.js'
import { type Severity } from './alert-type.js'

/**
 * THE STORE THAT SHIPS, extracted so a test can drive it.
 *
 * **IT USED TO LIVE INSIDE `AlertIntakeService` AND NO TEST HAD EVER EXERCISED IT.** The
 * integration tests drove a `storeFor(client)` written inside the test file by the same hand as
 * the assertions — so five green tests were evidence about a store that does not ship, and the
 * one that does was covered by nothing.
 *
 * THAT WAS NOT TIDINESS: THE TWO STORES ALREADY DISAGREED. Production's `findOpenFindings` ended
 * `LIMIT 5000` and the test's had no limit at all, so no test could reach that boundary. One
 * disagreement found by reading means the set of disagreements was not known to be empty — which
 * is the whole argument for pointing the tests at this file instead.
 *
 * RAW SQL RATHER THAN THE PRISMA CLIENT, deliberately: these tables are new and the point is to
 * prove the columns exist and the constraints hold, not to prove the ORM can spell them.
 */

export { MAX_FINDINGS_PER_TICK } from './finding-pipeline.js'

/** The narrow slice of a database this needs: two shapes of statement and a transaction.
 *
 * AN INTERFACE RATHER THAN `PrismaService`, so the same code runs against the production client
 * and against a bare `pg.Client` in a test. Nothing here can reach for a model it was not given,
 * and there is no second implementation of the SQL to drift from this one. */
export interface SqlRunner {
  query<T>(sql: string, params: readonly unknown[]): Promise<readonly T[]>
  execute(sql: string, params: readonly unknown[]): Promise<number>
  /** ONE TRANSACTION SPANNING ALL THREE WRITES. See `commit`. */
  transaction<T>(run: (tx: SqlRunner) => Promise<T>): Promise<T>
}

export function pipelineStore(runner: SqlRunner): PipelineStore {
  return {
    async findOpenFindings(sinceIso, activeAtIso = new Date().toISOString()) {
      const rows = await runner.query<{
        id: string; organization_id: string; customer_tenant_id: string; rule_id: string
        dedupe_key: string; subject_type: string; subject_id: string
        state: string; observed_at: Date
      }>(
        `SELECT id, organization_id, customer_tenant_id, rule_id, dedupe_key, subject_type,
                subject_id, state, observed_at
           FROM identity_risk_findings
          WHERE state = 'OPEN' AND observed_at >= $1::timestamptz
            AND expires_at > $2::timestamptz
          ORDER BY observed_at, id
          -- ONE PAST THE CAP, so the tick can say whether it was TRUNCATED without a second
          -- COUNT on every run. runIntake slices back to the cap; the extra row exists only
          -- to answer "was there more".
          LIMIT ${MAX_FINDINGS_PER_TICK + 1}`,
        [sinceIso, activeAtIso])
      return rows.map((row): FindingRow => ({
        id: row.id,
        organizationId: row.organization_id,
        customerTenantId: row.customer_tenant_id,
        ruleId: row.rule_id,
        dedupeKey: row.dedupe_key,
        subjectType: row.subject_type,
        subjectId: row.subject_id,
        state: row.state,
        observedAtIso: new Date(row.observed_at).toISOString(),
      }))
    },

    async findExistingIncidents(organizationIds) {
      if (organizationIds.length === 0) return []
      const rows = await runner.query<{ organization_id: string; incident_key: string }>(
        'SELECT organization_id, incident_key FROM alert_incidents WHERE organization_id = ANY($1::uuid[])',
        [organizationIds])
      return rows.map((row): ExistingIncident => ({
        organizationId: row.organization_id, incidentKey: row.incident_key,
      }))
    },

    async loadDispositions(organizationIds) {
      const byOrganizationAndAlertType = new Map<DispositionKey, Severity>()
      const anyRecipientByOrganization = new Map<string, boolean>()
      const unreadable: UnreadableDisposition[] = []
      if (organizationIds.length === 0) {
        return { byOrganizationAndAlertType, anyRecipientByOrganization, unreadable }
      }

      const dispositions = await runner.query<{
        organization_id: string; alert_type_id: string; disposition: string
      }>(
        `SELECT organization_id, alert_type_id, disposition
           FROM alert_rule_dispositions
          WHERE organization_id = ANY($1::uuid[])`,
        [organizationIds])
      for (const row of dispositions) {
        // THE ONLY DOOR FROM A STORED STRING TO A KEY. A value the catalogue does not declare is
        // collected rather than keyed: it is a preference the MSP set that the product cannot act
        // on, and defaulting it would read as though they had never chosen. Historically this is
        // exactly what a rule id stored in this column did, silently.
        const alertTypeId = asAlertTypeId(row.alert_type_id)
        if (alertTypeId === null) {
          unreadable.push({
            alertTypeId: row.alert_type_id,
            disposition: row.disposition,
            because: 'UNKNOWN_ALERT_TYPE',
          })
          continue
        }
        // AND THE VALUE, for the same reason. The CHECK constraint refuses one today, but a
        // database migrated before the vocabulary changed holds the old spelling — and that is
        // precisely the state the forward migration exists for, so it is reachable.
        const disposition = asDisposition(row.disposition)
        if (disposition === null) {
          unreadable.push({
            alertTypeId: row.alert_type_id,
            disposition: row.disposition,
            because: 'UNKNOWN_DISPOSITION',
          })
          continue
        }
        byOrganizationAndAlertType.set(
          dispositionKey(row.organization_id, alertTypeId), disposition)
      }

      // EMAIL IS OFF UNLESS SOMEBODY TURNED IT ON, AND ABSENCE IS OFF TOO. `bool_or` over no rows
      // is NULL, and an organisation with no preference row at all returns nothing — both must
      // read as "nobody can be reached", or a brand-new MSP would be sent to before anybody there
      // had chosen to be. Every organisation is seeded false first so the absent case cannot be
      // mistaken for the unset case.
      for (const id of organizationIds) anyRecipientByOrganization.set(id, false)
      const recipients = await runner.query<{
        organization_id: string; any_recipient: boolean | null
      }>(
        `SELECT organization_id, bool_or(email_enabled) AS any_recipient
           FROM notification_preferences
          WHERE organization_id = ANY($1::uuid[])
          GROUP BY organization_id`,
        [organizationIds])
      for (const row of recipients) {
        anyRecipientByOrganization.set(row.organization_id, row.any_recipient === true)
      }
      return { byOrganizationAndAlertType, anyRecipientByOrganization, unreadable } satisfies Dispositions
    },

    /** How many notification rows name an alert type the catalogue no longer declares.
     *
     * SCOPED TO THE ORGANISATIONS THIS TICK TOUCHED and served by
     * `notifications(organization_id, alert_type_id)`, so it is one indexed count rather than a
     * scan. Rows with no alert type at all are not alerts and are excluded — absence is not an
     * unknown type. */
    async countUnknownAlertTypes(organizationIds, declared) {
      if (organizationIds.length === 0) return 0
      const rows = await runner.query<{ n: number }>(
        `SELECT count(*)::int AS n
           FROM notifications
          WHERE organization_id = ANY($1::uuid[])
            AND alert_type_id IS NOT NULL
            AND NOT (alert_type_id = ANY($2::varchar[]))`,
        [organizationIds, declared])
      return Number(rows[0]?.n ?? 0)
    },

    /** ALL THREE WRITES OR NONE. Incidents and jobs were two calls once, and a budget yield
     * between them left an incident with no job — which every later run skips as
     * `INCIDENT_ALREADY_OPEN`, so the alert was never sent and nothing reported it. The
     * notification row is the third, and it joins the same transaction rather than following it:
     * an incident whose notification failed separately is invisible in-app while still counting
     * as written, which is the same defect in the surface nobody was testing. */
    async commit(
      incidents: readonly IncidentWrite[],
      notifications: readonly NotificationWrite[],
      jobs: readonly SendJobWrite[],
      withheld: readonly WithheldNoticeWrite[],
    ) {
      if (incidents.length === 0 && notifications.length === 0 && jobs.length === 0
        && withheld.length === 0) {
        return {
          incidentsWritten: 0, notificationsWritten: 0, jobsWritten: 0, noticesWithheld: 0,
        }
      }
      return runner.transaction(async (tx) => {
        let incidentsWritten = 0
        let notificationsWritten = 0
        let jobsWritten = 0
        let noticesWithheld = 0

        for (const each of incidents) {
          incidentsWritten += await tx.execute(
            `INSERT INTO alert_incidents
               (id, organization_id, incident_key, alert_type_id, ownership, "condition",
                investigation, ownership_at, condition_at, investigation_at, updated_at)
             VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6,
                     $7::timestamptz, $7::timestamptz, $7::timestamptz, now())
             ON CONFLICT (organization_id, incident_key) DO NOTHING`,
            [each.organizationId, each.incidentKey, each.alertTypeId, each.ownership,
              each.condition, each.investigation, each.atIso])
        }

        // THE IN-APP HALF. Without this every incident is a projection over the empty set: the
        // bell shows nothing, the unread count counts nothing, and read and dismiss have nothing
        // to act on.
        //
        // **DO NOTHING, NOT DO UPDATE, AND THE CHANGE IS THE POINT OF A2.** This was
        // `DO UPDATE SET occurrence_count = occurrence_count + 1, resolved_at = NULL, …`, which
        // made a repeat finding read as "again" rather than as a second row. Two things retired
        // that:
        //
        // 1. **The per-finding gate reaches the conflict branch first.** A finding with a
        //    notification row is decided and is skipped before this statement runs, so the repeat
        //    case no longer arrives here at all. One finding is one row; "again" is a SECOND
        //    finding with its own dedupe key and its own row.
        // 2. **So what still reaches the conflict branch is only a race**, and there DO UPDATE
        //    did real harm. Driven on the real path: tick A reads and decides, tick B writes, a
        //    person DISMISSES it, A commits — and the update cleared `resolved_at` and bumped the
        //    count. Un-dismissing something a person dismissed, which is the defect CASE 1 exists
        //    to prevent, reachable again through a second concurrent tick.
        //
        // `occurrence_count` is not cosmetic: apply/revert digests it as a watched field, so a
        // spurious bump makes an apply's version predicate stop matching.
        //
        // MOVING THE DECISION READ INSIDE THIS TRANSACTION WOULD NOT HAVE FIXED IT. Under READ
        // COMMITTED both ticks can still read before either commits; the unique index is what
        // actually serialises them, so the behaviour ON conflict is the thing that decides the
        // outcome. This is the smaller change and it is the one that closes the harm.
        //
        // ⚠ THE OTHER FIELDS STOP BEING REFRESHED TOO — severity, category, incident_key. That is
        // already true with the gate in place, since a decided finding never returns here: a row
        // records the tier that was in force WHEN THE ALERT FIRED, and a later change of setting
        // does not restyle it. See the note in the alerting handoff.
        for (const each of notifications) {
          notificationsWritten += await tx.execute(
            // **THE EXCLUSION IS IN THE WRITE, NOT IN A READ TAKEN EARLIER.** The gate reads
             // decisions before this transaction opens, so a writer that paused cannot be
             // protected by it — it passed the gate before the world changed. `NOT EXISTS` is
             // evaluated HERE, against committed state, so a stale decision to notify cannot
             // resurrect a finding that has since been durably withheld. The gate is now an
             // optimisation; this is the guarantee.
             `INSERT INTO notifications
               (id, organization_id, customer_tenant_id, event_type, category, severity,
                title, description, dedupe_key, source, incident_key, alert_type_id,
                occurrence_count, first_occurred_at, last_occurred_at, created_at, updated_at)
             SELECT gen_random_uuid(), $1, $2::uuid, $3, $4, $5, $6, $7, $8::text, 'identity-risk', $9, $11,
                    1, $10::timestamptz, $10::timestamptz, now(), now()
              WHERE NOT EXISTS (
                SELECT 1 FROM alert_withheld_notices
                 WHERE organization_id = $1 AND dedupe_key = $8::text)
             ON CONFLICT (organization_id, dedupe_key) DO NOTHING`,
            [each.organizationId, each.customerTenantId, each.eventType, each.category,
              each.severity, each.title, each.description, each.dedupeKey, each.incidentKey,
              each.atIso, each.alertTypeId])
        }

        for (const each of jobs) {
          jobsWritten += await tx.execute(
            `INSERT INTO alert_send_jobs
               (id, message_id, idempotency_key, state, attempts_made, max_attempts,
                not_before_at, updated_at)
             VALUES (gen_random_uuid(), $1, $2, 'READY', 0, $3, $4::timestamptz, now())
             ON CONFLICT (message_id) DO NOTHING`,
            [each.messageId, each.idempotencyKey, each.maxAttempts, each.notBeforeIso])
        }
        // **THE DECISION NOT TO TELL ANYBODY, IN THE SAME TRANSACTION AS EVERYTHING ELSE.** A
        // withheld notice that failed on its own is a notice the next tick gives — the replay this
        // exists to prevent, arriving down the one path nobody would think to test.
        //
        // DO NOTHING ON CONFLICT, not DO UPDATE. The row records that a decision was taken and
        // when; retaking it must not move the timestamp, or "withheld since" would creep forward
        // on every tick and stop meaning anything. This is the opposite choice from the
        // notification insert above, and deliberately so.
        for (const each of withheld) {
          noticesWithheld += await tx.execute(
            // THE MIRROR OF THE GUARD ON THE NOTIFICATION WRITE, for the same reason and in the
             // same place. A finding that has already been TOLD must not also be recorded as
             // withheld: the row would say the MSP was spared something they were in fact sent.
             `INSERT INTO alert_withheld_notices
               (id, organization_id, dedupe_key, alert_type_id, finding_id, because, withheld_at)
             SELECT gen_random_uuid(), $1, $2::text, $3, $4::uuid, $5, now()
              WHERE NOT EXISTS (
                SELECT 1 FROM notifications
                 WHERE organization_id = $1 AND dedupe_key = $2::text)
             ON CONFLICT (organization_id, dedupe_key) DO NOTHING`,
            [each.organizationId, each.dedupeKey, each.alertTypeId, each.findingId, each.because])
        }

        return { incidentsWritten, notificationsWritten, jobsWritten, noticesWithheld }
      })
    },

    /** THE UNION OF THE TWO TABLES THAT RECORD A DECISION. `notifications` says this finding was
     * told; `alert_withheld_notices` says it was deliberately not told. Either way it must not be
     * decided again.
     *
     * **A UNION RATHER THAN TWO LOOKUPS IN AN ORDER, AND THAT IS THE POINT.** The two tables are
     * not a partition — R004, measured: overlapping ticks whose dispositions differ can write one
     * of each for the same finding. Consulting them in sequence would make the gate's answer
     * depend on which ran first. Unioned, a finding in either table is decided, either way.
     *
     * ONE ROUND TRIP, AND BOUNDED BY THE KEYS ASKED ABOUT rather than by a window — so the cost
     * follows the tick's size and not the table's. `= ANY` rather than an IN-list built by
     * string concatenation, which is how a 5000-finding tick would otherwise become a 5000-term
     * query and a place for an injection to hide. */
    async findDecidedNoticeKeys(organizationIds, dedupeKeys) {
      if (organizationIds.length === 0 || dedupeKeys.length === 0) return new Set<string>()
      const rows = await runner.query<{ organization_id: string; dedupe_key: string }>(
        `SELECT organization_id, dedupe_key FROM notifications
           WHERE organization_id = ANY($1::uuid[]) AND dedupe_key = ANY($2::text[])
         UNION
         SELECT organization_id, dedupe_key FROM alert_withheld_notices
           WHERE organization_id = ANY($1::uuid[]) AND dedupe_key = ANY($2::text[])`,
        [organizationIds, dedupeKeys])
      return new Set(rows.map((row) => scopedNoticeKey(row.organization_id, row.dedupe_key)))
    },
  }
}
