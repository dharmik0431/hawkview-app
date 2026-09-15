import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { setImmediate as nextTurn } from 'node:timers/promises';
import test from 'node:test';
import {
  backendDirectory, databaseTests, discoverTests, normalizeTestPath,
  planTests, reviewedBlob, runPhase, runPlan, syntheticExceptions,
} from './backend-quality-tests.mjs';

const fixtureEntries = () => [
  ...databaseTests.map(path => ({ path, source: 'assertDisposableTestDatabase()' })),
  { path: 'src/ordinary fixture.test.ts', source: 'test()' },
];
const paths = entries => entries.map(entry => entry.path);

test('partition is the complete disjoint discovery, including the nonstandard real-PG file', () => {
  const entries = fixtureEntries();
  const plan = planTests(entries, paths(entries).reverse());
  assert.equal(plan.database.length, 26);
  assert.ok(plan.database.includes('src/tenants/sign-in-provisioning.test.ts'));
  assert.deepEqual([...plan.ordinary, ...plan.database].sort(), paths(entries).sort());
  assert.equal(new Set([...plan.ordinary, ...plan.database]).size, entries.length);
});

test('real repository discovery and every content-pinned synthetic exemption remain classified', () => {
  const entries = discoverTests();
  const plan = planTests(entries, paths(entries));
  for (const [path, exemption] of Object.entries(syntheticExceptions)) {
    const source = entries.find(entry => entry.path === path)?.source;
    assert.equal(typeof source, 'string', path);
    assert.ok(exemption.reason.length > 20);
    assert.equal(reviewedBlob(source), exemption.blob, path);
    assert.ok(plan.ordinary.includes(path), path);
  }
});

test('missing, extra, duplicate and unclassified suites fail before launch', () => {
  const entries = fixtureEntries();
  assert.throws(() => planTests(entries, paths(entries).slice(1)), /discovery/);
  assert.throws(() => planTests(entries, [...paths(entries), paths(entries)[0]]), /Duplicate/);
  assert.throws(() => planTests([...entries, entries[0]], paths(entries)), /Duplicate/);
  const missing = entries.slice(1);
  assert.throws(() => planTests(missing, paths(missing)), /Missing database suite/);
  const added = [...entries, { path: 'src/new.database-integration.test.ts', source: 'test()' }];
  assert.throws(() => planTests(added, paths(added)), /Unclassified database suite/);
  assert.throws(() => planTests(entries.slice(0, -1), paths(entries.slice(0, -1))), /nonempty/);
});

test('future nonstandard DB tests and changed reviewed mocks require explicit classification', () => {
  for (const marker of [
    'HAWKVIEW_RUN_DATABASE_INTEGRATION_TESTS', 'DATABASE_URL', 'assertDisposableNativeAlertDatabase()',
    'assertDisposableTestDatabase()', 'new pg.Client()', 'new Pool()',
    'new PrismaService()', 'new PrismaClient()', 'prisma.$connect()',
  ]) {
    const entries = [...fixtureEntries(), { path: 'src/new ordinary.test.ts', source: marker }];
    assert.throws(() => planTests(entries, paths(entries)), /database-looking/);
  }
  for (const path of Object.keys(syntheticExceptions)) {
    const entries = [...fixtureEntries(), { path, source: 'DATABASE_URL; new pg.Client()' }];
    assert.throws(() => planTests(entries, paths(entries)), /exemption needs review/);
  }
});

test('unsafe paths are rejected and spaces/backslashes are passed as a single normalized path', () => {
  for (const path of ['/src/a.test.ts', 'C:\\src\\a.test.ts', '../src/a.test.ts',
    'src/../a.test.ts', 'src//a.test.ts', 'src/./a.test.ts', 'src/a\n.test.ts', '--test-name-pattern=x']) {
    assert.throws(() => normalizeTestPath(path), /Unsafe/);
  }
  assert.equal(normalizeTestPath('src\\space name.test.ts'), 'src/space name.test.ts');
});

function fakeProcesses() {
  const runtime = new EventEmitter();
  const calls = [];
  const spawnImpl = (executable, args, options) => {
    const child = new EventEmitter();
    child.signals = [];
    child.kill = signal => { child.signals.push(signal); return true; };
    calls.push({ executable, args, options, child });
    return child;
  };
  return { runtime, spawnImpl, calls };
}

test('the DB child cannot launch until ordinary exit AND close; DB files alone are serialized', async () => {
  const fake = fakeProcesses();
  const plan = planTests(fixtureEntries(), paths(fixtureEntries()));
  const completion = runPlan(plan, fake);
  assert.equal(fake.calls.length, 1);
  fake.calls[0].child.emit('exit', 0, null);
  await nextTurn();
  assert.equal(fake.calls.length, 1, 'ordinary cleanup/stdio still active');
  fake.calls[0].child.emit('close', 0, null);
  await nextTurn();
  assert.equal(fake.calls.length, 2);
  assert.deepEqual(fake.calls[0].args, ['--import', 'tsx', '--test', ...plan.ordinary]);
  assert.deepEqual(fake.calls[1].args, ['--import', 'tsx', '--test', '--test-concurrency=1', ...plan.database]);
  for (const call of fake.calls) {
    assert.equal(call.executable, process.execPath);
    assert.deepEqual(call.options, { cwd: backendDirectory, stdio: 'inherit', shell: false });
  }
  fake.calls[1].child.emit('close', 17, null);
  assert.deepEqual(await completion, { code: 17, signal: null });
  assert.equal(fake.runtime.listenerCount('SIGTERM'), 0);
});

