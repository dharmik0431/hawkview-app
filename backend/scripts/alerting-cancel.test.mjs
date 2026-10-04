import assert from 'node:assert/strict'
import test from 'node:test'
import { build } from 'esbuild'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const A = '11111111-1111-4111-8111-111111111111'
const B = '22222222-2222-4222-8222-222222222222'
const cutoff = '2026-10-01T12:00:00.000Z'
const before = '2026-10-01T11:59:59.999Z'
const args = ['--created-before', cutoff, '--by', 'test-operator', '--because', 'synthetic cancellation']

// Bundle the real CLI, replacing only the two database imports. The fake evaluates the emitted
// SQL's bound scope/cutoff and terminal list; it is not physical PostgreSQL evidence. This tests
// actual entrypoint wiring without importing a CLI that could instantiate a real database client.
const fake = `
export class PrismaPg { constructor() { console.log('ADAPTER_CONSTRUCTED'); } }
export class PrismaClient {
 constructor() {
   console.log('CLIENT_CONSTRUCTED');
   if (process.env.HAW41_FORBID_CONNECTION === '1') throw Error('CONNECTION_FORBIDDEN');
 }
 async $queryRawUnsafe(sql, ...params) {
   console.log('QUERY:' + JSON.stringify({sql, params}));
   const terminal = [...sql.match(/state NOT IN \\(([^)]+)\\)/)[1].matchAll(/'([^']+)'/g)].map(x => x[1]);
   const cutoffIndex = Number(sql.match(/created_at < \\$(\\d+)::timestamptz/)[1]) - 1;
   const prefixMatch = sql.match(/message_id LIKE \\$(\\d+) \\|\\| '%'/);
   const prefix = prefixMatch ? params[Number(prefixMatch[1]) - 1] : null;
   if (prefix && /[%_\\\\]/.test(prefix)) throw Error('UNSAFE_PATTERN_REACHED_QUERY');
   return JSON.parse(process.env.HAW41_ROWS || '[]').filter(row =>
     !terminal.includes(row.state_before) && Date.parse(row.created_at) < Date.parse(params[cutoffIndex]) &&
     (prefix === null || row.message_id.startsWith(prefix)));
 }
 async $disconnect() { console.log('DISCONNECTED'); }
}
`

