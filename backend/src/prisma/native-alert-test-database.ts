import assert from 'node:assert/strict'

type Environment = Readonly<Record<string, string | undefined>>

/**
 * Local fixtures retain their reserved port/name rules. Port 5432 is accepted
 * only for the exact disposable service explicitly provisioned by our hosted
 * backend CI job; CI=true alone is never sufficient.
 */
export function assertDisposableNativeAlertDatabase(
  environment: Environment = process.env,
  options: { retention?: boolean } = {},
): URL {
  assert.equal(environment.HAWKVIEW_RUN_DATABASE_INTEGRATION_TESTS, '1',
    'Explicit disposable DB test opt-in required')
  assert.equal(environment.TZ, 'UTC', 'UTC Node process required')
  let url: URL
  try {
    url = new URL(environment.DATABASE_URL ?? '')
  } catch {
    throw new Error('Invalid disposable PostgreSQL test database URL')
  }
  assert.ok(['postgresql:', 'postgres:'].includes(url.protocol), 'PostgreSQL required')
  assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname), 'Loopback DB only')
  assert.equal(url.hash, '', 'Database URL fragments are not permitted')
  const routingOverrides = new Set([
    'host', 'hostaddr', 'port', 'dbname', 'database', 'user', 'username',
    'password', 'service', 'options', 'search_path',
  ])
  for (const key of url.searchParams.keys()) {
    assert.ok(!routingOverrides.has(key.toLowerCase()), 'Connection target overrides are not permitted')
  }

  if (url.port === '5432') {
    assert.equal(environment.HAWKVIEW_CI_DISPOSABLE_POSTGRES, '1', 'Explicit CI service marker required')
    assert.equal(environment.GITHUB_ACTIONS, 'true', 'GitHub Actions context required')
    assert.equal(environment.RUNNER_ENVIRONMENT, 'github-hosted', 'Hosted disposable runner required')
    assert.equal(environment.GITHUB_WORKFLOW, 'Required quality gates', 'Provisioning workflow required')
    assert.equal(environment.GITHUB_JOB, 'backend-quality', 'Provisioning backend job required')
    assert.equal(url.hostname, '127.0.0.1', 'Exact CI service host required')
    assert.equal(url.pathname, '/hawkview_ci', 'Exact CI database required')
    assert.equal(url.username, 'hawkview_ci', 'Exact CI database user required')
    assert.equal(url.search, '', 'CI service URL must not override connection settings')
    return url
  }

  assert.equal(url.port, '55432', 'Reserved local disposable PostgreSQL port required')
  const databaseName = url.pathname.replace(/^\/+/, '')
  const explicitlyReserved = new Set([
    'hv_e2_m65_fresh_20260914',
    'hv_e2_m65_upgrade_20260914',
  ])
  const validName = options.retention
    ? /^hv_qa_native_alert(?:_[a-z0-9]+)*$/.test(databaseName)
    : /test|qa|^hawkview_ci$/i.test(databaseName)
  assert.ok(validName || explicitlyReserved.has(databaseName), 'Reserved test/QA database required')
  return url
}
