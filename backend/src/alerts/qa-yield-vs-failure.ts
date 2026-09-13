// QA — 28b6ddd. A yield and a failure must be different in the REPORT, and the phase must be
// RIGHT rather than merely present.
//
// Both halves matter and they fail differently. A failure that reads like a yield gets explained
// away once and never looked at again. A failure attributed to the WRONG phase is worse than one
// with no phase at all: it sends the next person somewhere with confidence.
//
// So every phase is driven by INJECTING A FAULT AT THAT PHASE and reading what comes back — not by
// checking that a phase field exists.
import {
  runIntake,
  type Dispositions, type ExistingIncident, type FindingRow, type IntakeOutcome,
  type PipelineStore, type Watermark,
} from './finding-pipeline.js'

const T0 = '2026-09-12T09:00:00.000Z'
const WATERMARK: Watermark = {
  sendNothingObservedBeforeIso: '2026-09-12T00:00:00.000Z', because: 'qa',
}

const finding = (i: number): FindingRow => ({
  id: 'f-' + i,
  organizationId: 'org-1',
  customerTenantId: 'ten-1',
  ruleId: 'HV-ID-AUTH-001.v1',
  dedupeKey: 'dedupe-' + i,
  subjectType: 'USER',
  subjectId: 'user-' + i,
  severity: 'HIGH',
  state: 'OPEN',
  observedAtIso: T0,
})

const NO_DISPOSITIONS: Dispositions = {
  byOrganizationAndAlertType: new Map(),
  anyRecipientByOrganization: new Map([['org-1', true]]),
  unreadable: [],
}

/** A store that works, with one method replaced by a thrower. */
const storeWith = (over: Partial<PipelineStore> = {}): PipelineStore => ({
  findOpenFindings: async () => [finding(1), finding(2), finding(3)],
  findExistingIncidents: async (): Promise<readonly ExistingIncident[]> => [],
  loadDispositions: async () => NO_DISPOSITIONS,
  commit: async (incidents, notifications, jobs) => ({
    incidentsWritten: incidents.length,
    notificationsWritten: notifications.length,
    jobsWritten: jobs.length,
  }),
  ...over,
})

const boom = (where: string) => async () => { throw new Error('injected fault in ' + where) }

const seen = (o: IntakeOutcome) => o.kind === 'RAN'
  ? {
      kind: o.kind,
      yieldedOnBudget: o.report.yieldedOnBudget,
      findingsRead: o.report.findingsRead,
      jobsWritten: o.report.jobsWritten,
    }
  : { kind: o.kind, phase: o.phase, because: o.because, attempted: o.attempted }

