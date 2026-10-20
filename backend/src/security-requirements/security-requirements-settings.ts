import { domainToASCII } from 'node:url'

export const PARAMETERIZED_CHECKS = {
  'sharepoint-approved-partner-domains-v1': 'approvedDomains',
  'onedrive-sync-approved-domain-guids-v1': 'approvedDomainGuids',
  'onedrive-deleted-user-retention-minimum-v1': 'minimumDays',
  'm365-required-verified-domains-v1': 'requiredDomains',
} as const

export type CheckSettings = Partial<{
  'sharepoint-approved-partner-domains-v1': { approvedDomains: string[] }
  'onedrive-sync-approved-domain-guids-v1': { approvedDomainGuids: string[] }
  'onedrive-deleted-user-retention-minimum-v1': { minimumDays: number }
  'm365-required-verified-domains-v1': { requiredDomains: string[] }
}>

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/

export function normalizeDomain(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const ascii = domainToASCII(value.trim().replace(/\.$/, '')).toLowerCase()
  if (
    ascii.length < 3 ||
    ascii.length > 253 ||
    !ascii.includes('.') ||
    ascii.split('.').some((label) => !LABEL.test(label))
  )
    return null
  return ascii
}

export function normalizeGuid(value: unknown): string | null {
  return typeof value === 'string' && GUID.test(value.trim())
    ? value.trim().toLowerCase()
    : null
}

function object(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function normalizedList(
  value: unknown,
  normalize: (value: unknown) => string | null,
  label: string
): string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 100) {
    throw new Error(`Enter 1–100 ${label}.`)
  }
  const values = value.map(normalize)
  if (
    values.some((item) => item === null) ||
    new Set(values).size !== values.length
  ) {
    throw new Error(`Enter distinct valid ${label}.`)
  }
  return (values as string[]).sort()
}

/** Strictly validate persisted MSP choices; unknown/unselected configuration is never silently accepted. */
export function parseCheckSettings(
  value: unknown,
  selectedIds: readonly string[]
): CheckSettings {
  if (value === undefined) value = {}
  if (!object(value)) throw new Error('Check settings must be an object.')
  const settings: CheckSettings = {}
  const selected = new Set(selectedIds)
  for (const key of Object.keys(value)) {
    if (!(key in PARAMETERIZED_CHECKS) || !selected.has(key)) {
      throw new Error(
        'Check settings contain an unsupported or unselected requirement.'
      )
    }
  }
  for (const key of Object.keys(PARAMETERIZED_CHECKS) as Array<
    keyof typeof PARAMETERIZED_CHECKS
  >) {
    if (!selected.has(key)) continue
    const raw = value[key]
    if (
      !object(raw) ||
      Object.keys(raw).length !== 1 ||
      !(PARAMETERIZED_CHECKS[key] in raw)
    ) {
      throw new Error(`Set the required value for ${key}.`)
    }
    if (key === 'sharepoint-approved-partner-domains-v1') {
      settings[key] = {
        approvedDomains: normalizedList(
          raw.approvedDomains,
          normalizeDomain,
          'partner domains'
        ),
      }
    } else if (key === 'onedrive-sync-approved-domain-guids-v1') {
      settings[key] = {
        approvedDomainGuids: normalizedList(
          raw.approvedDomainGuids,
          normalizeGuid,
          'domain GUIDs'
        ),
      }
    } else if (key === 'm365-required-verified-domains-v1') {
      settings[key] = {
        requiredDomains: normalizedList(
          raw.requiredDomains,
          normalizeDomain,
          'required verified domains'
        ),
      }
    } else {
      if (
        !Number.isInteger(raw.minimumDays) ||
        (raw.minimumDays as number) < 30 ||
        (raw.minimumDays as number) > 3650
      ) {
        throw new Error(
          'Choose a OneDrive retention minimum from 30 to 3650 days.'
        )
      }
      settings[key] = { minimumDays: raw.minimumDays as number }
    }
  }
  return settings
}
