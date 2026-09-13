import { Injectable, Logger } from '@nestjs/common'
import { PrismaService } from '../prisma/prisma.service.js'
import {
  runIntake,
  type Dispositions, type ExistingIncident, type FindingRow, type IncidentWrite,
  type IntakeReport, type PipelineStore, type SendJobWrite, type Watermark,
} from './finding-pipeline.js'

/**
 * THE PRODUCTION CALLER. Until this existed, `runIntake` was called by nothing and the only
 * `PipelineStore` lived inside a test file — so the chain was joined by the test rather than by
 * the product.
 *
 * RAW SQL RATHER THAN THE PRISMA CLIENT, deliberately and for the same reason the integration
 * test uses it: these tables are new, and the point is to prove the columns exist rather than to
 * prove the ORM can spell them. It goes through `PrismaService` so there is one connection pool
 * and one place that reads `DATABASE_URL`.
 */
@Injectable()
export class AlertIntakeService {
  private readonly logger = new Logger(AlertIntakeService.name)

  constructor(private readonly prisma: PrismaService) {}

  /** Run one tick, inside the window the caller gives it.
   *
   * NEVER THROWS INTO THE CASCADE. Every failure is logged and reported, because this stage sits
   * in a handler where a throw would abort the collectors that run after it — and collection
   * outranks alerting, always. */
  async runOnce(deadlineAt: number, tickAt: Date = new Date()): Promise<IntakeReport | null> {
    const watermark = configuredWatermark()
    if (watermark === null) {
      // A REFUSAL, NOT A DEFAULT. See `configuredWatermark`. Logged once per tick so it is
      // visible without being alarming: nothing is broken, nothing has been decided.
      this.logger.warn(JSON.stringify({
        event: 'alert_intake', status: 'NOT_CONFIGURED',
        detail: 'HAWKVIEW_ALERT_WATERMARK_ISO is unset; intake will not run until it is chosen.',
      }))
      return null
    }

    try {
      const report = await runIntake(
        this.store(), watermark, tickAt.toISOString(), deadlineAt, readSinceIso(tickAt))

      this.logger.log(JSON.stringify({
        event: 'alert_intake',
        status: report.yieldedOnBudget ? 'YIELDED' : 'COMPLETED',
        findingsRead: report.findingsRead,
        incidentsWritten: report.incidentsWritten,
        jobsWritten: report.jobsWritten,
        // COUNTS BY REASON, NOT A TOTAL. "17 skipped" collapses waiting-on-the-classifier with
        // never-writable, which is the collapse this feature has now fixed three times.
        skipped: countByReason(report.skipped),
        unmappedRules: report.unmappedRules,
        accountingProblems: report.accountingProblems,
      }))
      return report
    } catch (error) {
      // A settled intake failure does not suppress ordinary collectors. Same rule the maintenance
      // stage states in its own comment, and the same reason.
      this.logger.warn(JSON.stringify({
        event: 'alert_intake', status: 'FAILED',
        detail: error instanceof Error ? error.message : 'unknown',
      }))
      return null
    }
  }

