import {
  adaptNativeAssessment,
  NATIVE_RISKY_USERS_VERSION,
  type NativeAssessment,
} from './native-assessment.ts'
import type {
  FindingSignal,
  RiskAssessment,
  RiskAssessmentCountReason,
  RiskAssessmentFinding,
  RiskAssessmentRuleId,
} from './types.ts'

const detectorByLegacyRule: Partial<Record<RiskAssessmentRuleId, string>> = {
  'HV-ID-AUTH-010.v1': 'repeated-credential-failure',
  'HV-ID-AUTH-005.v2': 'repeated-credential-failure',
  'HV-ID-MBX-001.v1': 'external-mailbox-forwarding',
}

const nativeReasonByLegacyReason: Record<
  RiskAssessmentCountReason,
  string
> = {
  NO_EVIDENCE_IN_WINDOW: 'NOTHING_APPLICABLE',
  UNRESOLVED_SUBJECT_IDENTITY: 'UNRESOLVED_SUBJECT_IDENTITY',
  UNINTERPRETABLE_EVIDENCE: 'UNINTERPRETED_EVENTS',
  CAPACITY_LIMIT: 'CAPACITY_EXCEEDED',
  INCOMPLETE_WINDOW: 'UNREADABLE_NOW',
  COLLECTION_STALE: 'UNREADABLE_NOW',
  SOURCE_UNAVAILABLE: 'NEVER_COLLECTED',
}

function detectorId(ruleId: string): string {
  return detectorByLegacyRule[ruleId as RiskAssessmentRuleId] ?? ruleId
}

function fallbackSignal(finding: RiskAssessmentFinding): FindingSignal {
  const mailbox = finding.ruleId === 'HV-ID-MBX-001.v1'
  return {
    signal: mailbox
      ? 'EXTERNAL_FORWARDING_CONFIGURED'
      : 'PASSWORD_REJECTED',
    count: finding.evidenceCount,
    capped: finding.evidenceCountCapped,
    latest: finding.lastSeen
      ? {
          at: finding.lastSeen,
          kind: mailbox ? 'STATE_OBSERVED' : 'EVENT_OCCURRED',
        }
      : null,
  }
}

/**
 * Build the native assessment used by the mounted Risky Users surface.
 *
 * This is intentionally not a property rename. The older assessment remains
 * the input for the legacy drawer tests in this file, while this helper emits
 * the endpoint's real versioned wire vocabulary and sends it through the same
 * adapter as production before the native hook mock receives it.
 */
