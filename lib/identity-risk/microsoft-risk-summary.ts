import { z } from 'zod'

export const MICROSOFT_RISK_SUMMARY_REASON_CODES = [
  'SOURCE_UNAVAILABLE',
  'COLLECTION_NOT_SUCCEEDED',
  'INVALID_CLOCK',
  'STALE_EVIDENCE',
  'INVALID_SNAPSHOT',
  'PARTIAL_RECORDS',
  'CONFLICTING_RECORDS',
] as const

const nonnegativeCount = z.number().int().nonnegative()

export const MicrosoftRiskSummarySchema = z.object({
  source: z.literal('MICROSOFT_IDENTITY_PROTECTION'),
  availability: z.enum(['AVAILABLE', 'PARTIAL', 'UNAVAILABLE']),
  completeness: z.enum(['COMPLETE', 'PARTIAL', 'CONFLICTING', 'UNKNOWN']),
  rawRecordCount: nonnegativeCount.nullable(),
  observedActiveDistinctUserCount: nonnegativeCount.nullable(),
  activeDistinctUserCount: nonnegativeCount.nullable(),
  snapshotObservedAt: z.string().datetime().nullable(),
  collectionSucceededAt: z.string().datetime().nullable(),
  reasonCode: z.enum(MICROSOFT_RISK_SUMMARY_REASON_CODES).nullable(),
}).strict().superRefine((summary, context) => {
  if (summary.availability === 'AVAILABLE') {
    if (
      summary.completeness !== 'COMPLETE' ||
      summary.rawRecordCount === null ||
      summary.observedActiveDistinctUserCount === null ||
      summary.activeDistinctUserCount === null ||
      summary.activeDistinctUserCount !== summary.observedActiveDistinctUserCount ||
      summary.snapshotObservedAt === null ||
      summary.collectionSucceededAt === null ||
      summary.reasonCode !== null
    ) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'Invalid complete Microsoft risk summary' })
    }
    return
  }

  if (summary.availability === 'PARTIAL') {
    if (
      summary.completeness === 'COMPLETE' ||
      summary.observedActiveDistinctUserCount === null ||
      summary.activeDistinctUserCount !== null ||
      summary.snapshotObservedAt === null ||
      summary.collectionSucceededAt === null ||
      summary.reasonCode === null
    ) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'Invalid partial Microsoft risk summary' })
    }
    return
  }

  if (
    summary.completeness !== 'UNKNOWN' ||
    summary.observedActiveDistinctUserCount !== null ||
    summary.activeDistinctUserCount !== null ||
    summary.reasonCode === null
  ) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'Invalid unavailable Microsoft risk summary' })
  }
})

export type MicrosoftRiskSummary = z.infer<typeof MicrosoftRiskSummarySchema>

const MAX_FUTURE_SKEW_MS = 5 * 60 * 1000

export function normalizeMicrosoftRiskSummary(
  value: unknown,
  trustedCurrentTimeMs = Date.now(),
): MicrosoftRiskSummary | null {
  const parsed = MicrosoftRiskSummarySchema.safeParse(value)
  if (!parsed.success) return null

  for (const timestamp of [
    parsed.data.snapshotObservedAt,
    parsed.data.collectionSucceededAt,
  ]) {
    if (
      timestamp !== null &&
      new Date(timestamp).getTime() > trustedCurrentTimeMs + MAX_FUTURE_SKEW_MS
    ) {
      return null
    }
  }
  if (
    parsed.data.snapshotObservedAt !== null &&
    parsed.data.collectionSucceededAt !== null &&
    new Date(parsed.data.collectionSucceededAt).getTime() <
      new Date(parsed.data.snapshotObservedAt).getTime()
  ) {
    return null
  }
  return parsed.data
}

const reasonCopy: Record<Exclude<MicrosoftRiskSummary['reasonCode'], null>, string> = {
  SOURCE_UNAVAILABLE: 'Microsoft Identity Protection evidence is unavailable for this tenant.',
  COLLECTION_NOT_SUCCEEDED: 'The latest Microsoft Identity Protection collection did not complete successfully.',
  INVALID_CLOCK: 'The Microsoft evidence timestamps could not be verified.',
  STALE_EVIDENCE: 'The available Microsoft Identity Protection evidence is stale.',
  INVALID_SNAPSHOT: 'The Microsoft Identity Protection snapshot could not be verified.',
  PARTIAL_RECORDS: 'Some Microsoft Identity Protection records could not be evaluated.',
  CONFLICTING_RECORDS: 'Microsoft returned conflicting risk states for one or more identities.',
}

export type MicrosoftRiskSummaryPresentation = {
  count: number | null
  exact: boolean
  headline: string
  detail: string
  observedAt: string | null
}

export function presentMicrosoftRiskSummary(
  summary: MicrosoftRiskSummary | null | undefined,
): MicrosoftRiskSummaryPresentation {
  if (!summary) {
    return {
      count: null,
      exact: false,
      headline: 'Microsoft risk status unavailable',
      detail: 'A supported Microsoft Identity Protection summary was not reported.',
      observedAt: null,
    }
  }

  if (summary.availability === 'AVAILABLE' && summary.activeDistinctUserCount !== null) {
    const count = summary.activeDistinctUserCount
    return {
      count,
      exact: true,
      headline:
        count === 0
          ? '0 active Microsoft risk identities in current evidence'
          : `${count} active Microsoft risk ${count === 1 ? 'identity' : 'identities'}`,
      detail:
        count === 0
          ? 'No active identities appear in the current Microsoft Identity Protection evidence. This is not a statement that the tenant is safe.'
          : 'Microsoft Identity Protection currently reports these distinct identities at risk.',
      observedAt: summary.snapshotObservedAt,
    }
  }

  if (
    summary.availability === 'PARTIAL' &&
    summary.observedActiveDistinctUserCount !== null &&
    summary.observedActiveDistinctUserCount > 0
  ) {
    const count = summary.observedActiveDistinctUserCount
    return {
      count,
      exact: false,
      headline: `${count} ${count === 1 ? 'identity has' : 'identities have'} active Microsoft-risk evidence requiring review`,
      detail: summary.reasonCode ? reasonCopy[summary.reasonCode] : 'Microsoft risk evidence is incomplete.',
      observedAt: summary.snapshotObservedAt,
    }
  }

  return {
    count: null,
    exact: false,
    headline: summary.availability === 'PARTIAL'
      ? 'Microsoft risk status incomplete'
      : 'Microsoft risk status unavailable',
    detail: summary.reasonCode
      ? reasonCopy[summary.reasonCode]
      : 'Microsoft Identity Protection evidence is incomplete.',
    observedAt: summary.snapshotObservedAt,
  }
}
