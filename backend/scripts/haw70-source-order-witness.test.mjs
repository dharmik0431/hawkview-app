import assert from 'node:assert/strict'
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import {
  assertOnePassingWitness,
  assertRegisteredWitnessEnvironment,
  runBoundedWitnessProcess,
  runSourceOrderWitness,
} from './haw70-source-order-witness.mjs'

const sink = { write() {} }
const registered = {
  HAWKVIEW_RUN_DATABASE_INTEGRATION_TESTS: '1',
  HAWKVIEW_HAW70_SOURCE_ORDER_PHYSICAL_FAIL_FIRST: '1',
  HAWKVIEW_CI_DISPOSABLE_POSTGRES: '1',
  CI: 'true', GITHUB_ACTIONS: 'true',
  RUNNER_ENVIRONMENT: 'github-hosted',
  GITHUB_WORKFLOW: 'Required quality gates',
  GITHUB_JOB: 'backend-quality',
  DATABASE_URL: 'postgresql://hawkview_ci:hawkview_ci@127.0.0.1:5432/hawkview_ci',
}

test('HAW-70 witness refuses any missing hosted disposable-database marker', () => {
  assert.doesNotThrow(() => assertRegisteredWitnessEnvironment(registered))
  for (const key of Object.keys(registered)) {
    const altered = { ...registered }
    delete altered[key]
    assert.throws(() => assertRegisteredWitnessEnvironment(altered),
      /HAW70_PHYSICAL_WITNESS_NOT_REGISTERED/, key)
  }
  assert.throws(() => assertRegisteredWitnessEnvironment({
    ...registered, DATABASE_URL: 'postgresql://hawkview_ci:hawkview_ci@localhost:5432/hawkview_ci',
  }), /HAW70_PHYSICAL_WITNESS_NOT_REGISTERED/)
})

test('HAW-70 witness cannot start from an unregistered local environment', async () => {
  await assert.rejects(runSourceOrderWitness({ environment: {} }),
    /HAW70_PHYSICAL_WITNESS_NOT_REGISTERED/)
})

test('only the bounded launcher marks its physical child', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hawkview-haw70-child-marker-'))
  const fakeNode = join(directory, 'witness-node')
  try {
    await writeFile(fakeNode, `#!/bin/sh
test "$HAWKVIEW_HAW70_BOUNDED_SOURCE_ORDER_CHILD" = 1 || exit 9
printf '%s\\n' '# tests 1' '# pass 1' '# fail 0' '# cancelled 0' '# skipped 0' '# todo 0'
`)
    await chmod(fakeNode, 0o700)
    const outcome = await runSourceOrderWitness({
      environment: registered, node: fakeNode, stdout: sink, stderr: sink,
    })
    assert.equal(outcome.code, 0)
    assert.equal(registered.HAWKVIEW_HAW70_BOUNDED_SOURCE_ORDER_CHILD, undefined,
      'the parent environment must remain unmarked')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('bounded runner requires a complete TAP footer to prove one case ran', async () => {
  const complete = await runBoundedWitnessProcess({
    args: ['-e', "console.log('# tests 8\\n# pass 1\\n# fail 0\\n# cancelled 0\\n# skipped 7\\n# todo 0')"],
    deadlineMs: 5_000, stdout: sink, stderr: sink,
  })
  assert.equal(complete.code, 0)
  assert.equal(complete.timedOut, false)
  assert.deepEqual(complete.summary, {
    tests: 8, pass: 1, fail: 0, skipped: 7, cancelled: 0, todo: 0, ran: 1,
  })
  assert.doesNotThrow(() => assertOnePassingWitness(complete))
  const absent = await runBoundedWitnessProcess({
    args: ['-e', "console.log('# tests 8\\n# pass 0\\n# fail 0\\n# skipped 8')"],
    deadlineMs: 5_000, stdout: sink, stderr: sink,
  })
  assert.equal(absent.summary, null)
  assert.throws(() => assertOnePassingWitness(absent), /HAW70_PHYSICAL_WITNESS_FAILED/)
  const noMatch = await runBoundedWitnessProcess({
    args: ['-e', "console.log('# tests 8\\n# pass 0\\n# fail 0\\n# cancelled 0\\n# skipped 8\\n# todo 0')"],
    deadlineMs: 5_000, stdout: sink, stderr: sink,
  })
  assert.equal(noMatch.summary?.ran, 0)
  assert.throws(() => assertOnePassingWitness(noMatch), /HAW70_PHYSICAL_WITNESS_FAILED/)
  const failed = await runBoundedWitnessProcess({
    args: ['-e', "process.exitCode = 7; console.log('# tests 1\\n# pass 1\\n# fail 0\\n# cancelled 0\\n# skipped 0\\n# todo 0')"],
    deadlineMs: 5_000, stdout: sink, stderr: sink,
  })
  assert.equal(failed.code, 7)
  assert.throws(() => assertOnePassingWitness(failed), /HAW70_PHYSICAL_WITNESS_FAILED/)
  const todo = { ...complete, summary: { ...complete.summary, pass: 0, todo: 1 } }
  assert.throws(() => assertOnePassingWitness(todo), /HAW70_PHYSICAL_WITNESS_FAILED/)
})

test('deadline terminates the entire witness process group', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hawkview-haw70-witness-'))
  const marker = join(directory, 'orphan-marker')
  try {
    const output = []
    const grandchild = `setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'survived'), 2000); console.log('grandchild-armed')`
    const child = `const worker = require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(grandchild)}], { stdio: 'inherit' }); console.log('grandchild:' + worker.pid); setInterval(() => {}, 1000)`
    const result = await runBoundedWitnessProcess({
      args: ['-e', child], deadlineMs: 1_000, graceMs: 50,
      stdout: { write(chunk) { output.push(chunk.toString()) } }, stderr: sink,
    })
    assert.equal(result.timedOut, true)
    assert.match(output.join(''), /grandchild:\d+/, 'the worker existed before the group deadline')
    assert.match(output.join(''), /grandchild-armed/, 'the worker armed its delayed write')
    await delay(2_200)
    await assert.rejects(readFile(marker), { code: 'ENOENT' })
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
