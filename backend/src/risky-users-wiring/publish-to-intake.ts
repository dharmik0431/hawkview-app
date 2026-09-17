import { createHash } from 'node:crypto'
import type { Finding } from '../evaluation-core/contract.js'
import { readSourceEventReference } from './incident-source-reference.js'

/**
 * **THE ONE BRIDGE FROM A NATIVE FINDING TO THE TABLE ALERT INTAKE READS.**
 *
 * The orchestration was already wired — `scheduled-sync.controller.ts` runs the cycle with
 * `alsoEvaluate → evaluateAndPersistTenant` and awaits `alertIntake.runOnce` in the same scheduled
 * request. What did not connect was the data: intake reads `identity_risk_findings`, whose only
 * writer was the old engine, while this engine writes its findings to a JSONB column that only
 * `read-run.ts` reads. Measured before building: one real native finding, `identity_risk_findings`
 * row count **0**.
 *
 * **NOTHING HERE ASSERTS ANYTHING THE DETECTOR DID NOT DETERMINE.** That is the whole constraint
 * this module was blocked on. `persist-run.ts` declined to write these tables because `severity`,
 * `confidence` and `coverage` were NOT NULL over closed vocabularies with no way to say "no value
 * was determined" — so writing a row meant fabricating three claims, and `confidence` is confidence
 * **of compromise**, which this detector explicitly does not assess. The schema now carries
 * `NOT_ASSESSED` in all six of those vocabularies, and this writer uses it. **A row from here says
 * the absence of a claim rather than making a quiet one.**
 *
 * WHAT IS DELIBERATELY NOT HERE:
 *   - **No severity, confidence or coverage value.** See above. If a future edit puts a real value
 *     in one of these, it is asserting something no detector computed.
 *   - **No investigation priority.** The native path emits `priority: null` by product decision;
 *     the tier an MSP sees comes from the alert TYPE, via the catalogue, not from the finding.
 *   - **No new alert type and no new mapping table.** `HV-ID-AUTH-011.v1` reaches
 *     `security.suspected_credential_attack` through the existing
 *     `alertTypeForRule → investigationGuidanceCode → TYPE_FOR_GUIDANCE` machinery, whose default
 *     disposition for that type is already approved and unchanged.
 *
 * **WHY A NEW RULE ID RATHER THAN `HV-ID-AUTH-010.v1`.** They are about the same subject and are
 * not the same rule: `010` is published as ten failures within fifteen minutes with no successful
 * access; this detector fires at five failures **or any lockout**, over the whole evaluation
 * window, with no sub-window, and does not consider success. Borrowing the id would have put a
 * published description on a finding it does not describe.
 */

/** The vocabularies' member for "this engine determined no value". Not a default and not a
 * placeholder — a statement, and the only value this writer may use for these three columns. */
export const NOT_ASSESSED = 'NOT_ASSESSED'

/** The one rule id native findings carry. `rule_version` is derived from it rather than passed, so
 * the two cannot disagree — the shape of the defect this feature already has a scar from. */
export const NATIVE_RULE_ID = 'HV-ID-AUTH-011.v1'
export const NATIVE_RULE_VERSION = 'v1'

/** What the caller must give us, and nothing more. Narrow on purpose: this seam cannot reach a
 * tenant record, a directory row or anything it could turn into a claim. */
export interface IntakeRowInput {
  readonly organizationId: string
  readonly customerTenantId: string
  readonly evaluationRunId: string
  readonly findings: readonly Finding[]
  readonly observedAt: Date
  readonly expiresAt: Date
}

export interface MatchedResultRow {
  readonly resultKey: string
  readonly ruleId: string
  readonly subjectType: string
  readonly subjectId: string
  readonly severity: string
  readonly confidence: string
  readonly coverage: string
  readonly evidence: unknown
}

