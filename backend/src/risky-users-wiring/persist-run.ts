import { createHash } from 'node:crypto'
import { encodeRunCoverage } from './run-coverage.js'
import { encodeRunFindings } from './run-findings.js'
import type { TenantAssessment } from '../evaluation-core/compose.js'

/** Writing a run this engine produced, into a table the old engine owns.
 *
 * THE HAZARD THIS FILE EXISTS TO AVOID, checked in the live source rather than
 * assumed: `identity-risk.service.ts` reads the newest run with
 *
 *     where: { organizationId, customerTenantId, status: 'COMPLETED',
 *              expiresAt: { gt: now } }
 *     orderBy: [{ completedAt: 'desc' }, { id: 'desc' }]
 *
 * and NO engine discriminator. So a row written here with `status: 'COMPLETED'`
 * would be picked up by the live reader as one of its own and served to a
 * customer, carrying an `aggregate` shaped for a different engine. That is not
 * a degraded response, it is the running product answering from a payload it
 * cannot parse.
 *
 * `RUN_STATUS` is therefore a value that query excludes by construction. It is
 * not a trick: it says truthfully which engine completed the run, and the old
 * reader ignores runs it did not produce because it never knew to look. A test
 * asserts the invisibility by running the live reader's own where-clause
 * against a written row, so if either side moves, that test fails rather than a
 * customer seeing it.
 *
 * NOTHING IS WRITTEN TO `identity_risk_matched_results` OR
 * `identity_risk_findings`. Both require `severity`, `confidence` and
 * `coverage` as non-null strings, and this engine computes none of the three.
 * Filling them to satisfy a NOT NULL would put three fabricated values per
 * finding into the tables an MSP acts from — the exact thing this workstream
 * exists to remove. If a severity vocabulary is wanted it is a product decision
 * with a citation requirement, not a column to be satisfied.
 */

export const RUN_ENGINE_VERSION = 'hawkview-evaluation-core/1'
export const RUN_CATALOG_VERSION = 'hawkview-risky-users-detectors/1'

/** Deliberately not 'COMPLETED'. See the hazard above. */
export const RUN_STATUS = 'COMPLETED_EVALUATION_CORE'

export type PersistRunInput = Readonly<{
  organizationId: string
  customerTenantId: string
  windowStart: Date
  windowEnd: Date
  /** How many rows the query returned. Part of the source fingerprint because a
   * run over a different number of rows is a different run even when the window
   * and the answer match. */
  rowsFetched: number
  /** When this record stops being readable. Required by the table and not
   * defaulted anywhere, so the caller states a retention rather than inheriting
   * one silently. */
  expiresAt: Date
  completedAt: Date
}>

/** The subset of the Prisma client this needs, so the unit tests can supply a
 * double without a database and without the schema having to exist yet. */
export type RunWriter = Readonly<{
  identityRiskEvaluationRun: Readonly<{
    create: (args: { data: Record<string, unknown> }) => Promise<{ id: string }>
  }>
}>

const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex')

/** Identifies the run, not its answer.
 *
 * Tenant, window and engine — never the assessment. A key that included the
 * result would make two runs over identical evidence look like different runs
 * whenever the engine changed its mind, which is precisely when you want to see
 * that they were the same question. */
export const runKeyFor = (input: PersistRunInput): string =>
  sha256([
    RUN_ENGINE_VERSION,
    input.organizationId,
    input.customerTenantId,
    input.windowStart.toISOString(),
    input.windowEnd.toISOString(),
  ].join('|')).slice(0, 64)

/** What was read, not what was concluded.
 *
 * Two separate hashes because they answer different questions: the watermark is
 * how far collection had got, the content is what was in it. A window that
 * advanced with no new rows and a window that stayed put while rows changed are
 * different situations, and one hash cannot say which happened. */
const fingerprint = (input: PersistRunInput): Readonly<{ watermark: string; content: string }> => ({
  watermark: sha256(`${input.windowStart.toISOString()}|${input.windowEnd.toISOString()}`).slice(0, 64),
  content: sha256(`${input.rowsFetched}|${input.windowEnd.toISOString()}`).slice(0, 64),
})

export async function persistRun(
  client: RunWriter, assessment: TenantAssessment, input: PersistRunInput,
): Promise<{ id: string }> {
  const { watermark, content } = fingerprint(input)
  return client.identityRiskEvaluationRun.create({
    data: {
      organizationId: input.organizationId,
      customerTenantId: input.customerTenantId,
      runKey: runKeyFor(input),
      engineVersion: RUN_ENGINE_VERSION,
      catalogVersion: RUN_CATALOG_VERSION,
      status: RUN_STATUS,
      windowStart: input.windowStart,
      windowEnd: input.windowEnd,
      sourceWatermarkHash: watermark,
      sourceContentHash: content,
      // `capability` and `aggregate` are the OLD engine's vocabulary and are
      // left at their defaults on purpose. Mapping this assessment's claim onto
      // FULL / PARTIAL / UNAVAILABLE would be inventing a second, coarser
      // answer beside the real one — and a coarse answer next to an exact
      // number is the shape of the defect being replaced: this table currently
      // holds `matchedResults: { exact: true, value: 0 }` beside
      // `capability: PARTIAL` on every run, for every tenant, all day.
      //
      // The claim, the count and the coverage all live in `evaluationCoverage`,
      // where they carry their own qualifications.
      evaluationCoverage: encodeRunCoverage(assessment),
      // Beside the coverage rather than in the old engine's tables: those
      // require severity, confidence and coverage as NOT NULL strings that
      // this engine does not compute. A nullable column has nothing to
      // satisfy, so there is nothing to fabricate.
      evaluationFindings: encodeRunFindings(assessment),
      expiresAt: input.expiresAt,
      completedAt: input.completedAt,
    },
  })
}

/** The live reader's own filter, so a test can prove a row written here is
 * invisible to it. Kept beside the writer because the two must move together —
 * if the reader ever starts accepting this status, this is the line that has to
 * change and the test that has to fail. */
export const liveReaderWouldSelect = (row: Readonly<{ status: string; expiresAt: Date }>, now: Date): boolean =>
  row.status === 'COMPLETED' && row.expiresAt.getTime() > now.getTime()
