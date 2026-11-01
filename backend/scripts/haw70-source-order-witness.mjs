import { spawn } from 'node:child_process'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const backendDirectory = fileURLToPath(new URL('../', import.meta.url))
export const witnessName = 'physical tenant health history: committed evidence outranks an earlier request clock'
const witnessFile = 'src/tenants/tenant-directory.database-integration.test.ts'

function requireFlag(environment, name, expected) {
  if (environment[name] !== expected) throw new Error('HAW70_PHYSICAL_WITNESS_NOT_REGISTERED')
}

// This runner is deliberately absent from the normal quality plan. Its
// fail-first witness may run only on the registered disposable PostgreSQL job.
export function assertRegisteredWitnessEnvironment(environment = process.env) {
  for (const [name, expected] of [
    ['HAWKVIEW_RUN_DATABASE_INTEGRATION_TESTS', '1'],
    ['HAWKVIEW_HAW70_SOURCE_ORDER_PHYSICAL_FAIL_FIRST', '1'],
    ['HAWKVIEW_CI_DISPOSABLE_POSTGRES', '1'],
    ['CI', 'true'],
    ['GITHUB_ACTIONS', 'true'],
    ['RUNNER_ENVIRONMENT', 'github-hosted'],
    ['GITHUB_WORKFLOW', 'Required quality gates'],
    ['GITHUB_JOB', 'backend-quality'],
  ]) requireFlag(environment, name, expected)
  if (environment.DATABASE_URL !==
    'postgresql://hawkview_ci:hawkview_ci@127.0.0.1:5432/hawkview_ci') {
    throw new Error('HAW70_PHYSICAL_WITNESS_NOT_REGISTERED')
  }
}

function summary(tail) {
  const field = (name) => {
    const matches = [...tail.matchAll(new RegExp('^# ' + name + ' (\\d+)$', 'gm'))]
    return matches.length === 1 ? Number(matches[0][1]) : null
  }
  const tests = field('tests'), pass = field('pass'), fail = field('fail')
  const skipped = field('skipped'), cancelled = field('cancelled'), todo = field('todo')
  if ([tests, pass, fail, skipped, cancelled, todo].some(value => value === null)) return null
  return { tests, pass, fail, skipped, cancelled, todo,
    ran: tests - skipped - cancelled - todo }
}

export function assertOnePassingWitness(outcome) {
  const result = outcome.summary
  if (outcome.timedOut || outcome.code !== 0 || result?.ran !== 1
    || result.pass !== 1 || result.fail !== 0 || result.todo !== 0
    || result.cancelled !== 0) {
    throw new Error('HAW70_PHYSICAL_WITNESS_FAILED')
  }
}

// The parent owns the hard deadline. A Node test timeout or Promise.race
// cannot cancel a blocked Prisma operation or its fixture cleanup.
export function runBoundedWitnessProcess({
  args, cwd = backendDirectory, environment = process.env, node = process.execPath,
  deadlineMs = 45_000, graceMs = 1_000, stdout = process.stdout, stderr = process.stderr,
} = {}) {
  if (process.platform === 'win32' || !Array.isArray(args) || args.length === 0
    || !Number.isSafeInteger(deadlineMs) || deadlineMs <= 0
    || !Number.isSafeInteger(graceMs) || graceMs <= 0) {
    throw new Error('HAW70_WITNESS_RUNNER_INVALID')
  }
  return new Promise(resolveResult => {
    let child
    try {
      child = spawn(node, args, {
        cwd, env: environment, detached: true, shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch {
      resolveResult({ code: 1, signal: null, timedOut: false, summary: null })
      return
    }
    let tail = '', timedOut = false, finished = false
    let deadlineTimer, forceTimer, fallbackTimer
    const groupSignal = (signal) => {
      if (!child.pid) return
      try { process.kill(-child.pid, signal) } catch (error) {
        // A failed group signal must still fail this witness and let the
        // registered CI job's outer timeout retain the final cleanup bound.
        if (error?.code !== 'ESRCH') timedOut = true
      }
    }
    const finish = (code, signal) => {
      if (finished) return
      finished = true
      clearTimeout(deadlineTimer)
      clearTimeout(forceTimer)
      clearTimeout(fallbackTimer)
      process.off('SIGINT', onInterrupt)
      process.off('SIGTERM', onTerminate)
      child.stdout?.destroy()
      child.stderr?.destroy()
      resolveResult({ code: code ?? 1, signal: signal ?? null, timedOut, summary: summary(tail) })
    }
    const forceLater = () => {
      if (forceTimer) return
      forceTimer = setTimeout(() => {
        groupSignal('SIGKILL')
        fallbackTimer = setTimeout(() => finish(1, 'SIGKILL'), 1_000)
      }, graceMs)
    }
    const interrupt = (signal) => {
      groupSignal(signal)
      forceLater()
    }
    const onInterrupt = () => interrupt('SIGINT')
    const onTerminate = () => interrupt('SIGTERM')
    process.on('SIGINT', onInterrupt)
    process.on('SIGTERM', onTerminate)
    child.stdout?.on('data', (chunk) => {
      stdout.write(chunk)
      tail = (tail + chunk.toString('utf8')).slice(-65_536)
    })
    child.stderr?.on('data', (chunk) => stderr.write(chunk))
    child.once('error', () => finish(1, null))
    child.once('close', (code, signal) => finish(code, signal))
    deadlineTimer = setTimeout(() => {
      timedOut = true
      groupSignal('SIGTERM')
      forceLater()
    }, deadlineMs)
  })
}

export async function runSourceOrderWitness(options = {}) {
  assertRegisteredWitnessEnvironment(options.environment)
  const args = [
    '--import', 'tsx', '--test', '--test-reporter=tap',
    '--test-name-pattern=^' + witnessName + '$', witnessFile,
  ]
  const outcome = await runBoundedWitnessProcess({
    ...options,
    args,
    // The physical test has no node:test timeout. Only this deadline-owned
    // child may opt it in; setting the CI markers alone still skips it.
    environment: {
      ...(options.environment ?? process.env),
      HAWKVIEW_HAW70_BOUNDED_SOURCE_ORDER_CHILD: '1',
    },
  })
  assertOnePassingWitness(outcome)
  return outcome
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await runSourceOrderWitness()
  } catch {
    // Do not echo connection settings or arbitrary child exception text.
    console.error('HAW-70 physical source-order witness failed or was not registered.')
    process.exitCode = 1
  }
}
