import assert from 'node:assert/strict'
import test from 'node:test'
import { normalizeDeploymentRevision } from './health.controller.js'

test('exposes only an exact full Git commit revision', () => {
  const revision = 'A'.repeat(40)
  assert.equal(normalizeDeploymentRevision(revision), revision.toLowerCase())
  assert.equal(normalizeDeploymentRevision('abc1234'), null)
  assert.equal(normalizeDeploymentRevision('g'.repeat(40)), null)
  assert.equal(normalizeDeploymentRevision(''), null)
  assert.equal(normalizeDeploymentRevision(undefined), null)
})
