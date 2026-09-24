import assert from 'node:assert/strict'
import test from 'node:test'
import { createRequire } from 'node:module'
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { FRONTEND_RELEASE, parseFrontendRelease } from './frontend-release.ts'

const require = createRequire(import.meta.url)
const { validateRelease, parsePullRequest, run } = require('../../scripts/frontend-release.cjs')

test('release labels distinguish a stamped PR from unstamped local work', () => {
  assert.equal(parseFrontendRelease({ phase: 1, pullRequest: 296 }).label, '1.296')
  assert.equal(parseFrontendRelease({ phase: 2, pullRequest: null }).label, '2.local')
  assert.ok(Object.isFrozen(FRONTEND_RELEASE))
  assert.notEqual(FRONTEND_RELEASE.label, 'Unavailable')
})

test('browser and CLI reject malformed release metadata consistently', () => {
  for (const value of [null, [], {}, { phase: 0, pullRequest: 1 }, { phase: 1.1, pullRequest: 1 },
    { phase: 1, pullRequest: '296' }, { phase: 1, pullRequest: 0 }, { phase: 1, pullRequest: -1 },
    { phase: 1, pullRequest: Number.MAX_SAFE_INTEGER + 1 }, { phase: 1, pullRequest: 2, extra: true }]) {
    assert.equal(parseFrontendRelease(value).label, 'Unavailable')
    assert.throws(() => validateRelease(value))
  }
})

test('PR arguments accept only canonical positive safe integers', () => {
  assert.equal(parsePullRequest('296'), 296)
  for (const value of [undefined, '', '0', '-1', '1.2', '1e3', ' 296', '0296', '9007199254740992', '$(echo bad)']) {
    assert.throws(() => parsePullRequest(value))
  }
})

test('explicit stamp preserves phase; read-only check rejects null and mismatched PRs', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'hawkview-release-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const file = join(root, 'release.json')
  writeFileSync(file, JSON.stringify({ phase: 2, pullRequest: null }))
  const before = readFileSync(file, 'utf8')
  assert.throws(() => run(['check'], file, { HAWKVIEW_PULL_REQUEST_NUMBER: '296' }))
  assert.equal(readFileSync(file, 'utf8'), before)
  run(['stamp', '296'], file)
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { phase: 2, pullRequest: 296 })
  const stamped = readFileSync(file, 'utf8')
  run(['check'], file, { HAWKVIEW_PULL_REQUEST_NUMBER: '296' })
  assert.throws(() => run(['check'], file, { HAWKVIEW_PULL_REQUEST_NUMBER: '297' }))
  assert.throws(() => run(['check'], file, {}))
  assert.throws(() => run(['stamp', '1e3'], file))
  assert.throws(() => run(['unknown'], file))
  assert.equal(readFileSync(file, 'utf8'), stamped)
})
