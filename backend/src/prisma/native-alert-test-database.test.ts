import assert from 'node:assert/strict'
import { Socket } from 'node:net'
import test from 'node:test'
import pg from 'pg'
import { inspect } from 'node:util'
import { assertDisposableNativeAlertDatabase, assertDisposableTestDatabase, parseDisposablePostgresUrl } from './native-alert-test-database.js'

const local = {
  TZ: 'UTC',
  HAWKVIEW_RUN_DATABASE_INTEGRATION_TESTS: '1',
  DATABASE_URL: 'postgresql://fixture:fixture@127.0.0.1:55432/hv_qa_native_alert_guard',
}
const hosted = {
  TZ: 'UTC',
  HAWKVIEW_RUN_DATABASE_INTEGRATION_TESTS: '1',
  HAWKVIEW_CI_DISPOSABLE_POSTGRES: '1',
  GITHUB_ACTIONS: 'true',
  RUNNER_ENVIRONMENT: 'github-hosted',
  GITHUB_WORKFLOW: 'Required quality gates',
  GITHUB_JOB: 'backend-quality',
  DATABASE_URL: 'postgresql://hawkview_ci:fixture@127.0.0.1:5432/hawkview_ci',
}

test('exact opted-in hosted CI service is accepted, including retention fixtures', () => {
  assert.equal(assertDisposableNativeAlertDatabase(hosted).port, '5432')
  assert.equal(assertDisposableNativeAlertDatabase(hosted, { retention: true }).pathname, '/hawkview_ci')
})

for (const hostname of ['127.0.0.1', 'localhost', '[::1]']) {
  test(`reserved local fixture remains accepted on ${hostname}:55432`, () => {
    const environment = { ...local, DATABASE_URL: `postgresql://fixture:fixture@${hostname}:55432/hv_qa_native_alert_guard` }
    assert.equal(assertDisposableNativeAlertDatabase(environment, { retention: true }).port, '55432')
  })
}

for (const name of ['hv_e2_m65_fresh_20260914', 'hv_e2_m65_upgrade_20260914']) {
  test(`reserved migration database is never admitted to native retention: ${name}`, () => {
    const environment = {
      ...local, DATABASE_URL: `postgresql://fixture:fixture@localhost:55432/${name}`,
    }
    assert.throws(() => assertDisposableNativeAlertDatabase(environment, { retention: true }))
    assert.equal(assertDisposableNativeAlertDatabase(environment).pathname, `/${name}`)
    assert.throws(() => assertDisposableTestDatabase(environment))
  })
}

for (const value of [undefined, '0', 'true']) {
  test(`both target classes reject missing or inexact integration opt-in: ${String(value)}`, () => {
    for (const environment of [local, hosted]) {
      assert.throws(() => assertDisposableNativeAlertDatabase({
        ...environment, HAWKVIEW_RUN_DATABASE_INTEGRATION_TESTS: value,
      }))
    }
  })
}

for (const key of [
  'HAWKVIEW_CI_DISPOSABLE_POSTGRES', 'GITHUB_ACTIONS', 'RUNNER_ENVIRONMENT',
  'GITHUB_WORKFLOW', 'GITHUB_JOB',
] as const) {
  test(`5432 fails closed without the exact provisioning context: ${key}`, () => {
    assert.throws(() => assertDisposableNativeAlertDatabase({ ...hosted, [key]: undefined }))
    assert.throws(() => assertDisposableNativeAlertDatabase({ ...hosted, [key]: 'other' }))
  })
}

test('ordinary local 5432 and a generic CI flag never authorize database access', () => {
  assert.throws(() => assertDisposableNativeAlertDatabase({
    ...local, DATABASE_URL: hosted.DATABASE_URL,
  }))
  assert.throws(() => assertDisposableNativeAlertDatabase({
    ...local, DATABASE_URL: hosted.DATABASE_URL, CI: 'true',
  }))
})

