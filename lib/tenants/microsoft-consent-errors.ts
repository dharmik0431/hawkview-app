const GENERIC_MICROSOFT_CONSENT_ERROR =
  'Microsoft administrator consent could not be verified. Review the tenant connection and try again.'

const MICROSOFT_CONSENT_ERRORS: Record<string, string> = {
  'tenant-already-connected':
    'This Microsoft 365 tenant is already connected to another HawkView organization. Ask an administrator of that organization to remove the tenant before adding it here.',
}

export function microsoftConsentErrorMessage(error: string | null | undefined) {
  if (!error) return GENERIC_MICROSOFT_CONSENT_ERROR
  return MICROSOFT_CONSENT_ERRORS[error] ?? GENERIC_MICROSOFT_CONSENT_ERROR
}

