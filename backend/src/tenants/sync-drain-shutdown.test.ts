import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

test('shell exec forwards SIGTERM; Nest waits for tracked SYNC work before Prisma disconnect', async t => {
  const childPath = fileURLToPath(new URL('./sync-drain-shutdown-child.ts', import.meta.url))
  const child = spawn('sh', ['-c', 'exec "$1" --import tsx "$2"', 'sync-drain', process.execPath, childPath], {
    cwd: fileURLToPath(new URL('../../', import.meta.url)), stdio: ['pipe', 'pipe', 'pipe'],
  })
  t.after(() => { if (child.exitCode === null) child.kill('SIGKILL') })
  let output = '', errors = ''
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => { output += chunk })
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => { errors += chunk })
  const exited = once(child, 'exit')
  const until = (value: string) => new Promise<void>((resolve, reject) => {
    if (output.includes(value)) return resolve()
    const timer = setTimeout(() => { cleanup(); reject(new Error(`Missing ${value}: ${output}\n${errors}`)) }, 12_000)
    const check = () => { if (output.includes(value)) { cleanup(); resolve() } }
    const cleanup = () => { clearTimeout(timer); child.stdout.off('data', check) }
    child.stdout.on('data', check)
  })
  await until('READY:')
  assert.ok(output.includes(`READY:${child.pid}\n`), 'sh was replaced by the Node child with the same PID')
  assert.equal(child.kill('SIGTERM'), true)
  await until('sync_shutdown_drain_started')
  assert.ok(!output.includes('FAKE_PRISMA_DISCONNECTED'), 'Prisma remains connected while work is active')
  child.stdin.write('release\n')
  await until('sync_shutdown_drain_completed')
  await exited
  const settled = output.indexOf('TRACKED_WORK_SETTLED')
  const disconnected = output.indexOf('FAKE_PRISMA_DISCONNECTED')
  const completed = output.indexOf('sync_shutdown_drain_completed')
  assert.ok(settled >= 0 && settled < disconnected && disconnected < completed, output)
  const events = output.split('\n').flatMap(line => {
    try { const value = JSON.parse(line) as { event?: string; bootId?: string; active?: number;
      accepting?: boolean; sharedPrismaDisconnected?: boolean }
      return value.event?.startsWith('sync_shutdown_drain_') ? [value] : []
    } catch { return [] }
  })
  assert.equal(events.length, 2)
  assert.equal(events[0]?.active, 1)
  assert.equal(events[1]?.active, 0)
  assert.equal(events[1]?.accepting, false)
  assert.equal(events[1]?.sharedPrismaDisconnected, true)
  assert.equal(events[0]?.bootId, events[1]?.bootId)
  const started = output.split('\n').flatMap(line => {
    try { const value = JSON.parse(line) as { event?: string; bootId?: string }
      return value.event === 'sync_instance_started' ? [value] : []
    } catch { return [] }
  })
  assert.equal(started.length, 1)
  assert.equal(started[0]?.bootId, events[0]?.bootId)
  assert.equal(child.signalCode, 'SIGTERM')
})
