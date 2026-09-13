import {
  asAlertTypeId, asDisposition, dispositionKey,
  type DispositionKey, type Dispositions, type ExistingIncident, type FindingRow,
  type IncidentWrite, type NotificationWrite, type PipelineStore, type SendJobWrite,
  type UnreadableDisposition,
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

/** THE SECOND HALF OF THE FIRST-RUN BOUND, and it belongs somewhere findable rather than inside
 * a SQL string.
 *
 * A tick reads at most 24 hours of findings (`HAWKVIEW_ALERT_READ_WINDOW_HOURS`) AND at most this
 * many rows. Above this in one window, a tick silently takes the first 5000 by `observed_at` and
 * the rest wait for the next one. **The bound is correct** — an unbounded read inside an
 * admission budget is the worse option, because the budget is shared with collection and
 * collection outranks alerting. But anybody forecasting a first run needs both numbers, and until
 * this constant existed the second one was only discoverable by reading the query. */
export const MAX_FINDINGS_PER_TICK = 5000

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
    async findOpenFindings(sinceIso) {
      const rows = await runner.query<{
        id: string; organization_id: string; customer_tenant_id: string; rule_id: string
        dedupe_key: string; subject_type: string; subject_id: string; severity: string
        state: string; observed_at: Date
      }>(
        `SELECT id, organization_id, customer_tenant_id, rule_id, dedupe_key, subject_type,
                subject_id, severity, state, observed_at
           FROM identity_risk_findings
          WHERE state = 'OPEN' AND observed_at >= $1::timestamptz
          ORDER BY observed_at, id
          LIMIT ${MAX_FINDINGS_PER_TICK}`,
        [sinceIso])
      return rows.map((row): FindingRow => ({
        id: row.id,
        organizationId: row.organization_id,
        customerTenantId: row.customer_tenant_id,
        ruleId: row.rule_id,
        dedupeKey: row.dedupe_key,
        subjectType: row.subject_type,
        subjectId: row.subject_id,
        severity: row.severity,
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
    ) {
      if (incidents.length === 0 && notifications.length === 0 && jobs.length === 0) {
        return { incidentsWritten: 0, notificationsWritten: 0, jobsWritten: 0 }
      }
      return runner.transaction(async (tx) => {
        let incidentsWritten = 0
        let notificationsWritten = 0
        let jobsWritten = 0

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
        // to act on. `occurrence_count` increments on conflict, which is how a repeat finding on
        // one subject reads as "again" rather than as a second row.
        for (const each of notifications) {
          notificationsWritten += await tx.execute(
            `INSERT INTO notifications
               (id, organization_id, customer_tenant_id, event_type, category, severity,
                title, description, dedupe_key, source, incident_key, alert_type_id,
                occurrence_count, first_occurred_at, last_occurred_at, created_at, updated_at)
             VALUES (gen_random_uuid(), $1, $2::uuid, $3, $4, $5, $6, $7, $8, 'identity-risk', $9, $11,
                     1, $10::timestamptz, $10::timestamptz, now(), now())
             ON CONFLICT (organization_id, dedupe_key) DO UPDATE
                SET last_occurred_at = EXCLUDED.last_occurred_at,
                    occurrence_count = notifications.occurrence_count + 1,
                    incident_key = EXCLUDED.incident_key,
                    alert_type_id = EXCLUDED.alert_type_id,
                    severity = EXCLUDED.severity,
                    category = EXCLUDED.category,
                    resolved_at = NULL,
                    updated_at = now()`,
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
        return { incidentsWritten, notificationsWritten, jobsWritten }
      })
    },
  }
}