export interface FindingIntakeRow {
  readonly dedupeKey: string
  readonly ruleId: string
  readonly ruleVersion: string
  readonly subjectType: string
  readonly subjectId: string
  readonly severity: string
  readonly confidence: string
  readonly coverage: string
  readonly state: string
}

/** A matched result and the finding that points at it, as one unit — because the finding's
 * `matched_result_id` is NOT NULL and a foreign key, so neither is writable alone. */
export interface IntakePair {
  readonly matched: MatchedResultRow
  readonly finding: FindingIntakeRow
}

/** `subject_type` is CHECK-constrained to USER | MAILBOX | APPLICATION | UNKNOWN. The native
 * subject union has two arms today; **UNKNOWN is returned for anything else rather than a guess**,
 * because a wrong subject type sends an MSP to the wrong object. */
function subjectOf(finding: Finding): { subjectType: string; subjectId: string } {
  if (finding.subject.kind === 'DIRECTORY_USER') {
    return { subjectType: 'USER', subjectId: finding.subject.userRef }
  }
  if (finding.subject.kind === 'MAILBOX') {
    return { subjectType: 'MAILBOX', subjectId: finding.subject.mailboxRef }
  }
  return { subjectType: 'UNKNOWN', subjectId: '' }
}

const sha256 = (...parts: readonly string[]): string =>
  createHash('sha256').update(parts.join('\u0000')).digest('hex')

/**
 * Build the rows for one run's findings. **Pure** — it writes nothing, so the decision of what a
 * row says is testable without a database, and the I/O stays with the caller that already owns a
 * transaction.
 *
 * THE KEYS ARE DERIVED FROM THE FINDING, NOT FROM THE CLOCK. `dedupe_key` is what the notification
 * row is unique on, so a second evaluation of the same subject under the same rule must produce the
 * same key or every tick would notify again. The run id is deliberately NOT in it.
 */
export function intakeRowsFor(input: IntakeRowInput): readonly IntakePair[] {
  return input.findings.map((finding) => {
    const { subjectType, subjectId } = subjectOf(finding)
    const dedupeKey = sha256(
      input.organizationId, input.customerTenantId, NATIVE_RULE_ID, subjectType, subjectId,
    )
    const signals = finding.signals.map(signal => {
      const reference = readSourceEventReference(signal.sourceEvent)
      const valid = reference && reference.organizationId === input.organizationId
        && reference.customerTenantId === input.customerTenantId && reference.subjectRef === subjectId
        && signal.count > 0 && signal.latest?.kind === 'EVENT_OCCURRED'
        && signal.latest.at === reference.eventAt
      const { sourceEvent: _unused, ...existing } = signal
      return { ...existing, ...(valid ? { sourceEvent: reference } : {}) }
    })
    return {
      matched: {
        // The run IS in the result key: a matched result is this run's record of the match,
        // whereas the finding is the standing fact about the subject.
        resultKey: sha256(dedupeKey, input.evaluationRunId),
        ruleId: NATIVE_RULE_ID,
        subjectType,
        subjectId,
        severity: NOT_ASSESSED,
        confidence: NOT_ASSESSED,
        coverage: NOT_ASSESSED,
        // The detector's own signals, unchanged. Counts and recency — no verdict added here.
        evidence: { ...(signals.some(signal => signal.sourceEvent)
          ? { schemaVersion: 'hawkview-native-email-evidence/v1' } : {}),
        detectorId: finding.detectorId, signals },
      },
      finding: {
        dedupeKey,
        ruleId: NATIVE_RULE_ID,
        ruleVersion: NATIVE_RULE_VERSION,
        subjectType,
        subjectId,
        severity: NOT_ASSESSED,
        confidence: NOT_ASSESSED,
        coverage: NOT_ASSESSED,
        // OPEN is what `findOpenFindings` selects on. A finding this engine writes is open
        // because it was observed in the window; nothing here closes one.
        state: 'OPEN',
      },
    }
  })
}