for (const [caseIndex, url] of [
  'postgresql://hawkview_ci:fixture@localhost:5432/hawkview_ci',
  'postgresql://other:fixture@127.0.0.1:5432/hawkview_ci',
  'postgresql://hawkview_ci:fixture@127.0.0.1:5432/production',
  'postgresql://hawkview_ci:fixture@127.0.0.1:5432/other_test',
  'postgresql://hawkview_ci:fixture@127.0.0.1/hawkview_ci',
  'postgresql://hawkview_ci:fixture@127.0.0.1:5433/hawkview_ci',
  'postgresql://hawkview_ci:fixture@database.invalid:5432/hawkview_ci',
  'postgresql://hawkview_ci:fixture@192.0.2.1:5432/hawkview_ci',
  'https://hawkview_ci:fixture@127.0.0.1:5432/hawkview_ci',
  'postgresql://hawkview_ci:fixture@127.0.0.1:5432/hawkview_ci?host=database.invalid',
  'postgresql://hawkview_ci:fixture@127.0.0.1:5432/hawkview_ci?schema=other',
].entries()) {
  test(`CI rejects service-target mismatch case ${caseIndex + 1}`, () => {
    assert.throws(() => assertDisposableNativeAlertDatabase({ ...hosted, DATABASE_URL: url }))
  })
}

test('local fixtures reject non-test names, non-loopback targets and query routing overrides', () => {
  for (const url of [
    'postgresql://fixture:fixture@127.0.0.1:55432/production',
    'postgresql://fixture:fixture@database.invalid:55432/hv_qa_native_alert_guard',
    'postgresql://fixture:fixture@127.0.0.1:55432/hv_qa_native_alert_guard?host=database.invalid',
    'postgresql://fixture:fixture@127.0.0.1:55432/hv_qa_native_alert_guard?%68ost=database.invalid',
    'postgresql://fixture:fixture@127.0.0.1:55432/hv_qa_native_alert_guard?options=-csearch_path%3Dother',
  ]) assert.throws(() => assertDisposableNativeAlertDatabase({ ...local, DATABASE_URL: url }))
  assert.throws(() => assertDisposableNativeAlertDatabase({
    ...local, DATABASE_URL: 'postgresql://fixture:fixture@127.0.0.1:55432/other_test',
  }, { retention: true }))
})

test('both target classes require explicit UTC rather than inherited host defaults', () => {
  for (const environment of [local, hosted]) {
    for (const TZ of [undefined, 'America/Toronto']) {
      assert.throws(() => assertDisposableNativeAlertDatabase({ ...environment, TZ }))
    }
  }
})

test('malformed credential-bearing input is rejected without connection attempts or error disclosure', (t) => {
  let connectionAttempts = 0
  t.mock.method(Socket.prototype, 'connect', () => {
    connectionAttempts += 1
    throw new Error('Unexpected connection attempt')
  })
  const password = 'synthetic-parser-regression-only'
  const malformed = `postgresql://fixture:${password}@[invalid:55432/hv_qa_native_alert_guard`
  let caught: unknown
  try {
    assertDisposableNativeAlertDatabase({ ...local, DATABASE_URL: malformed })
  } catch (error) {
    caught = error
  }
  assert.ok(caught instanceof Error)
  assert.equal(caught.message, 'Invalid disposable PostgreSQL test database URL')
  assert.equal('cause' in caught, false)
  assert.equal('input' in caught, false)
  const surfaces = [String(caught), caught.stack, JSON.stringify(caught), inspect(caught, { showHidden: true })].join('\n')
  assert.ok(!surfaces.includes(password), 'Error surfaces must not retain a password')
  assert.ok(!surfaces.includes(malformed), 'Error surfaces must not retain the input URL')
  assert.equal(connectionAttempts, 0)
})

