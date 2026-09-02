import assert from 'node:assert/strict'
import test from 'node:test'
import { BadRequestException, HttpException } from '@nestjs/common'
import {
  createWorkspaceAuditOperation,
  safeWorkspaceAuditMetadata,
  workspaceAuditErrorCode,
  workspaceAuditExpiration,
} from './workspace-audit.js'
import type { AuthenticatedIdentity } from '../auth/auth.types.js'
import type { PrismaService } from '../prisma/prisma.service.js'
import { WorkspaceService } from './workspace.service.js'

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
    workspaceAuditErrorCode(
      new HttpException(
        { code: 'INVITATION_NOT_PENDING', message: 'safe member state' },
        409
      )
    ),
    'INVITATION_NOT_PENDING'
  )
  assert.equal(
    workspaceAuditErrorCode(
      new HttpException(
        {
          code: 'PASSWORD_RESET_REQUIRES_ACCEPTED_ACCOUNT',
          message: 'safe member state',
        },
        409
      )
    ),
    'PASSWORD_RESET_REQUIRES_ACCEPTED_ACCOUNT'
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

test('workspace audit reads and pruning are organization scoped and require a future expiry', async () => {
  const organizationId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
  const identity: AuthenticatedIdentity = {
    subject: '11111111-2222-3333-4444-555555555555',
    email: 'owner@example.com',
  }
  let deleteWhere: unknown
  let readWhere: unknown
  const prisma = {
    user: {
      findUnique: async () => ({
        id: 'owner-user',
        email: identity.email,
        disabledAt: null,
        memberships: [
          {
            organization: {
              id: organizationId,
              name: 'Example MSP',
              businessDomain: 'example.com',
              timeZone: 'America/Toronto',
              onboardingCompletedAt: new Date('2026-08-01T00:00:00.000Z'),
            },
          },
        ],
      }),
    },
    workspaceAdminAuditLog: {
      deleteMany: async ({ where }: { where: unknown }) => {
        deleteWhere = where
        return { count: 1 }
      },
      findMany: async ({ where }: { where: unknown }) => {
        readWhere = where
        return []
      },
    },
  } as unknown as PrismaService

  const result = await new WorkspaceService(prisma).listAuditLogs(
    identity,
    organizationId,
  )

  assert.deepEqual(result, { items: [] })
  assert.equal(
    (deleteWhere as { organizationId?: unknown }).organizationId,
    organizationId,
  )
  assert.ok(
    (deleteWhere as { expiresAt?: { lte?: unknown } }).expiresAt?.lte instanceof
      Date,
  )
  assert.equal(
    (readWhere as { organizationId?: unknown }).organizationId,
    organizationId,
  )
  assert.ok(
    (readWhere as { expiresAt?: { gt?: unknown } }).expiresAt?.gt instanceof
      Date,
  )
  assert.equal(Object.prototype.hasOwnProperty.call(readWhere as object, 'OR'), false)
})
