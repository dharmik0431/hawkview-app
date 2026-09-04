import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

function assertDispatchResult(result, scenario) {
  assert.ifError(result.error)
  assert.equal(result.signal, null)
  const output = `${result.stdout}\n${result.stderr}`
  assert.doesNotMatch(output, /PRIVATE_CRON_SENTINEL|synthetic-cron-smoke-secret|Bearer |ERR_MODULE_NOT_FOUND/)
  assert.equal((result.stdout.match(/CRON_SMOKE_REQUESTS=1/g) ?? []).length, 1)
  if (scenario === 'success') {
    assert.equal(result.status, 0, output)
    assert.equal(result.stderr, '')
    assert.equal(result.stdout.replace(/\s+/g, ' ').trim(),
      "Scheduled synchronization completed. { outcome: 'COMPLETED', due: 2, succeeded: 1, partial: 1, failed: 0, skipped: 0 } CRON_SMOKE_REQUESTS=1")
  } else {
    assert.equal(result.status, 1, output)
    assert.match(result.stderr, /Scheduled synchronization failed with HTTP 503: The API returned a non-success response\./)
    assert.equal(result.stdout.trim(), 'CRON_SMOKE_REQUESTS=1')
  }
}

test('synthetic preload verifies real source entrypoint success/failure (not image evidence)', () => {
  for (const scenario of ['success', 'failure']) {
    const result = spawnSync(process.execPath, [
      '--import', new URL('./fixtures/cron-image-preload.mjs', import.meta.url).href,
      fileURLToPath(new URL('./trigger-scheduled-sync.mjs', import.meta.url)),
    ], {
      encoding: 'utf8', timeout: 10_000, maxBuffer: 1024 * 1024,
      env: {
        SCHEDULER_TARGET_URL: 'https://cron-smoke.invalid/api/internal/sync/due-tenants',
        SCHEDULER_SHARED_SECRET: 'synthetic-cron-smoke-secret-not-a-real-credential',
        CRON_SMOKE_SCENARIO: scenario,
      },
    })
    assertDispatchResult(result, scenario)
  }
})

test('runtime stage explicitly packages the cron entrypoint dependency', () => {
  const dockerfile = readFileSync(new URL('../Dockerfile', import.meta.url), 'utf8')
  const runtime = dockerfile.split('FROM node:22-slim AS runtime')[1]
  assert.ok(runtime)
  for (const name of ['trigger-scheduled-sync.mjs', 'scheduled-sync-trigger.mjs']) {
    assert.ok(runtime.includes(`COPY scripts/${name} ./scripts/${name}`), `Missing runtime COPY: ${name}`)
  }
})

// Opt-in locally because Docker is not universally available. Required CI builds
// the real backend/Dockerfile final stage, enables this test, and cannot skip it.
// From backend/: docker build -t hawkview-cron-smoke:ci .
// HAWKVIEW_RUN_CRON_IMAGE_TESTS=1 HAWKVIEW_CRON_TEST_IMAGE=hawkview-cron-smoke:ci node --test scripts/cron-runtime-image.test.mjs
test('final production image runs its own cron entrypoint safely without network', {
  skip: process.env.HAWKVIEW_RUN_CRON_IMAGE_TESTS !== '1'
    ? 'PENDING: enable HAWKVIEW_RUN_CRON_IMAGE_TESTS=1 with a built production image; not image validation'
    : false,
  timeout: 90_000,
}, () => {
  const image = process.env.HAWKVIEW_CRON_TEST_IMAGE
  assert.match(image ?? '', /^hawkview-cron-smoke:[a-zA-Z0-9_.-]+$/)
  const preload = fileURLToPath(new URL('./fixtures/cron-image-preload.mjs', import.meta.url))
  for (const scenario of ['success', 'failure']) {
    const result = spawnSync('docker', [
      'run', '--rm', '--pull=never', '--network=none', '--read-only',
      '--cap-drop=ALL', '--security-opt=no-new-privileges',
      '--mount', `type=bind,source=${preload},target=/cron-image-preload.mjs,readonly`,
      '--env', 'SCHEDULER_TARGET_URL=https://cron-smoke.invalid/api/internal/sync/due-tenants',
      '--env', 'SCHEDULER_SHARED_SECRET=synthetic-cron-smoke-secret-not-a-real-credential',
      '--env', `CRON_SMOKE_SCENARIO=${scenario}`,
      image, 'node', '--import', '/cron-image-preload.mjs', '/app/scripts/trigger-scheduled-sync.mjs',
    ], { encoding: 'utf8', timeout: 40_000, maxBuffer: 1024 * 1024 })
    assertDispatchResult(result, scenario) // Docker/daemon absence FAILS when enabled.
  }
  // Execute the actual operator bundle from this same final image. With no
  // network/config, both help and the default dry-run must exit without writes.
  for (const args of [['--help'], ['--environment', 'synthetic', '--organization', '00000000-0000-0000-0000-000000000001',
    '--tenant', '00000000-0000-0000-0000-000000000002', '--version', '00000000-0000-0000-0000-000000000003']]) {
    const result = spawnSync('docker', ['run', '--rm', '--pull=never', '--network=none', '--read-only',
      '--cap-drop=ALL', '--security-opt=no-new-privileges', image, 'node', '/app/dist/provision-risk-key.js', ...args],
    { encoding:'utf8', timeout:10000, maxBuffer:65536 })
    assert.ifError(result.error); assert.equal(result.signal, null); assert.equal(result.stderr, '')
    const body = JSON.parse(result.stdout)
    assert.equal(result.status, args[0] === '--help' ? 0 : 1)
    assert.equal(body.outcome, args[0] === '--help' ? 'HELP' : 'FAILED')
    if (args[0] !== '--help') assert.equal(body.code, 'CONFIG_UNAVAILABLE')
  }
})