export function nativeAssessmentFixture(
  legacy: RiskAssessment | null
): NativeAssessment | null {
  if (!legacy) return null

  const summary = legacy.summary?.currentUsers ?? null
  const accuracy =
    summary?.accuracy === 'EXACT' || summary?.accuracy === 'AT_LEAST'
      ? summary.accuracy
      : 'NOT_AVAILABLE'
  const withheld = (summary?.reasons ?? []).map((reason) => ({
    stream: null,
    because: nativeReasonByLegacyReason[reason],
  }))
  const runWindow =
    legacy.sources.find(
      (source) => source.window.start !== null || source.window.end !== null
    )?.window ?? { start: null, end: null }

  const wire = {
    version: NATIVE_RISKY_USERS_VERSION,
    available: true,
    run: {
      windowStart: runWindow.start,
      windowEnd: runWindow.end,
      completedAt: legacy.summary?.asOf ?? legacy.meta.evaluatedAt,
    },
    collectors: legacy.sources.map((source) => ({
      source: source.source,
      status: source.status,
      lastSuccessfulCollectionAt: source.lastSuccessfulCollectionAt,
    })),
    coverage: legacy.sources.map((source) => {
      const applies = legacy.rules
        .filter((rule) => rule.selectedSource === source.source)
        .reduce(
          (largest, rule) =>
            typeof rule.assessedIdentities === 'number'
              ? Math.max(largest, rule.assessedIdentities)
              : largest,
          0
        )
      return {
        stream: source.source,
        coverage: {
          applies,
          uninterpretedEvents: 0,
          notYetCitedEvents: 0,
        },
      }
    }),
    subjectsNamed: true,
    count: {
      accuracy,
      value: accuracy === 'NOT_AVAILABLE' ? null : summary?.value ?? 0,
      scope: {
        evidenceRequested: legacy.sources.map((source) => source.source),
        covered: Array.from(
          new Set(
            legacy.rules
              .filter((rule) => rule.status === 'READY')
              .map((rule) => detectorId(rule.ruleId))
          )
        ),
        notCovered: legacy.rules
          .filter((rule) => rule.status !== 'READY')
          .map((rule) => ({
            detectorId: detectorId(rule.ruleId),
            because:
              rule.reasonCode === 'CHECK_NOT_APPLICABLE'
                ? 'NOTHING_APPLICABLE'
                : rule.reasonCode === 'COLLECTION_STALE'
                  ? 'UNREADABLE_NOW'
                  : rule.reasonCode === 'SOURCE_UNAVAILABLE'
                    ? 'NEVER_COLLECTED'
                    : 'DETECTOR_FAILED',
          })),
      },
    },
    claim:
      withheld.length > 0
        ? { permitted: false, withheld }
        : { permitted: true },
    findings: {
      complete: !legacy.page.hasMore,
      items: legacy.users.flatMap((user) =>
        user.findings.map((finding) => ({
          detectorId: detectorId(finding.ruleId),
          subject: {
            kind:
              user.subjectType === 'MAILBOX'
                ? ('MAILBOX' as const)
                : ('DIRECTORY_USER' as const),
            ...(user.subjectType === 'MAILBOX'
              ? { mailboxRef: user.id }
              : { userRef: user.id }),
            correlation:
              user.correlation?.available === true
                ? {
                    available: true,
                    matchedBy: user.correlation.shape,
                    ref: user.correlation.ref,
                  }
                : user.correlation?.available === false
                  ? {
                      available: false,
                      because: user.correlation.because,
                    }
                  : null,
          },
          displayName: user.displayName,
          userPrincipalName: user.userPrincipalName,
          signals:
            finding.signals === null
              ? [fallbackSignal(finding)]
              : finding.signals,
        }))
      ),
    },
  }

  const native = adaptNativeAssessment(wire)
  if (!native) {
    throw new Error('The Risky Users UI fixture did not satisfy the native contract.')
  }
  return native
}

/** A native endpoint fixture, independent of the legacy assessment envelope. */
export function nativeRiskyUsersFixture(): Extract<NativeAssessment, { available: true }> {
  const native = adaptNativeAssessment({
    version: NATIVE_RISKY_USERS_VERSION,
    available: true,
    run: {
      windowStart: '2026-09-08T21:00:00.000Z',
      windowEnd: '2026-09-08T22:00:00.000Z',
      completedAt: '2026-09-08T22:00:00.000Z',
    },
    collectors: [],
    coverage: [{
      stream: 'synthetic.sign-ins',
      coverage: { applies: 5, uninterpretedEvents: 0, notYetCitedEvents: 0 },
    }],
    subjectsNamed: true,
    count: {
      accuracy: 'EXACT',
      value: 1,
      scope: {
        evidenceRequested: ['synthetic.sign-ins'],
        covered: ['repeated-credential-failure'],
        notCovered: [],
      },
    },
    claim: { permitted: true },
    findings: {
      complete: true,
      items: [{
        detectorId: 'repeated-credential-failure',
        subject: {
          kind: 'DIRECTORY_USER',
          userRef: '00000000-0000-4000-8000-000000000011',
          correlation: { available: false, because: 'NO_SHARED_CORRELATION' },
        },
        displayName: 'Native fixture user',
        userPrincipalName: 'native.user@synthetic.invalid',
        signals: [{
          signal: 'PASSWORD_REJECTED',
          count: 10,
          capped: false,
          latest: { at: '2026-09-08T21:59:00.000Z', kind: 'EVENT_OCCURRED' },
        }],
      }],
    },
  })
  if (!native?.available) throw new Error('Native endpoint fixture must be readable.')
  return native
}
