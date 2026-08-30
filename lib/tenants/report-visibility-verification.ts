import type {
  ReportVisibilityVerification,
  ReportVisibilityVerificationResult,
} from './tenant-onboarding'

export type ReportVerificationFeedback = {
  tone: 'info' | 'success' | 'warning' | 'error'
  title: string
  message: string
  attemptedAt: string
  checkedAt: string | null
}

const SETTING_INSTRUCTION =
  'In Microsoft 365, uncheck “Conceal user, group, and site names in all reports,” then Save.'
const PROPAGATION_GUIDANCE =
  'Microsoft permission and setting changes may take a few minutes to propagate.'

export function reportVerificationChecking(
  attemptedAt: string,
): ReportVerificationFeedback {
  return {
    tone: 'info',
    title: 'Checking Microsoft…',
    message: 'HawkView is reading the Microsoft 365 report privacy setting. It will not change the setting.',
    attemptedAt,
    checkedAt: null,
  }
}

export function reportVerificationFeedback(
  verification: ReportVisibilityVerification,
  attemptedAt = verification.checkedAt,
): ReportVerificationFeedback {
  const common = { attemptedAt, checkedAt: verification.checkedAt }
  switch (verification.status) {
    case 'READY':
      return {
        ...common,
        tone: 'success',
        title: 'Report names confirmed',
        message: 'Microsoft confirms the concealment setting is unchecked. HawkView can match identifiable report activity, and this step is complete.',
      }
    case 'IDENTIFIERS_CONCEALED':
      return {
        ...common,
        tone: 'warning',
        title: 'Names are still concealed',
        message: `${SETTING_INSTRUCTION} ${PROPAGATION_GUIDANCE} Then verify again.`,
      }
    case 'MISSING_PERMISSION':
      return {
        ...common,
        tone: 'error',
        title: 'Read permission required',
        message: `HawkView does not currently have ReportSettings.Read.All. Re-consent the Microsoft connection, then retry. ${PROPAGATION_GUIDANCE}`,
      }
    case 'MICROSOFT_DENIED':
      return {
        ...common,
        tone: 'error',
        title: 'Microsoft denied the read-only check',
        message: `Confirm admin consent for ReportSettings.Read.All and re-consent if needed. ${PROPAGATION_GUIDANCE} Then retry.`,
      }
    case 'TOKEN_UNAVAILABLE':
      return {
        ...common,
        tone: 'warning',
        title: 'Microsoft access is not ready yet',
        message: `HawkView could not obtain a Microsoft access token. ${PROPAGATION_GUIDANCE} Retry; if this continues, re-consent the Microsoft connection.`,
      }
    case 'CONNECTION_INCOMPLETE':
      return {
        ...common,
        tone: 'error',
        title: 'Microsoft connection is incomplete',
        message: 'Complete or reconnect Microsoft access before verifying this setting.',
      }
    case 'MICROSOFT_UNAVAILABLE':
      return {
        ...common,
        tone: verification.retryable ? 'warning' : 'error',
        title: 'Microsoft could not complete the check',
        message: verification.retryable
          ? 'Microsoft is temporarily unavailable or throttling requests. Wait a few minutes, then retry.'
          : 'Microsoft returned an error for the read-only check. Review Microsoft access, then retry.',
      }
    case 'NETWORK_ERROR':
      return {
        ...common,
        tone: 'warning',
        title: 'Microsoft could not be reached',
        message: 'The read-only Microsoft request timed out or encountered a network error. Check connectivity, then retry.',
      }
    case 'INVALID_RESPONSE':
      return {
        ...common,
        tone: 'warning',
        title: 'Microsoft returned an invalid response',
        message: 'HawkView did not receive a usable report-setting value. No setting was changed. Retry in a few minutes.',
      }
  }
}

export function reportVerificationRequestFailure(
  error: unknown,
  attemptedAt: string,
): ReportVerificationFeedback {
  const apiStatus = error instanceof Error && error.name === 'ApiError'
    && Object.prototype.hasOwnProperty.call(error, 'status')
    && typeof (error as Error & { status?: unknown }).status === 'number'
      ? (error as Error & { status: number }).status
      : null
  if (apiStatus !== null) {
    if (apiStatus === 0) {
      return {
        tone: 'warning',
        title: 'Verification service could not be reached',
        message: 'The HawkView request timed out or the network is unavailable. Check connectivity, then retry.',
        attemptedAt,
        checkedAt: null,
      }
    }
    if (apiStatus === 401 || apiStatus === 403) {
      return {
        tone: 'error',
        title: 'HawkView access must be refreshed',
        message: 'Your HawkView session could not perform this verification. Sign in again and retry.',
        attemptedAt,
        checkedAt: null,
      }
    }
    if (apiStatus === 429 || apiStatus >= 500) {
      return {
        tone: 'warning',
        title: 'Verification service is temporarily unavailable',
        message: 'HawkView could not complete the backend verification. Wait a few minutes, then retry.',
        attemptedAt,
        checkedAt: null,
      }
    }
  }
  if (error instanceof Error && error.name === 'ZodError') {
    return {
      tone: 'error',
      title: 'Verification response was invalid',
      message: 'HawkView received an unexpected response and did not complete this step. Retry; contact support if it continues.',
      attemptedAt,
      checkedAt: null,
    }
  }
  return {
    tone: 'error',
    title: 'Verification could not be completed',
    message: 'HawkView could not verify the Microsoft setting. No setting was changed. Check connectivity and retry.',
    attemptedAt,
    checkedAt: null,
  }
}

export async function executeReportVisibilityVerification(input: {
  request: () => Promise<ReportVisibilityVerificationResult>
  onFeedback: (feedback: ReportVerificationFeedback) => void
  now?: () => string
}) {
  const attemptedAt = input.now?.() ?? new Date().toISOString()
  input.onFeedback(reportVerificationChecking(attemptedAt))
  try {
    const result = await input.request()
    input.onFeedback(reportVerificationFeedback(result.verification, attemptedAt))
    return result
  } catch (error) {
    input.onFeedback(reportVerificationRequestFailure(error, attemptedAt))
    throw error
  }
}