  private store(): PipelineStore {
    const prisma = this.prisma
    return {
      async findOpenFindings(sinceIso) {
        const rows = await prisma.$queryRawUnsafe<readonly {
          id: string; organization_id: string; customer_tenant_id: string; rule_id: string
          subject_type: string; subject_id: string; severity: string; state: string
          observed_at: Date
        }[]>(
          `SELECT id, organization_id, customer_tenant_id, rule_id, subject_type, subject_id,
                  severity, state, observed_at
             FROM identity_risk_findings
            WHERE state = 'OPEN' AND observed_at >= $1::timestamptz
            ORDER BY observed_at, id
            LIMIT 5000`,
          sinceIso)
        return rows.map((row): FindingRow => ({
          id: row.id,
          organizationId: row.organization_id,
          customerTenantId: row.customer_tenant_id,
          ruleId: row.rule_id,
          subjectType: row.subject_type,
          subjectId: row.subject_id,
          severity: row.severity,
          state: row.state,
          observedAtIso: row.observed_at.toISOString(),
        }))
      },

      async findExistingIncidents(organizationIds) {
        if (organizationIds.length === 0) return []
        const rows = await prisma.$queryRawUnsafe<readonly {
          organization_id: string; incident_key: string
        }[]>(
          'SELECT organization_id, incident_key FROM alert_incidents WHERE organization_id = ANY($1::uuid[])',
          organizationIds)
        return rows.map((row): ExistingIncident => ({
          organizationId: row.organization_id, incidentKey: row.incident_key,
        }))
      },

      async loadDispositions(organizationIds) {
        const byOrganizationAndRule = new Map<string, string>()
        const anyRecipientByOrganization = new Map<string, boolean>()
        if (organizationIds.length === 0) return { byOrganizationAndRule, anyRecipientByOrganization }

        const dispositions = await prisma.$queryRawUnsafe<readonly {
          organization_id: string; rule_id: string; disposition: string
        }[]>(
          'SELECT organization_id, rule_id, disposition FROM alert_rule_dispositions WHERE organization_id = ANY($1::uuid[])',
          organizationIds)
        for (const row of dispositions) {
          byOrganizationAndRule.set(`${row.organization_id}|${row.rule_id}`, row.disposition)
        }

        // EMAIL IS OFF UNLESS SOMEBODY TURNED IT ON, AND ABSENCE IS OFF TOO. `bool_or` over no
        // rows is NULL, and an organisation with no preference row at all returns nothing — both
        // must read as "nobody can be reached", or a brand-new MSP would be sent to before
        // anybody there had chosen to be. Every organisation is seeded false first so the
        // absent case cannot be mistaken for the unset case.
        for (const id of organizationIds) anyRecipientByOrganization.set(id, false)
        const recipients = await prisma.$queryRawUnsafe<readonly {
          organization_id: string; any_recipient: boolean | null
        }[]>(
          `SELECT organization_id, bool_or(email_enabled) AS any_recipient
             FROM notification_preferences
            WHERE organization_id = ANY($1::uuid[])
            GROUP BY organization_id`,
          organizationIds)
        for (const row of recipients) {
          anyRecipientByOrganization.set(row.organization_id, row.any_recipient === true)
        }
        return { byOrganizationAndRule, anyRecipientByOrganization } satisfies Dispositions
      },

      /** BOTH WRITES OR NEITHER. A yield or a crash between them would leave an incident with no
       * job, which every later run skips as already-open — the alert never sent and nothing
       * reporting it. That was the launch blocker; this is the shape that closed it. */
      async commit(incidents: readonly IncidentWrite[], jobs: readonly SendJobWrite[]) {
        if (incidents.length === 0 && jobs.length === 0) {
          return { incidentsWritten: 0, jobsWritten: 0 }
        }
        return prisma.$transaction(async (tx) => {
          let incidentsWritten = 0
          let jobsWritten = 0
          for (const each of incidents) {
            incidentsWritten += await tx.$executeRawUnsafe(
              `INSERT INTO alert_incidents
                 (id, organization_id, incident_key, alert_type_id, ownership, "condition",
                  investigation, ownership_at, condition_at, investigation_at, updated_at)
               VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6,
                       $7::timestamptz, $7::timestamptz, $7::timestamptz, now())
               ON CONFLICT (organization_id, incident_key) DO NOTHING`,
              each.organizationId, each.incidentKey, each.alertTypeId, each.ownership,
              each.condition, each.investigation, each.atIso)
          }
          for (const each of jobs) {
            jobsWritten += await tx.$executeRawUnsafe(
              `INSERT INTO alert_send_jobs
                 (id, message_id, idempotency_key, state, attempts_made, max_attempts,
                  not_before_at, updated_at)
               VALUES (gen_random_uuid(), $1, $2, 'READY', 0, $3, $4::timestamptz, now())
               ON CONFLICT (message_id) DO NOTHING`,
              each.messageId, each.idempotencyKey, each.maxAttempts, each.notBeforeIso)
          }
          return { incidentsWritten, jobsWritten }
        })
      },
    }
  }
}

/** The watermark, or null.
 *
 * **A REQUIRED SETTING WITH NO DEFAULT, AND THE REFUSAL IS THE POINT.** Nobody has chosen the
 * instant before which nothing is sent. Until somebody does, this returns null and intake does
 * not run — because a refusal is recoverable and a guess is not. The guess that would be
 * available here is "now", and taking it silently would mean the first tick after a deploy
 * decides, for ever, which historical findings were never worth telling anybody about.
 *
 * The value is an ISO instant in `HAWKVIEW_ALERT_WATERMARK_ISO`. An unparseable one is also a
 * refusal rather than a fallback: a typo must not become a decision. */
function configuredWatermark(): Watermark | null {
  const raw = process.env.HAWKVIEW_ALERT_WATERMARK_ISO
  if (raw === undefined || raw === '') return null
  const parsed = Date.parse(raw)
  if (Number.isNaN(parsed)) return null
  return {
    sendNothingObservedBeforeIso: new Date(parsed).toISOString(),
    because: 'HAWKVIEW_ALERT_WATERMARK_ISO, chosen by an operator',
  }
}

/** How far back to READ, which is not the same as how far back to send.
 *
 * A BOUNDED WINDOW, because a tick has an admission budget and reading the whole table every five
 * minutes would spend it. The consequence is stated rather than hidden: **findings older than
 * this never receive an incident row from ordinary ticks.** Backfilling the history is a separate
 * one-off job that does not exist yet — see the commit that added this. */
function readSinceIso(tickAt: Date): string {
  const hours = Number(process.env.HAWKVIEW_ALERT_READ_WINDOW_HOURS ?? '24')
  const bounded = Number.isFinite(hours) && hours > 0 ? Math.min(hours, 168) : 24
  return new Date(tickAt.getTime() - bounded * 3_600_000).toISOString()
}

const countByReason = (skipped: IntakeReport['skipped']): Record<string, number> => {
  const counts: Record<string, number> = {}
  for (const each of skipped) counts[each.because] = (counts[each.because] ?? 0) + 1
  return counts
}
