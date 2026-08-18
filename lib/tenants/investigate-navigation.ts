const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

/**
 * Canonicalize only the small set of internal investigation routes emitted by
 * the API. Router navigation must never accept a URL-shaped value as a route.
 */
export function investigateDestination(actionUrl: unknown, fallback: string) {
  if (typeof actionUrl !== 'string' || !actionUrl || actionUrl.trim() !== actionUrl) return fallback

  const decoded = boundedDecode(actionUrl)
  if (decoded === null) return fallback

  if (
    /[\u0000-\u001F\u007F]/.test(actionUrl) ||
    /[\u0000-\u001F\u007F]/.test(decoded) ||
    /[\\]/.test(actionUrl) ||
    decoded.startsWith('//') ||
    decoded.includes('\\') ||
    !decoded.startsWith('/')
  ) return fallback

  let parsed: URL
  try {
    parsed = new URL(actionUrl, 'https://hawkview.invalid')
  } catch {
    return fallback
  }
  if (parsed.origin !== 'https://hawkview.invalid') return fallback

  const canonicalPath = canonicalInternalPath(parsed.pathname)
  if (!canonicalPath) return fallback

  return `${canonicalPath}${parsed.search}`
}

function boundedDecode(value: string) {
  let decoded = value
  for (let depth = 0; depth < 2; depth += 1) {
    if (!decoded.includes('%')) return decoded
    try {
      const next = decodeURIComponent(decoded)
      if (next === decoded) return decoded
      decoded = next
    } catch {
      return null
    }
  }
  return decoded
}

function canonicalInternalPath(pathname: string) {
  if (pathname === '/what-changed') return pathname
  const match = /^\/tenants\/([^/]+)(\/settings)?$/.exec(pathname)
  if (!match || !UUID.test(match[1])) return null
  return `/tenants/${match[1].toLowerCase()}${match[2] ?? ''}`
}