test('every query or fragment is rejected before any socket attempt, with no input disclosure', (t) => {
  let attempts = 0
  t.mock.method(Socket.prototype, 'connect', () => {
    attempts += 1
    throw new Error('Unexpected socket')
  })
  const password = 'synthetic-hostile-parser-only'
  const authority = `postgresql://fixture:${password}@127.0.0.1:55432/hv_qa_native_alert_guard`
  const suffixes = [
    '?', '#', '?host=database.invalid', '?HOST=database.invalid', '?%68ost=database.invalid',
    '?host=127.0.0.1&host=database.invalid', '?hostaddr=192.0.2.1', '?options=-csearch_path%3Dother',
    '?service=other', '?user=other', '?password=other', '?port=5432', '?dbname=production',
    '?schema=public', '?sslmode=disable', '?connect_timeout=5', '#host=database.invalid',
  ]
  for (const suffix of suffixes) {
    const value = authority + suffix
    for (const parse of [
      () => parseDisposablePostgresUrl(value),
      () => assertDisposableTestDatabase({ ...local, DATABASE_URL: value }),
      () => assertDisposableNativeAlertDatabase({ ...local, DATABASE_URL: value }, { retention: true }),
    ]) {
      let error: unknown
      try { parse() } catch (caught) { error = caught }
      assert.ok(error instanceof Error)
      const surface = [String(error), error.stack, JSON.stringify(error), inspect(error, { showHidden: true })].join('\n')
      assert.equal('cause' in error, false)
      assert.equal('input' in error, false)
      assert.ok(!surface.includes(password))
      assert.ok(!surface.includes(value))
    }
  }
  assert.equal(attempts, 0)
})

test('legacy boundary narrows missing guards without relaxing native restrictions', () => {
  assert.equal(assertDisposableTestDatabase(local).port, '55432')
  assert.equal(assertDisposableTestDatabase(hosted).pathname, '/hawkview_ci')
  assert.equal(assertDisposableTestDatabase({ ...local, TZ: 'America/New_York' }).port, '55432')
  assert.throws(() => assertDisposableTestDatabase({ ...local, TZ: 'America/New_York' }, { requireUtc: true }))
  for (const port of ['', ':1', ':5433', ':6543']) {
    assert.throws(() => assertDisposableTestDatabase({
      ...local, DATABASE_URL: `postgresql://fixture:fixture@127.0.0.1${port}/hawkview_test`,
    }))
  }
  assert.throws(() => assertDisposableTestDatabase({ ...local, HAWKVIEW_RUN_DATABASE_INTEGRATION_TESTS: undefined }))
  assert.throws(() => assertDisposableTestDatabase({ ...local, DATABASE_URL: local.DATABASE_URL.replace('hv_qa_native_alert_guard', 'production') }))
})

test('fixed timezone driver options reach the actual pg connection parameters without URI queries', (t) => {
  let attempts = 0
  t.mock.method(Socket.prototype, 'connect', () => { attempts += 1; throw new Error('Unexpected socket') })
  const previous = process.env.PGOPTIONS
  const url = assertDisposableTestDatabase(local)
  try {
    for (const zone of ['UTC', 'America/New_York', 'Asia/Kolkata']) {
      const options = `-c timezone=${zone}`
      process.env.PGOPTIONS = options
      const inherited = new pg.Client({ connectionString: url.toString() })
      const explicit = new pg.Client({ connectionString: url.toString(), options })
      for (const client of [inherited, explicit]) {
        const parameters = (client as unknown as { connectionParameters: { options: string; host: string; port: number; database: string } }).connectionParameters
        assert.equal(parameters.options, options)
        assert.equal(parameters.host, '127.0.0.1')
        assert.equal(parameters.port, 55432)
        assert.equal(parameters.database, 'hv_qa_native_alert_guard')
      }
    }
  } finally {
    if (previous === undefined) delete process.env.PGOPTIONS
    else process.env.PGOPTIONS = previous
  }
  assert.equal(attempts, 0)
})