async function main() {
  const far = () => Date.now() + 30_000
  const past = () => Date.now() - 1

  const healthy = await runIntake(storeWith(), WATERMARK, T0, far(), '2026-01-01T00:00:00.000Z')
  const yielded = await runIntake(storeWith(), WATERMARK, T0, past(), '2026-01-01T00:00:00.000Z')
  const noWork = await runIntake(
    storeWith({ findOpenFindings: async () => [] }), WATERMARK, T0, far(), '2026-01-01T00:00:00.000Z')

  const failedReading = await runIntake(
    storeWith({ findOpenFindings: boom('findOpenFindings') }), WATERMARK, T0, far(), '2026-01-01T00:00:00.000Z')
  const failedLoadingIncidents = await runIntake(
    storeWith({ findExistingIncidents: boom('findExistingIncidents') }), WATERMARK, T0, far(), '2026-01-01T00:00:00.000Z')
  const failedLoadingDispositions = await runIntake(
    storeWith({ loadDispositions: boom('loadDispositions') }), WATERMARK, T0, far(), '2026-01-01T00:00:00.000Z')
  const failedWriting = await runIntake(
    storeWith({ commit: boom('commit') }), WATERMARK, T0, far(), '2026-01-01T00:00:00.000Z')

  // ── IS THERE AN EXIT THE UNION DOES NOT COVER? ─────────────────────────────────────────────
  // `decide()` and the `findings.length` test sit OUTSIDE all three try blocks, so a fault there
  // leaves `runIntake` by rejecting rather than by returning. The union says what a tick did; a
  // rejection says nothing at all, and the caller has to have its own answer.
  let escaped: string | null = null
  try {
    await runIntake(
      // Resolves, so the `try` around the read is satisfied; `findings.length` on the next line
      // is not guarded.
      storeWith({ findOpenFindings: (async () => undefined) as unknown as PipelineStore['findOpenFindings'] }),
      WATERMARK, T0, far(), '2026-01-01T00:00:00.000Z')
  } catch (e) { escaped = e instanceof Error ? e.message : String(e) }

  const w = failedWriting.kind === 'FAILED' ? failedWriting.attempted : null
  const healthyReport = healthy.kind === 'RAN' ? healthy.report : null

  console.log(JSON.stringify({
    QA_YIELD_VS_FAILURE: {
      boundTo: '28b6ddd',

      // ══ 1. A YIELD AND A FAILURE ARE DIFFERENT IN THE VALUE, not only in a log line ════════
      distinguishableInTheReport: {
        healthy: seen(healthy),
        yieldedOnBudget: seen(yielded),
        failedWriting: seen(failedWriting),
        A_YIELD_IS_A_RAN: yielded.kind === 'RAN' && yielded.report.yieldedOnBudget === true,
        A_FAILURE_IS_NOT_A_RAN: failedWriting.kind === 'FAILED',
        // The pair that used to read alike: both leave the findings OPEN and both write nothing.
        BOTH_WROTE_NOTHING:
          (yielded.kind === 'RAN' ? yielded.report.jobsWritten : -1) === 0
          && (failedWriting.kind === 'FAILED' ? 0 : -1) === 0,
        AND_STILL_TELL_APART: yielded.kind !== failedWriting.kind,
      },

      // ══ 2. THE PHASE IS RIGHT, driven by a fault at each phase in turn ════════════════════
      phaseIsMeasuredNotDeclared: {
        readingFault: seen(failedReading),
        loadingFault_incidents: seen(failedLoadingIncidents),
        loadingFault_dispositions: seen(failedLoadingDispositions),
        writingFault: seen(failedWriting),
        EACH_FAULT_NAMES_ITS_OWN_PHASE:
          failedReading.kind === 'FAILED' && failedReading.phase === 'READING'
          && failedLoadingIncidents.kind === 'FAILED' && failedLoadingIncidents.phase === 'LOADING'
          && failedLoadingDispositions.kind === 'FAILED' && failedLoadingDispositions.phase === 'LOADING'
          && failedWriting.kind === 'FAILED' && failedWriting.phase === 'WRITING',
        // and the three phases are actually distinct, so the field is discriminating rather than
        // constant — a phase that is always the same word is not an attribution.
        THREE_DISTINCT_PHASES: new Set([
          failedReading.kind === 'FAILED' ? failedReading.phase : null,
          failedLoadingIncidents.kind === 'FAILED' ? failedLoadingIncidents.phase : null,
          failedWriting.kind === 'FAILED' ? failedWriting.phase : null,
        ]).size === 3,
      },

      // ══ 3. WHAT WAS LOST IS HONEST AT EACH PHASE ══════════════════════════════════════════
      attemptedWorkIsHonest: {
        readingLostNothing: failedReading.kind === 'FAILED'
          && Object.values(failedReading.attempted).every((n) => n === 0),
        loadingKnowsWhatItRead: failedLoadingIncidents.kind === 'FAILED'
          && failedLoadingIncidents.attempted.findingsRead === 3
          && failedLoadingIncidents.attempted.incidents === 0
          && failedLoadingIncidents.attempted.jobs === 0,
        writingReportsTheWholeDecision: w,
        // The control that makes the line above mean something: the healthy run over the SAME
        // input wrote exactly what the failing run says it attempted. Without this, `attempted`
        // could be any number at all and still look plausible.
        WRITING_ATTEMPTED_EQUALS_WHAT_A_HEALTHY_RUN_WROTE:
          w !== null && healthyReport !== null
          && w.incidents === healthyReport.incidentsWritten
          && w.notifications === healthyReport.notificationsWritten
          && w.jobs === healthyReport.jobsWritten
          && w.findingsRead === healthyReport.findingsRead,
        healthyRun: healthyReport,
      },

      // ══ 4. THE EXIT THE UNION DOES NOT COVER ══════════════════════════════════════════════
      anUnguardedExit: {
        runIntakeRejectedInsteadOfReturning: escaped !== null,
        because: escaped,
        note: 'decide() and the findings.length test are outside all three try blocks, so a fault '
          + 'there leaves runIntake by rejecting. The union enumerates what a tick did; a '
          + 'rejection is outside the enumeration, which is why the caller keeps a backstop.',
      },

      noWorkToDo: seen(noWork),
    },
  }, null, 2))
}

main().catch((e) => { console.error('QA PROBE FAILED:', e); process.exitCode = 1 })
