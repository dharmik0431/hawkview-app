import type { TenantOnboarding } from './tenant-onboarding'

export const MICROSOFT_CONSENT_MESSAGE = 'hawkview:microsoft-consent-complete'
export const MICROSOFT_CONSENT_CHANNEL = 'hawkview:microsoft-consent'
export const MICROSOFT_CONSENT_POPUP_MARKER = 'hawkview:microsoft-consent-popup'

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const SAFE_ERROR_PATTERN = /^[a-z0-9][a-z0-9-]{0,99}$/

export type MicrosoftConsentResult =
  | 'success'
  | 'missing-permissions'
  | 'error'
  | 'exchange-readonly-consented'
  | 'exchange-readonly-error'

export type MicrosoftConsentMessage = {
  type: typeof MICROSOFT_CONSENT_MESSAGE
  result: MicrosoftConsentResult
  error: string | null
  tenantId: string | null
}

export type ModalOnboardingStep = 1 | 2 | 3

type DialogFocusTarget = {
  focus: () => void
  getAttribute?: (name: string) => string | null
}

type DialogFocusRoot = {
  querySelectorAll: (selector: string) => ArrayLike<DialogFocusTarget>
}

type DialogKeyboardEvent = {
  key: string
  shiftKey: boolean
  preventDefault: () => void
}

type SessionStorageOwner = {
  readonly sessionStorage: {
    removeItem: (key: string) => void
  }
}

const own = (value: object, key: PropertyKey) =>
  Object.prototype.hasOwnProperty.call(value, key)

export function normalizedTenantId(value: unknown) {
  return typeof value === 'string' && UUID_PATTERN.test(value)
    ? value.toLowerCase()
    : null
}

export function normalizeMicrosoftConsentMessage(
  value: unknown,
): MicrosoftConsentMessage | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const candidate = value as Record<string, unknown>
  if (!own(candidate, 'type') || candidate.type !== MICROSOFT_CONSENT_MESSAGE) {
    return null
  }
  if (!own(candidate, 'result') || ![
    'success',
    'missing-permissions',
    'error',
    'exchange-readonly-consented',
    'exchange-readonly-error',
  ].includes(String(candidate.result))) {
    return null
  }
  const error = own(candidate, 'error') && candidate.error !== null
    ? typeof candidate.error === 'string' && SAFE_ERROR_PATTERN.test(candidate.error)
      ? candidate.error
      : null
    : null
  const tenantId = own(candidate, 'tenantId')
    ? normalizedTenantId(candidate.tenantId)
    : null
  return {
    type: MICROSOFT_CONSENT_MESSAGE,
    result: candidate.result as MicrosoftConsentResult,
    error,
    tenantId,
  }
}

export function consentMessageFromSearch(search: string) {
  const params = new URLSearchParams(search)
  const results = params.getAll('microsoftConsent')
  const tenantIds = params.getAll('tenantId')
  const errors = params.getAll('error')
  if (results.length !== 1 || tenantIds.length > 1 || errors.length > 1) {
    return null
  }
  const result = results[0]
  const message = normalizeMicrosoftConsentMessage({
    type: MICROSOFT_CONSENT_MESSAGE,
    result,
    error: errors[0] ?? null,
    tenantId: tenantIds[0] ?? null,
  })
  if (!message) return null

  if (message.result === 'success' ||
      message.result === 'exchange-readonly-consented') {
    return message.tenantId && errors.length === 0 ? message : null
  }
  if (message.result === 'missing-permissions') {
    return message.tenantId && message.error === 'missing-permissions'
      ? message
      : null
  }
  if (message.result === 'exchange-readonly-error') {
    return message.tenantId && message.error ? message : null
  }
  return message.error ? message : null
}

export function consentResultCanOpenSetup(
  message: MicrosoftConsentMessage | null,
): message is MicrosoftConsentMessage & { tenantId: string } {
  return Boolean(
    message?.tenantId &&
    (message.result === 'success' ||
      message.result === 'exchange-readonly-consented'),
  )
}

