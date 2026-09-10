import { RUN_ENGINE_VERSION, RUN_STATUS } from './persist-run.js'
import { decodeRunCoverage, type StreamCoverage } from './run-coverage.js'
import { decodeRunFindings, type SourceCollection } from './run-findings.js'
import type { Count, Finding } from '../evaluation-core/contract.js'
import type { TenantClaim } from '../evaluation-core/compose.js'

/** Reading back a run this engine wrote.
 *
 * REFUSES A PARTIAL READ, and that is the whole design. A run whose coverage
 * decoded but whose findings did not would otherwise be served as a count with
 * an empty list — and Engineer 2 rendered exactly that shape before it could
 * reach anyone:
 *
 *     card:  4   Distinct users with at least one current HawkView finding
 *     list:  No user is listed as needing attention right now.
 *
 * Both sentences true, the pair an all-clear on a tenant with four findings.
 * Neither component can catch it: the tile sees a number, the list sees an
 * emptiness, and each is coherent alone. The contradiction exists only in the
 * relationship, so it has to be refused by whoever can see both — which is
 * here, once, rather than at every surface that consumes this.
 *
 * That shape is reachable rather than theoretical: `evaluation_findings` is
 * nullable, so every run written before the column existed decodes as absent,
 * as does any record written by a version this build does not recognise.
 */

export type ReadRunResult =
  | Readonly<{
    present: true
    streams: readonly StreamCoverage[]
    findings: readonly Finding[]
    /** The verdict, read from the same record as the findings it rests on. */
    count: Count
    claim: TenantClaim
    complete: boolean
    sources: readonly SourceCollection[]
    completedAt: Date
    windowStart: Date
    windowEnd: Date
  }>
  /** Distinct reasons, because they send an investigator to different places: no
   * run at all is a scheduling question, an unreadable record is a data
   * question, and a record from a future version is a deploy-ordering question.
   * Collapsing them into "unavailable" is the undifferentiated answer this
   * whole design exists to remove. */
  | Readonly<{
    present: false
    because: 'NO_RUN'
      | 'COVERAGE_NOT_RECORDED' | 'COVERAGE_UNREADABLE'
      | 'FINDINGS_NOT_RECORDED' | 'FINDINGS_UNREADABLE'
  }>

type RunRow = Readonly<{
  evaluationCoverage: unknown
  evaluationFindings: unknown
  completedAt: Date | null
  windowStart: Date
  windowEnd: Date
}>

/** The subset of the client this needs, so tests can supply a double — the
 * columns do not exist in production yet, so a test requiring them could not
 * run at all. */
export type RunReader = Readonly<{
  identityRiskEvaluationRun: Readonly<{
    findFirst: (args: Record<string, unknown>) => Promise<RunRow | null>
  }>
}>

export async function readLatestRun(
  client: RunReader, scope: Readonly<{ organizationId: string; customerTenantId: string }>, now: Date,
): Promise<ReadRunResult> {
  const row = await client.identityRiskEvaluationRun.findFirst({
    where: {
      organizationId: scope.organizationId,
      customerTenantId: scope.customerTenantId,
      // BOTH, and both matter. The status keeps this from reading the old
      // engine's 1,838 rows — the mirror of the property that keeps its reader
      // from seeing ours, and the direction nobody thinks to check. The engine
      // version keeps a future engine's rows out of this reader for the same
      // reason.
      status: RUN_STATUS,
      engineVersion: RUN_ENGINE_VERSION,
      expiresAt: { gt: now },
    },
    orderBy: [{ completedAt: 'desc' }, { id: 'desc' }],
    select: {
      evaluationCoverage: true, evaluationFindings: true,
      completedAt: true, windowStart: true, windowEnd: true,
    },
  })
  if (row === null || row.completedAt === null) return { present: false, because: 'NO_RUN' }

  const coverage = decodeRunCoverage(row.evaluationCoverage)
  if (!coverage.present) {
    return {
      present: false,
      because: coverage.because === 'NOT_RECORDED' ? 'COVERAGE_NOT_RECORDED' : 'COVERAGE_UNREADABLE',
    }
  }

  const findings = decodeRunFindings(row.evaluationFindings)
  if (!findings.present) {
    // THE REFUSAL. Returning the coverage here — a count with no list — is the
    // shape that renders as an all-clear over real findings. An absent list is
    // not an empty one, and the only safe thing to do with a number whose basis
    // did not come back is to decline to serve the number.
    return {
      present: false,
      because: findings.because === 'NOT_RECORDED' ? 'FINDINGS_NOT_RECORDED' : 'FINDINGS_UNREADABLE',
    }
  }

  return {
    present: true,
    streams: coverage.streams,
    findings: findings.findings,
    count: findings.count,
    claim: findings.claim,
    complete: findings.complete,
    sources: findings.sources,
    completedAt: row.completedAt,
    windowStart: row.windowStart,
    windowEnd: row.windowEnd,
  }
}
