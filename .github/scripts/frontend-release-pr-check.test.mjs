import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { changedPathsBetween, requiresReleaseStamp } from './frontend-release-pr-check.mjs'

test('backend, documentation, and this gate alone do not require a frontend stamp', () => {
  assert.equal(requiresReleaseStamp([
    'backend/src/tenants/tenant-sync.service.ts',
    'backend/prisma/schema.prisma',
    'docs/sync-reliability-audit-20261021.md',
    'HAWKVIEW_PM.md',
  ]), false)
  assert.equal(requiresReleaseStamp([
    'backend/src/tenants/tenant-sync.service.ts',
    '.github/scripts/backend-quality-tests.mjs',
    '.github/scripts/backend-quality-tests.test.mjs',
  ]), false)
  assert.equal(requiresReleaseStamp([
    '.github/workflows/quality-gates.yml',
    '.github/scripts/frontend-release-pr-check.mjs',
    '.github/scripts/frontend-release-pr-check.test.mjs',
  ]), false)
})

test('frontend, release metadata, and unknown paths still require a stamp', () => {
  for (const path of [
    'lib/config/frontend-release.json',
    'app/(protected)/policies/baselines/page.tsx',
    'components/layout/sidebar.tsx',
    'package.json',
    'scripts/frontend-release.cjs',
    '.github/workflows/deployment-smoke.yml',
    '.github/scripts/unknown-ci-change.mjs',
    'supabase/email-templates/invite.html',
  ]) {
    assert.equal(requiresReleaseStamp(['backend/src/auth/auth.service.ts', path]), true, path)
  }
  assert.equal(requiresReleaseStamp([]), true)
  assert.equal(requiresReleaseStamp(['']), true)
  assert.equal(requiresReleaseStamp(['backend/../lib/config/frontend-release.json']), true)
})

test('diff treats a frontend-to-backend move as a frontend change', (t) => {
  const cwd = mkdtempSync(join(tmpdir(), 'hawkview-release-gate-'))
  t.after(() => rmSync(cwd, { recursive: true, force: true }))
  const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
  git('init', '-q')
  git('config', 'user.name', 'HawkView CI')
  git('config', 'user.email', 'ci@example.invalid')
  mkdirSync(join(cwd, 'app'))
  mkdirSync(join(cwd, 'backend'))
  writeFileSync(join(cwd, 'app', 'example.ts'), 'export const value = 1\n')
  git('add', '.')
  git('commit', '-qm', 'base')
  const baseSha = git('rev-parse', 'HEAD')
  git('mv', 'app/example.ts', 'backend/example.ts')
  git('commit', '-qm', 'move')
  const paths = changedPathsBetween(baseSha, cwd)
  assert.deepEqual(paths, ['app/example.ts', 'backend/example.ts'])
  assert.equal(requiresReleaseStamp(paths), true)
  assert.throws(() => changedPathsBetween('not-a-commit', cwd))
})

test('CLI skips a mismatched stamp only for backend-only changes', (t) => {
  const cwd = mkdtempSync(join(tmpdir(), 'hawkview-release-gate-cli-'))
  t.after(() => rmSync(cwd, { recursive: true, force: true }))
  const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
  git('init', '-q')
  git('config', 'user.name', 'HawkView CI')
  git('config', 'user.email', 'ci@example.invalid')
  git('remote', 'add', 'origin', cwd)
  mkdirSync(join(cwd, 'backend'))
  writeFileSync(join(cwd, 'backend', 'service.ts'), 'export const value = 1\n')
  git('add', '.')
  git('commit', '-qm', 'base')
  const baseSha = git('rev-parse', 'HEAD')
  writeFileSync(join(cwd, 'backend', 'service.ts'), 'export const value = 2\n')
  git('commit', '-qam', 'backend change')

  const script = fileURLToPath(new URL('./frontend-release-pr-check.mjs', import.meta.url))
  const release = JSON.parse(readFileSync(new URL('../../lib/config/frontend-release.json', import.meta.url), 'utf8'))
  assert.equal(Number.isSafeInteger(release.pullRequest), true)
  const env = {
    ...process.env,
    HAWKVIEW_BASE_SHA: baseSha,
    HAWKVIEW_PULL_REQUEST_NUMBER: String(release.pullRequest + 1),
  }
  const run = () => spawnSync(process.execPath, [script], { cwd, env, encoding: 'utf8' })
  const backend = run()
  assert.equal(backend.status, 0, backend.stderr)
  assert.match(backend.stdout, /frontend release stamp not required/)

  mkdirSync(join(cwd, 'app'))
  writeFileSync(join(cwd, 'app', 'page.tsx'), 'export default function Page() { return null }\n')
  git('add', '.')
  git('commit', '-qm', 'frontend change')
  const frontend = run()
  assert.equal(frontend.status, 1)
  assert.match(frontend.stderr, /Release PR must equal actual PR/)
  env.HAWKVIEW_PULL_REQUEST_NUMBER = String(release.pullRequest)
  const stampedFrontend = run()
  assert.equal(stampedFrontend.status, 0, stampedFrontend.stderr)
  assert.match(stampedFrontend.stdout, /Frontend release PR number matches/)
})
