import metadata from './frontend-release.json' with { type: 'json' }

export type FrontendRelease = Readonly<{
  phase: number | null
  pullRequest: number | null
  label: string
}>

export function parseFrontendRelease(value: unknown): FrontendRelease {
  const unavailable = Object.freeze({ phase: null, pullRequest: null, label: 'Unavailable' })
  if (!value || typeof value !== 'object' || Array.isArray(value)) return unavailable
  const record = value as Record<string, unknown>
  if (Object.keys(record).sort().join(',') !== 'phase,pullRequest') return unavailable
  const { phase, pullRequest } = record
  if (typeof phase !== 'number' || !Number.isSafeInteger(phase) || phase < 1) return unavailable
  if (pullRequest !== null && (typeof pullRequest !== 'number' || !Number.isSafeInteger(pullRequest) || pullRequest < 1)) return unavailable
  return Object.freeze({ phase, pullRequest, label: `${phase}.${pullRequest ?? 'local'}` })
}

export const FRONTEND_RELEASE = parseFrontendRelease(metadata)
