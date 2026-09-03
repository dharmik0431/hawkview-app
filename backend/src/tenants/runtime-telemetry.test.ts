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
  assert.equal(event.phase, 'UNKNOWN')
})

test('telemetry uses a closed phase and outcome catalog', () => {
  const messages: string[] = []
  logProcessMemoryPhase({ log: (message: string) => messages.push(message) } as any, 'token=abc user@example.com 123e4567-e89b-12d3-a456-426614174000', 'leaked-outcome')
  assert.deepEqual(JSON.parse(messages[0]!), {
    ...JSON.parse(messages[0]!),
    phase: 'UNKNOWN',
    outcome: 'UNKNOWN',
  })
  assert.equal(messages[0]!.includes('user@example.com'), false)
  assert.equal(messages[0]!.includes('123e4567'), false)
})
