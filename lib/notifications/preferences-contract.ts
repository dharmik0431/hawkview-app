export const NOTIFICATION_SEVERITIES = [
  'info',
  'low',
  'medium',
  'high',
  'critical',
] as const

export const STORED_DIGEST_MODES = ['off', 'daily', 'weekly'] as const

export type NotificationSeverity = (typeof NOTIFICATION_SEVERITIES)[number]
export type StoredDigestMode = (typeof STORED_DIGEST_MODES)[number]
export type EmailAvailability =
  | 'DISABLED'
  | 'CONTROLLED'
  | 'UNAVAILABLE'
export type EmailAvailabilityReason =
  | 'SENDER_OFF'
  | 'CONTROLLED_TRIAL_ONLY'
  | 'CONFIGURATION_UNAVAILABLE'
  | 'OUTSIDE_ACTIVATION_WINDOW'
  | 'NOT_DESIGNATED_RECIPIENT'

export type NotificationCapabilities = {
  version: 1
  readState: 'AVAILABLE'
  policyWriterRole: 'MSP_OWNER'
  supportedDigestModes: ['off']
  channels: {
    inApp: { supported: true; availability: 'AVAILABLE' }
    email: {
      supported: true
      availability: EmailAvailability
      reason: EmailAvailabilityReason
    }
  }
}

export type NotificationPreferences = {
  id: string
  organizationId: string
  securityEnabled: boolean
  connectionEnabled: boolean
  synchronizationEnabled: boolean
  accountEnabled: boolean
  inAppEnabled: boolean
  emailEnabled: boolean
  minimumSeverity: NotificationSeverity
  digestMode: StoredDigestMode
  canManagePolicy: boolean
  capabilities: NotificationCapabilities
}

const BOOLEAN_FIELDS = [
  'securityEnabled',
  'connectionEnabled',
  'synchronizationEnabled',
  'accountEnabled',
  'inAppEnabled',
  'emailEnabled',
] as const

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isOneOf<T extends string>(
  value: unknown,
  options: readonly T[]
): value is T {
  return typeof value === 'string' && options.includes(value as T)
}

export function readNotificationCapabilities(
  value: unknown
): NotificationCapabilities | null {
  if (!isRecord(value) || value.version !== 1 || value.readState !== 'AVAILABLE') {
    return null
  }
  if (value.policyWriterRole !== 'MSP_OWNER') return null
  if (
    !Array.isArray(value.supportedDigestModes) ||
    value.supportedDigestModes.length !== 1 ||
    value.supportedDigestModes[0] !== 'off'
  ) {
    return null
  }
  if (!isRecord(value.channels)) return null
  const inApp = value.channels.inApp
  const email = value.channels.email
  if (
    !isRecord(inApp) ||
    inApp.supported !== true ||
    inApp.availability !== 'AVAILABLE'
  ) {
    return null
  }
  if (
    !isRecord(email) ||
    email.supported !== true ||
    !isOneOf(email.availability, ['DISABLED', 'CONTROLLED', 'UNAVAILABLE']) ||
    !isOneOf(email.reason, [
      'SENDER_OFF',
      'CONTROLLED_TRIAL_ONLY',
      'CONFIGURATION_UNAVAILABLE',
      'OUTSIDE_ACTIVATION_WINDOW',
      'NOT_DESIGNATED_RECIPIENT',
    ])
  ) {
    return null
  }
  const validEmailState =
    (email.availability === 'DISABLED' && email.reason === 'SENDER_OFF') ||
    (email.availability === 'CONTROLLED' &&
      email.reason === 'CONTROLLED_TRIAL_ONLY') ||
    (email.availability === 'UNAVAILABLE' &&
      [
        'CONFIGURATION_UNAVAILABLE',
        'OUTSIDE_ACTIVATION_WINDOW',
        'NOT_DESIGNATED_RECIPIENT',
      ].includes(email.reason as string))
  if (!validEmailState) return null

  return {
    version: 1,
    readState: 'AVAILABLE',
    policyWriterRole: 'MSP_OWNER',
    supportedDigestModes: ['off'],
    channels: {
      inApp: { supported: true, availability: 'AVAILABLE' },
      email: {
        supported: true,
        availability: email.availability,
        reason: email.reason,
      },
    },
  }
}

