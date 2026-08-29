import assert from 'node:assert/strict'
import test from 'node:test'
import { BadRequestException, HttpException } from '@nestjs/common'
import {
  createWorkspaceAuditOperation,
  safeWorkspaceAuditMetadata,
  workspaceAuditErrorCode,
  workspaceAuditExpiration,
} from './workspace-audit.js'

test('workspace audit correlation ignores unsafe caller-controlled request IDs', () => {
  const first = createWorkspaceAuditOperation('bad\r\nforged:value')
  const second = createWorkspaceAuditOperation(first.requestId)
  assert.match(first.requestId, /^[0-9a-f-]{36}$/i)
  assert.equal(second.requestId, first.requestId)
  assert.notEqual(first.operationId, second.operationId)
})

test('workspace audit metadata is a strict closed projection', () => {
  const projected = safeWorkspaceAuditMetadata({
    role: 'MSP_VIEWER',
    delivery: 'INVITE',
    factorsRemoved: 2,
    password: 'top secret phrase',
    access_token: 'TOKEN',
    message: 'private provider response',
  })
  assert.deepEqual(projected, {
    role: 'MSP_VIEWER',
    delivery: 'INVITE',
    factorsRemoved: 2,
  })
  assert.doesNotMatch(
    JSON.stringify(projected),
    /secret|token|private provider/i
  )
})

test('workspace audit errors expose only stable codes', () => {
  assert.equal(
    workspaceAuditErrorCode(
      new HttpException(
        { code: 'AUTH_EMAIL_RATE_LIMITED', message: 'provider secret' },
        429
      )
    ),
    'AUTH_EMAIL_RATE_LIMITED'
  )
  assert.equal(
    workspaceAuditErrorCode(new BadRequestException('private input detail')),
    'WORKSPACE_REQUEST_REJECTED'
  )
  assert.equal(
    workspaceAuditErrorCode(new Error('database secret')),
    'WORKSPACE_OPERATION_FAILED'
  )
})

test('workspace audit rows receive a bounded explicit expiration', () => {
  const now = new Date('2026-08-29T00:00:00.000Z')
  assert.equal(
    workspaceAuditExpiration(now).toISOString(),
    '2027-08-29T00:00:00.000Z'
  )
})
