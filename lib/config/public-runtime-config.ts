const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/

export const CANONICAL_SUPABASE_ORIGIN =
  'https://lvjqyvrtlkmhseelofda.supabase.co'
export const CANONICAL_HAWKVIEW_API_ORIGIN =
  'https://hawkview-api-dev.onrender.com'
export const CANONICAL_HAWKVIEW_APP_ORIGIN = 'https://console.hawkviewapp.com'

type RuntimeEnvironment = 'development' | 'production' | 'test' | undefined

function parseOrigin(value: string | null | undefined) {
  const candidate = value?.trim()
  if (!candidate || CONTROL_CHARACTERS.test(candidate)) return null

  try {
    const url = new URL(candidate)
    if (url.username || url.password || url.search || url.hash) return null
    if (url.pathname !== '/' && url.pathname !== '') return null
    return url.origin
  } catch {
    return null
  }
}

function isLocalDevelopmentOrigin(origin: string) {
  const url = new URL(origin)
  return (
    url.protocol === 'http:' &&
    (url.hostname === 'localhost' || url.hostname === '127.0.0.1')
  )
}

function resolveOrigin(
  value: string | null | undefined,
  canonicalOrigin: string,
  environment: RuntimeEnvironment
) {
  const parsed = parseOrigin(value)
  if (parsed === canonicalOrigin) return canonicalOrigin
  if (
    environment === 'development' &&
    parsed &&
    isLocalDevelopmentOrigin(parsed)
  ) {
    return parsed
  }

  // Production builds may be created by hosted editors that inject stale or
  // misspelled NEXT_PUBLIC values. A foreign origin must never become an auth
  // or tenant-data destination merely because it won environment precedence.
  return canonicalOrigin
}

export function resolveSupabaseOrigin(
  value: string | null | undefined,
  environment: RuntimeEnvironment = process.env.NODE_ENV
) {
  return resolveOrigin(value, CANONICAL_SUPABASE_ORIGIN, environment)
}

export function resolveHawkViewApiOrigin(
  value: string | null | undefined,
  environment: RuntimeEnvironment = process.env.NODE_ENV
) {
  return resolveOrigin(value, CANONICAL_HAWKVIEW_API_ORIGIN, environment)
}

export function resolveHawkViewAppOrigin(
  value: string | null | undefined,
  environment: RuntimeEnvironment = process.env.NODE_ENV
) {
  return resolveOrigin(value, CANONICAL_HAWKVIEW_APP_ORIGIN, environment)
}

export function isBrowserSafeSupabasePublishableKey(
  value: string | null | undefined
) {
  const candidate = value?.trim() ?? ''
  return (
    candidate.length >= 20 &&
    candidate.length <= 512 &&
    candidate.startsWith('sb_publishable_') &&
    !CONTROL_CHARACTERS.test(candidate) &&
    !/\s/.test(candidate)
  )
}

export function buildHawkViewApiUrl(
  endpoint: string,
  configuredOrigin: string | null | undefined = process.env.NEXT_PUBLIC_API_URL,
  environment: RuntimeEnvironment = process.env.NODE_ENV
) {
  if (!endpoint.startsWith('/') || endpoint.startsWith('//')) {
    throw new Error('API endpoints must be root-relative paths.')
  }

  const origin = resolveHawkViewApiOrigin(configuredOrigin, environment)
  const url = new URL(endpoint, `${origin}/`)
  if (url.origin !== origin) {
    throw new Error(
      'HawkView API request resolved outside the approved origin.'
    )
  }
  return url
}

export function buildHawkViewAppUrl(
  path: string,
  configuredOrigin: string | null | undefined = process.env
    .NEXT_PUBLIC_SITE_URL,
  environment: RuntimeEnvironment = process.env.NODE_ENV
) {
  if (!path.startsWith('/') || path.startsWith('//')) {
    throw new Error('Application destinations must be root-relative paths.')
  }

  const origin = resolveHawkViewAppOrigin(configuredOrigin, environment)
  const url = new URL(path, `${origin}/`)
  if (url.origin !== origin) {
    throw new Error(
      'HawkView application destination resolved outside the approved origin.'
    )
  }
  return url
}

export const publicRuntimeConfig = Object.freeze({
  supabaseOrigin: resolveSupabaseOrigin(process.env.NEXT_PUBLIC_SUPABASE_URL),
  hawkViewApiOrigin: resolveHawkViewApiOrigin(process.env.NEXT_PUBLIC_API_URL),
  hawkViewAppOrigin: resolveHawkViewAppOrigin(process.env.NEXT_PUBLIC_SITE_URL),
})
