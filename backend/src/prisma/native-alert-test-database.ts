type Environment = Readonly<Record<string, string | undefined>>

function requireSafe(condition: boolean, message: string): void {
  if (!condition) throw new Error(message)
}

/** Parse only. Never opens a connection or includes supplied values in errors. */
export function parseDisposablePostgresUrl(value: string | undefined): URL {
  let url: URL
  try {
    url = new URL(value ?? '')
  } catch {
    throw new Error('Invalid disposable PostgreSQL test database URL')
  }
  requireSafe(!value!.includes('?') && url.search === '', 'Database URL queries are not permitted')
  requireSafe(!value!.includes('#') && url.hash === '', 'Database URL fragments are not permitted')
  requireSafe(['postgresql:', 'postgres:'].includes(url.protocol), 'PostgreSQL required')
  requireSafe(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname), 'Loopback DB only')
  requireSafe(/^\/[^/]+$/.test(url.pathname), 'Explicit database name required')
  return url
}

/**
 * Shared connection boundary. Existing suite-specific assertions remain in the
 * caller. Native suites retain their stricter UTC and reserved-name policy.
 */
export function assertDisposableTestDatabase(
  environment: Environment = process.env,
  options: { requireUtc?: boolean; native?: boolean; retention?: boolean } = {},
): URL {
  requireSafe(environment.HAWKVIEW_RUN_DATABASE_INTEGRATION_TESTS === '1',
    'Explicit disposable DB test opt-in required')
  if (options.requireUtc || options.retention) {
    requireSafe(environment.TZ === 'UTC', 'UTC Node process required')
  }
  const url = parseDisposablePostgresUrl(environment.DATABASE_URL)
  if (url.port === '5432') {
    requireSafe(environment.HAWKVIEW_CI_DISPOSABLE_POSTGRES === '1', 'Explicit CI service marker required')
    requireSafe(environment.GITHUB_ACTIONS === 'true', 'GitHub Actions context required')
    requireSafe(environment.RUNNER_ENVIRONMENT === 'github-hosted', 'Hosted disposable runner required')
    requireSafe(environment.GITHUB_WORKFLOW === 'Required quality gates', 'Provisioning workflow required')
    requireSafe(environment.GITHUB_JOB === 'backend-quality', 'Provisioning backend job required')
    requireSafe(url.hostname === '127.0.0.1', 'Exact CI service host required')
    requireSafe(url.pathname === '/hawkview_ci', 'Exact CI database required')
    requireSafe(url.username === 'hawkview_ci', 'Exact CI database user required')
    return url
  }
  requireSafe(url.port === '55432', 'Reserved local disposable PostgreSQL port required')
  const name = url.pathname.slice(1)
  if (options.retention) {
    requireSafe(/^hv_qa_native_alert(?:_[a-z0-9]+)*$/.test(name),
      'Dedicated native retention database required')
  } else {
    const nativeEvidence = options.native && [
      'hv_e2_m65_fresh_20260914', 'hv_e2_m65_upgrade_20260914',
    ].includes(name)
    requireSafe(/test|qa|^hawkview_ci$/i.test(name) || Boolean(nativeEvidence),
      'Reserved test/QA database required')
  }
  return url
}

/** Stable native-suite API; no caller may relax its UTC requirement. */
export function assertDisposableNativeAlertDatabase(
  environment: Environment = process.env,
  options: { retention?: boolean } = {},
): URL {
  return assertDisposableTestDatabase(environment, { ...options, native: true, requireUtc: true })
}
