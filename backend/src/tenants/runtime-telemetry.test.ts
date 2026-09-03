import assert from 'node:assert/strict'
import test from 'node:test'
import { logProcessMemoryPhase } from './runtime-telemetry.js'

test('memory phase telemetry is bounded and contains no caller-provided text', () => {
  const messages: string[] = []
  logProcessMemoryPhase({ log: (message: string) => messages.push(message) } as any, ' token=secret@example.com '.repeat(20), 'COMPLETED', Date.now() - 10)
  assert.equal(messages.length, 1)
  assert.equal(messages[0].includes('secret@example.com'), false)
  const event = JSON.parse(messages[0])
  assert.equal(event.event, 'runtime_memory_phase')
  assert.equal(event.outcome, 'COMPLETED')
  assert.equal(typeof event.rssBytes, 'number')
  assert.ok(event.phase.length <= 64)
})
