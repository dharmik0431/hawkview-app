import assert from 'node:assert/strict'
import test from 'node:test'
import { classifyEvent } from './event-classifier.ts'
import type { ChangeEvent } from './change-types.ts'

const base: ChangeEvent = {
  id: 'event-1', ts: '2026-08-18T12:00:00.000Z', tenantId: 'tenant-1', tenantName: 'Contoso',
  provider: 'Microsoft', category: 'Unknown', severity: 'High', title: 'Group policy report',
  summary: 'Mentions applications and licenses but is not structured evidence.', source: 'Unknown',
  classification: 'configuration_change',
}

test('does not infer category, success, or high risk from arbitrary presentation text', () => {
  const classified = classifyEvent(base)
  assert.equal(classified.category.key, 'general-audit')
  assert.equal(classified.result, 'unknown')
  assert.equal(classified.resultText, 'Not reported')
  assert.equal(classified.isHighRisk, false)
})

test('uses closed explicit result mappings only', () => {
  assert.equal(classifyEvent({ ...base, category: 'Apps', evidence: { result: 'Succeeded' } }).result, 'success')
  assert.equal(classifyEvent({ ...base, category: 'Apps', evidence: { result: 'Denied' } }).result, 'failure')
  assert.equal(classifyEvent({ ...base, category: 'Apps', evidence: { result: 'CompletedWithWarnings' } }).result, 'unknown')
})