export function readNotificationPreferences(
  value: unknown
): NotificationPreferences | null {
  if (!isRecord(value)) return null
  const id = typeof value.id === 'string' && value.id.trim() ? value.id : null
  const organizationId =
    typeof value.organizationId === 'string' && value.organizationId.trim()
      ? value.organizationId
      : null
  const capabilities = readNotificationCapabilities(value.capabilities)
  if (!id || !organizationId || !capabilities) return null
  if (typeof value.canManagePolicy !== 'boolean') return null
  for (const field of BOOLEAN_FIELDS) {
    if (typeof value[field] !== 'boolean') return null
  }
  if (!isOneOf(value.minimumSeverity, NOTIFICATION_SEVERITIES)) return null
  if (!isOneOf(value.digestMode, STORED_DIGEST_MODES)) return null

  return {
    id,
    organizationId,
    securityEnabled: value.securityEnabled as boolean,
    connectionEnabled: value.connectionEnabled as boolean,
    synchronizationEnabled: value.synchronizationEnabled as boolean,
    accountEnabled: value.accountEnabled as boolean,
    inAppEnabled: value.inAppEnabled as boolean,
    emailEnabled: value.emailEnabled as boolean,
    minimumSeverity: value.minimumSeverity,
    digestMode: value.digestMode,
    canManagePolicy: value.canManagePolicy,
    capabilities,
  }
}

export type NotificationPreferencesPatch = {
  organizationId: string
  securityEnabled?: boolean
  connectionEnabled?: boolean
  synchronizationEnabled?: boolean
  accountEnabled?: boolean
  inAppEnabled?: boolean
  emailEnabled?: boolean
  minimumSeverity?: NotificationSeverity
  digestMode?: 'off'
}

/**
 * The legacy API stores daily/weekly and a five-level severity threshold, but
 * the capability response only proves immediate delivery (`off`). Preserve
 * unsupported stored values unless the person explicitly chooses the one
 * supported option, and never send a severity value the alert catalogue does
 * not speak.
 */
export function notificationPreferencesPatch(
  original: NotificationPreferences,
  draft: NotificationPreferences
): NotificationPreferencesPatch {
  const patch: NotificationPreferencesPatch = {
    organizationId: original.organizationId,
  }
  for (const field of BOOLEAN_FIELDS) {
    if (draft[field] !== original[field]) patch[field] = draft[field]
  }
  if (draft.minimumSeverity !== original.minimumSeverity) {
    patch.minimumSeverity = draft.minimumSeverity
  }
  if (draft.digestMode !== original.digestMode && draft.digestMode === 'off') {
    patch.digestMode = 'off'
  }
  return patch
}

export function hasPreferenceChanges(
  original: NotificationPreferences,
  draft: NotificationPreferences
) {
  return Object.keys(notificationPreferencesPatch(original, draft)).length > 1
}

export function emailAvailabilityCopy(
  capabilities: NotificationCapabilities
): { title: string; detail: string } {
  const { availability, reason } = capabilities.channels.email
  if (availability === 'CONTROLLED') {
    return {
      title: 'Email delivery is controlled',
      detail:
        reason === 'NOT_DESIGNATED_RECIPIENT'
          ? 'You can save your email preference, but this account is not a designated recipient in the controlled release.'
          : reason === 'OUTSIDE_ACTIVATION_WINDOW'
            ? 'You can save your email preference, but email delivery is outside the current controlled activation window.'
            : 'You can save your email preference, but delivery is limited to the controlled release.',
    }
  }
  if (availability === 'DISABLED') {
    return {
      title: 'Email sending is off',
      detail:
        'Your opt-in can be saved for future use. Turning it on here does not activate email delivery.',
    }
  }
  return {
    title: 'Email delivery is unavailable',
    detail:
      'Your existing preference is preserved, but HawkView cannot confirm an email delivery configuration.',
  }
}