test('first-phase nonzero, spawn failure, and signal prevent all database work', async () => {
  for (const scenario of ['failure', 'spawn', 'signal']) {
    const fake = fakeProcesses();
    const completion = runPlan({ ordinary: ['src/one.test.ts'], database: databaseTests }, fake);
    if (scenario === 'spawn') fake.calls[0].child.emit('error', new Error('synthetic'));
    fake.calls[0].child.emit('close', scenario === 'failure' ? 23 : null, scenario === 'signal' ? 'SIGTERM' : null);
    const outcome = await completion;
    assert.equal(fake.calls.length, 1);
    assert.deepEqual(outcome, { code: scenario === 'failure' ? 23 : 1, signal: scenario === 'signal' ? 'SIGTERM' : null });
  }
  const outcome = await runPhase([], { spawnImpl() { throw new Error('synthetic'); } });
  assert.deepEqual(outcome, { code: 1, signal: null });
});

test('parent termination forwards to the active child and cannot become a successful run', async () => {
  for (const signal of ['SIGINT', 'SIGTERM']) {
    const fake = fakeProcesses();
    const completion = runPlan({ ordinary: ['src/one.test.ts'], database: databaseTests }, fake);
    fake.runtime.emit(signal);
    assert.deepEqual(fake.calls[0].child.signals, [signal]);
    fake.calls[0].child.emit('close', 0, null);
    assert.deepEqual(await completion, { code: 0, signal });
    assert.equal(fake.calls.length, 1);
  }
});

test('real Node workers overlap under the negative control but serialize full fixture cleanup at concurrency=1', { timeout: 20000 }, t => {
  const root = resolve(process.env.HV_VERIFY_ROOT ?? tmpdir());
  const directory = mkdtempSync(join(root, 'backend-phase-'));
  t.after(() => {
    assert.equal(dirname(directory), root, 'cleanup must stay inside the temporary root');
    rmSync(directory, { recursive: true, force: true });
  });
  const files = ['a', 'b'].map(name => {
    const path = join(directory, `${name}.test.mjs`);
    writeFileSync(path, `
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { existsSync, openSync, closeSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';
const directory = ${JSON.stringify(directory)};
const name = ${JSON.stringify(name)};
const lock = join(directory, 'fixture.lock');
let owner = false;
async function barrier(suffix) {
  const deadline = Date.now() + 5000;
  while (!['a', 'b'].every(n => existsSync(join(directory, n + suffix)))) {
    if (Date.now() >= deadline) throw new Error('fixture barrier timed out');
    await pause(5);
  }
}
test('complete fixture lifetime', async () => {
  if (process.env.HV_HARNESS_NEGATIVE_CONTROL === '1') {
    writeFileSync(join(directory, name + '.ready'), 'ready');
    await barrier('.ready');
  }
  try { closeSync(openSync(lock, 'wx')); owner = true; } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
  if (process.env.HV_HARNESS_NEGATIVE_CONTROL === '1') {
    writeFileSync(join(directory, name + '.attempted'), 'attempted');
    await barrier('.attempted');
  }
  assert.equal(owner, true, 'fixture lifecycle overlapped another worker');
});
after(async () => {
  await pause(15);
  if (owner) unlinkSync(lock);
  writeFileSync(join(directory, name + '.cleaned'), 'cleaned');
});
`);
    return path;
  });
  // No PG connections, provider calls, or fixture assertions are changed by this control.
  // These are independent runner controls, not children of the enclosing test runner.
  // Keep NODE_OPTIONS and every other safety/environment setting unchanged.
  const runnerEnvironment = { ...process.env };
  // Explicit undefined also masks this key when a safety wrapper merges parent env first.
  runnerEnvironment.NODE_TEST_CONTEXT = undefined;
  const negative = spawnSync(process.execPath, ['--test', '--test-concurrency=2', ...files], {
    env: { ...runnerEnvironment, HV_HARNESS_NEGATIVE_CONTROL: '1' }, encoding: 'utf8', timeout: 10000,
  });
  assert.equal(negative.error, undefined);
  assert.equal(negative.signal, null);
  assert.equal(negative.status, 1);
  assert.match(negative.stdout, /fixture lifecycle overlapped another worker/);
  assert.match(negative.stdout, /# tests 2\b/);
  assert.match(negative.stdout, /# fail 1\b/);
  assert.doesNotMatch(negative.stdout, /fixture barrier timed out/);
  assert.equal(existsSync(join(directory, 'fixture.lock')), false);
  const serial = spawnSync(process.execPath, ['--test', '--test-concurrency=1', ...files], {
    env: { ...runnerEnvironment, HV_HARNESS_NEGATIVE_CONTROL: '0' }, encoding: 'utf8', timeout: 10000,
  });
  assert.equal(serial.error, undefined);
  assert.equal(serial.signal, null);
  assert.equal(serial.status, 0);
  assert.match(serial.stdout, /# tests 2\b/);
  assert.match(serial.stdout, /# pass 2\b/);
  assert.match(serial.stdout, /# fail 0\b/);
  assert.equal(existsSync(join(directory, 'fixture.lock')), false);
  for (const name of ['a', 'b']) assert.ok(existsSync(join(directory, `${name}.cleaned`)));
});