export function tenantSetupDismissedKey(tenantId: string) {
  return `hawkview:tenant-setup-dismissed:${tenantId}`
}

export async function withClearedTenantSetupDismissal<T>(
  owner: SessionStorageOwner,
  tenantId: string,
  operation: () => Promise<T>,
) {
  try {
    owner.sessionStorage.removeItem(tenantSetupDismissedKey(tenantId))
  } catch {
    // Session dismissal is a convenience only and must never block consent.
  }
  return operation()
}

export async function deferReportVisibilityWithServerState<T>(
  request: () => Promise<unknown>,
  parse: (value: unknown) => T,
): Promise<T> {
  return parse(await request())
}

export function handleDialogKeyboardBoundary(input: {
  event: DialogKeyboardEvent
  dialog: DialogFocusRoot | null
  activeElement: unknown
  closeDisabled: boolean
  onClose: () => void
}) {
  const { event, dialog, activeElement, closeDisabled, onClose } = input
  if (event.key === 'Escape') {
    if (!closeDisabled) {
      event.preventDefault()
      onClose()
    }
    return
  }
  if (event.key !== 'Tab' || !dialog) return

  const focusable = Array.from(dialog.querySelectorAll(
    'button:not(:disabled), [href], [tabindex]:not([tabindex="-1"])',
  )).filter((element) => element.getAttribute?.('aria-hidden') !== 'true')
  if (focusable.length === 0) {
    event.preventDefault()
    return
  }

  const activeIndex = focusable.indexOf(activeElement as DialogFocusTarget)
  const first = focusable[0]
  const last = focusable[focusable.length - 1]
  if (event.shiftKey && activeIndex <= 0) {
    event.preventDefault()
    last.focus()
  } else if (!event.shiftKey &&
      (activeIndex === -1 || activeIndex === focusable.length - 1)) {
    event.preventDefault()
    first.focus()
  }
}

export function restoreDialogFocus(target: DialogFocusTarget | null) {
  target?.focus()
}

export function tenantSetupCanAutoOpen(
  message: MicrosoftConsentMessage | null,
  dismissed: boolean,
) {
  return consentResultCanOpenSetup(message) && !dismissed
}

export function modalOnboardingStep(state: TenantOnboarding): ModalOnboardingStep {
  if (state.steps.microsoftAccess.status !== 'VERIFIED') return 1
  if (!['VERIFIED', 'DEFERRED'].includes(state.steps.exchangeReadOnly.status)) {
    return 2
  }
  return 3
}

export function modalOnboardingCanComplete(state: TenantOnboarding) {
  return state.canFinish &&
    state.steps.microsoftAccess.status === 'VERIFIED' &&
    ['VERIFIED', 'DEFERRED'].includes(state.steps.exchangeReadOnly.status) &&
    ['VERIFIED', 'DEFERRED'].includes(state.steps.reportVisibility.status)
}

export function modalStepStatus(
  state: TenantOnboarding | null,
  step: ModalOnboardingStep,
) {
  if (!state) return step === 1 ? 'Checking' : 'Not started'
  const active = modalOnboardingStep(state)
  if (step === 1) {
    return state.steps.microsoftAccess.status === 'VERIFIED'
      ? 'Complete'
      : active === 1 ? 'Needs attention' : 'Not started'
  }
  if (step === 2) {
    if (state.steps.exchangeReadOnly.status === 'VERIFIED') return 'Complete'
    if (state.steps.exchangeReadOnly.status === 'DEFERRED') return 'Skipped'
    return active === 2 ? 'Current' : 'Not started'
  }
  if (state.steps.reportVisibility.status === 'VERIFIED') return 'Complete'
  if (state.steps.reportVisibility.status === 'DEFERRED') return 'Skipped'
  return active === 3 ? 'Current' : 'Not started'
}

export function tenantSetupReturnPath(message: MicrosoftConsentMessage) {
  if (!consentResultCanOpenSetup(message)) return null
  const params = new URLSearchParams({
    microsoftConsent: message.result,
    tenantId: message.tenantId,
  })
  return `/tenants?${params.toString()}`
}
