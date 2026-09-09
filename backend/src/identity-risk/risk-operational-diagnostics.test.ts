import assert from 'node:assert/strict'
import test from 'node:test'
import { CYCLE_REASONS, READER_REASONS, MAX_DIAGNOSTIC_COUNTER, READER_FLUSH_MS,
  RiskCycleDiagnostic, RiskReaderDiagnostics, observeCycle } from './risk-operational-diagnostics.js'

const hostile = [undefined, null, '__proto__', 'constructor', 'token=SECRET', 'x'.repeat(1_000_000),
  new Error('password=SECRET'), ['SECRET'], { tenantId: 'SECRET', token: 'SECRET' },
  Object.create({ reason: 'COMMITTED' }), new Proxy({}, { get() { throw new Error('SECRET') } })]

test('closed versioned cycle schema rejects arbitrary inputs without inspecting their fields', () => {
  for (const input of hostile) {
    const lines: string[] = []; const diagnostic = new RiskCycleDiagnostic(line => lines.push(line))
    diagnostic.record(input); diagnostic.finish(); diagnostic.finish()
    assert.deepEqual(lines.map(line => JSON.parse(line)), [{ version: 1, eventName: 'risk_cycle_diagnostic', reason: 'ATTEMPT_FAILED' }])
    assert.doesNotMatch(lines.join(''), /SECRET|token|tenant|stack|__proto__/)
  }
})

test('cycle is one fixed outcome, no counts; failures and uncommitted returns cannot become committed', () => {
  for (const reason of CYCLE_REASONS) {
    const lines: string[] = []; const d = new RiskCycleDiagnostic(line => lines.push(line))
    d.record(reason); d.finish(); d.record('COMMITTED'); d.finish()
    assert.equal(lines.length, 1); assert.deepEqual(Object.keys(JSON.parse(lines[0]!)), ['version', 'eventName', 'reason'])
    assert.equal(JSON.parse(lines[0]!).reason, reason)
  }
  for (const reason of ['ATTEMPT_FAILED','RETURNED_UNCOMMITTED','ADMISSION_BUDGET_EXHAUSTED']) {
    const lines: string[] = []; const d = new RiskCycleDiagnostic(line => lines.push(line))
    d.record('COMMITTED'); d.record(reason); d.record('COMMITTED'); d.finish()
    assert.equal(JSON.parse(lines[0]!).reason, reason)
  }
})

test('reader is fixed-size, fixed-rate, saturating and resets even if logging fails', async () => {
  let now = 0; const lines: string[] = []
  const d = new RiskReaderDiagnostics(line => lines.push(line), () => now)
  await Promise.all(Array.from({length:100}, async () => {
    for (let i=0;i<1000;i++) { d.record('MEMORY_LANE_BUSY'); d.flush() }
  }))
  for (const value of hostile) d.record(value)
  assert.equal(lines.length, 0)
  now = READER_FLUSH_MS; d.flush(); d.flush()
  assert.equal(lines.length, 1)
  const record = JSON.parse(lines[0]!)
  assert.deepEqual(Object.keys(record), ['version','eventName','reason','counters'])
  assert.deepEqual(Object.keys(record.counters), [...READER_REASONS])
  assert.equal(record.counters.MEMORY_LANE_BUSY, MAX_DIAGNOSTIC_COUNTER)
  assert.equal(record.counters.READ_FAILED, hostile.length)
  assert.doesNotMatch(lines.join(''), /SECRET|password|token|tenant|http|__proto__/)
  d.record('SUCCESS'); now += READER_FLUSH_MS; d.flush()
  assert.equal(JSON.parse(lines[1]!).counters.SUCCESS, 1)
  assert.equal(JSON.parse(lines[1]!).counters.MEMORY_LANE_BUSY, 0)
  now += READER_FLUSH_MS; d.flush(); assert.equal(lines.length, 2)
  let attempts=0
  const throwing = new RiskReaderDiagnostics(() => { attempts++; throw new Error('SECRET') }, () => now)
  throwing.record('KEY_UNAVAILABLE'); now += READER_FLUSH_MS
  assert.doesNotThrow(() => throwing.flush()); now += READER_FLUSH_MS; throwing.flush()
  assert.equal(attempts, 1, 'failed flush is dropped, never replayed/double counted')
})

test('throwing/reentrant observers cannot escape or duplicate a cycle event', () => {
  assert.doesNotThrow(() => observeCycle(() => { throw new Error('SECRET') }, 'COMMITTED'))
  let calls=0
  const d = new RiskCycleDiagnostic(() => { calls++; d.finish(); throw new Error('SECRET') })
  d.record('COMMITTED'); assert.doesNotThrow(() => d.finish()); d.finish()
  assert.equal(calls, 1)
})