test('cancellation CLI scope, preview and apply regressions (synthetic transport)', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'haw41-cli-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const outfile = join(dir, 'cancel.cjs')
  const intercepted = new Set()
  await build({
    entryPoints: [fileURLToPath(new URL('./alerting-cancel.mts', import.meta.url))],
    outfile, bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent',
    plugins: [{ name: 'forbid-real-database', setup(builder) {
      builder.onResolve({ filter: /^(?:@prisma\/adapter-pg|\.\.\/src\/generated\/prisma\/client\.js)$/ }, item => {
        intercepted.add(item.path)
        return { path: 'database', namespace: 'synthetic' }
      })
      builder.onLoad({ filter: /.*/, namespace: 'synthetic' }, () => ({ contents: fake, loader: 'js' }))
    } }],
  })
  assert.equal(intercepted.size, 2, 'both database imports must be replaced')
  function run(extra, rows = [], forbid = false) {
    const result = spawnSync(process.execPath, [outfile, ...extra], {
      // Do not pass production environment or loader flags to this synthetic child.
      env: { DATABASE_URL: 'synthetic-not-a-database', HAW41_ROWS: JSON.stringify(rows), HAW41_FORBID_CONNECTION: forbid ? '1' : '0' },
      encoding: 'utf8', timeout: 5000,
    })
    assert.equal(result.error, undefined)
    return { status: result.status, output: result.stdout + result.stderr,
      queries: result.stdout.split('\n').filter(s => s.startsWith('QUERY:')).map(s => JSON.parse(s.slice(6))) }
  }
  function row(org, state, id = state, createdAt = before, attempts = 0, claimed = false) {
    return { message_id: `incident/${org}|${id}`, state_before: state, created_at: createdAt, attempts_made: attempts, was_claimed: claimed }
  }

  await t.test('invalid organization values fail before adapter or client construction', () => {
    for (const org of ['%', '_', A + '%', A + '_', 'org-1', '', ' ' + A, A + ' ', A.slice(1), A.replace(/-/g, ''), '--everything']) {
      const r = run(['--organisation', org, ...args], [], true)
      assert.equal(r.status, 2, org)
      assert.doesNotMatch(r.output, /ADAPTER_CONSTRUCTED|CLIENT_CONSTRUCTED|CONNECTION_FORBIDDEN/, org)
      assert.equal(r.queries.length, 0)
    }
  })
  await t.test('missing, repeated, unknown and conflicting options cannot broaden scope', () => {
    for (const extra of [args, ['--organisation', ...args], [...args, '--organisation'],
      ['--organisation', A, '--everything', ...args], ['--organisation', A, '--organisation', B, ...args],
      ['--everything', '--organisation', ...args], ['--everything', '--typo', ...args],
      ['--everything', ...args, '--created-before'], ['--everything', ...args, '--apply', '--apply']]) {
      const r = run(extra, [], true)
      assert.equal(r.status, 2, JSON.stringify(extra))
      assert.doesNotMatch(r.output, /ADAPTER_CONSTRUCTED|CLIENT_CONSTRUCTED|CONNECTION_FORBIDDEN/)
    }
  })
  await t.test('invalid cutoff and blank attribution fail without connecting', () => {
    for (const extra of [
      ['--everything', '--created-before', 'not-a-date', '--by', 'op', '--because', 'test'],
      ['--everything', '--created-before', cutoff, '--by', ' ', '--because', 'test'],
      ['--everything', '--created-before', cutoff, '--by', 'op', '--because', ' '],
    ]) {
      const r = run(extra, [], true)
      assert.equal(r.status, 2)
      assert.doesNotMatch(r.output, /ADAPTER_CONSTRUCTED|CLIENT_CONSTRUCTED|CONNECTION_FORBIDDEN/)
    }
  })
  await t.test('all terminal states, including WITHDRAWN, are excluded from preview and apply', () => {
    const terminals = ['SENT', 'EXHAUSTED', 'GAVE_UP', 'CANCELLED', 'WITHDRAWN']
    const rows = [...terminals.map(s => row(A, s)), row(A, 'READY'), row(A, 'CLAIMED', 'CLAIMED', before, 0, true)]
    const r = run(['--organisation', A, ...args, '--apply'], rows)
    assert.equal(r.status, 0)
    assert.match(r.output, /WOULD STOP 2 job\(s\)/)
    assert.match(r.output, /STOPPED 2 job\(s\)/)
    assert.equal(r.queries.length, 2)
    for (const query of r.queries) {
      const states = [...query.sql.match(/state NOT IN \(([^)]+)\)/)[1].matchAll(/'([^']+)'/g)].map(m => m[1]).sort()
      assert.deepEqual(states, [...terminals].sort())
    }
    for (const state of terminals) assert.doesNotMatch(r.output, new RegExp(`incident/${A}\\|${state} `))
  })
  await t.test('tenant boundary and strict cutoff preserve live claimed and attempted jobs', () => {
    const rows = [row(A, 'READY', 'fresh'), row(A, 'READY', 'attempted', before, 1),
      row(A, 'CLAIMED', 'claimed', before, 0, true), row(B, 'READY'),
      row(A, 'READY', 'boundary', cutoff), row(A, 'READY', 'future', '2026-10-01T12:00:00.001Z')]
    const r = run(['--organisation', A, ...args, '--apply'], rows)
    assert.equal(r.status, 0)
    assert.match(r.output, /WOULD STOP 3 job\(s\)/)
    assert.match(r.output, /STOPPED 3 job\(s\)/)
    assert.match(r.output, /stopped before any attempt : 1/)
    assert.match(r.output, /MAY ALREADY HAVE GONE      : 2/)
    assert.doesNotMatch(r.output, new RegExp(`incident/${B}\\|READY `))
    assert.deepEqual(r.queries[0].params, [cutoff, `incident/${A}|`])
    assert.deepEqual(r.queries[1].params.slice(1), ['test-operator', 'synthetic cancellation', cutoff, `incident/${A}|`])
    assert.match(r.queries[1].sql, /FOR UPDATE/)
    assert.match(r.queries[1].sql, /RETURNING j.message_id, t.state_before, t.attempts_made/)
    assert.match(r.output, /DISCONNECTED/)
  })
  await t.test('uppercase UUID canonicalizes to the stored lowercase scope', () => {
    const org = 'abcdefab-abcd-4abc-8abc-abcdefabcdef'
    const r = run(['--organisation', org.toUpperCase(), ...args], [row(org, 'READY')])
    assert.equal(r.status, 0)
    assert.match(r.output, /WOULD STOP 1 job\(s\)/)
    assert.deepEqual(r.queries[0].params, [cutoff, `incident/${org}|`])
  })
  await t.test('everything is explicit and preview-only never issues an update', () => {
    const r = run(['--everything', ...args], [row(A, 'READY'), row(B, 'READY')])
    assert.equal(r.status, 0)
    assert.match(r.output, /WOULD STOP 2 job\(s\)/)
    assert.match(r.output, /PREVIEW ONLY/)
    assert.equal(r.queries.length, 1)
    assert.deepEqual(r.queries[0].params, [cutoff])
    assert.doesNotMatch(r.queries[0].sql, /UPDATE|FOR UPDATE|LIKE/)
    const applied = run(['--everything', ...args, '--apply'], [row(A, 'READY'), row(B, 'READY')])
    assert.equal(applied.status, 0)
    assert.match(applied.output, /STOPPED 2 job\(s\)/)
    assert.equal(applied.queries.length, 2)
    assert.equal(applied.queries[1].params.length, 4)
    assert.doesNotMatch(applied.queries[1].sql, /LIKE/)
  })
  await t.test('only terminal rows produce no apply and help does not construct clients', () => {
    const r = run(['--everything', ...args, '--apply'], [row(A, 'WITHDRAWN')])
    assert.equal(r.status, 0)
    assert.match(r.output, /WOULD STOP 0 job\(s\)/)
    assert.match(r.output, /Nothing to stop/)
    assert.equal(r.queries.length, 1)
    const help = run(['--help'], [], true)
    assert.equal(help.status, 0)
    assert.doesNotMatch(help.output, /CONSTRUCTED|CONNECTION_FORBIDDEN/)
  })
})
