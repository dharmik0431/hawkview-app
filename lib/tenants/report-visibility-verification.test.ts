import assert from 'node:assert/strict'
import test from 'node:test'
import {
  executeReportVisibilityVerification,
  reportVerificationFeedback,
  reportVerificationRequestFailure,
  type ReportVerificationFeedback,
} from './report-visibility-verification.ts'
import type {
  ReportVisibilityVerification,
  ReportVisibilityVerificationResult,
} from './tenant-onboarding.ts'

const checkedAt = '2026-08-29T18:00:00.000Z'
const verification = (
  status: ReportVisibilityVerification['status'],
  retryable = false,
): ReportVisibilityVerification => ({
  status,
  identifiersVisible: status === 'READY' ? true : status === 'IDENTIFIERS_CONCEALED' ? false : null,
  retryable,
  checkedAt,
})

test('maps READY and concealed settings to truthful completion guidance', () => {
  const ready = reportVerificationFeedback(verification('READY'))
  assert.equal(ready.tone, 'success')
  assert.match(ready.message, /step is complete/)

  const concealed = reportVerificationFeedback(verification('IDENTIFIERS_CONCEALED'))
  assert.equal(concealed.tone, 'warning')
  assert.match(concealed.title, /still concealed/i)
  assert.match(concealed.message, /uncheck “Conceal user, group, and site names in all reports,” then Save/)
  assert.match(concealed.message, /few minutes to propagate/)
})

test('maps every Microsoft verification failure without raw provider detail', () => {
  const cases: Array<[ReportVisibilityVerification['status'], RegExp]> = [
    ['MISSING_PERMISSION', /ReportSettings\.Read\.All/],
    ['MICROSOFT_DENIED', /admin consent/],
    ['TOKEN_UNAVAILABLE', /access token/],
    ['CONNECTION_INCOMPLETE', /connection is incomplete/],
    ['MICROSOFT_UNAVAILABLE', /temporarily unavailable/],
    ['NETWORK_ERROR', /timed out or encountered a network error/],
    ['INVALID_RESPONSE', /invalid response/],
  ]
  for (const [status, expected] of cases) {
    const feedback = reportVerificationFeedback(
      verification(status, status === 'MICROSOFT_UNAVAILABLE'),
    )
    assert.match(`${feedback.title} ${feedback.message}`, expected)
    assert.equal(feedback.checkedAt, checkedAt)
  }
})

test('publishes checking feedback before the request settles', async () => {
  let resolveRequest!: (result: ReportVisibilityVerificationResult) => void
  const pending = new Promise<ReportVisibilityVerificationResult>((resolve) => {
    resolveRequest = resolve
  })
  const feedback: ReportVerificationFeedback[] = []
  const execution = executeReportVisibilityVerification({
    request: () => pending,
    onFeedback: (value) => feedback.push(value),
    now: () => checkedAt,
  })

  assert.equal(feedback.length, 1)
  assert.equal(feedback[0]?.title, 'Checking Microsoft…')
  resolveRequest({
    verification: verification('READY'),
    onboarding: {} as ReportVisibilityVerificationResult['onboarding'],
  })
  await execution
  assert.equal(feedback.at(-1)?.tone, 'success')
})

test('maps network, backend, authorization, and invalid-contract failures safely', () => {
  const apiError = (status: number) => Object.assign(new Error('raw provider detail'), {
    name: 'ApiError',
    status,
  })
  const network = reportVerificationRequestFailure(apiError(0), checkedAt)
  const backend = reportVerificationRequestFailure(apiError(503), checkedAt)
  const denied = reportVerificationRequestFailure(apiError(403), checkedAt)
  const invalid = reportVerificationRequestFailure(
    Object.assign(new Error('raw payload detail'), { name: 'ZodError' }),
    checkedAt,
  )
  for (const feedback of [network, backend, denied, invalid]) {
    assert.doesNotMatch(feedback.message, /raw/i)
    assert.equal(feedback.attemptedAt, checkedAt)
  }
  assert.match(network.title, /could not be reached/)
  assert.match(backend.title, /temporarily unavailable/)
  assert.match(denied.title, /access must be refreshed/)
  assert.match(invalid.title, /response was invalid/)
})
