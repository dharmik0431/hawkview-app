import assert from 'node:assert/strict'
import test from 'node:test'
import {
  workspaceAuditActorLabel,
  workspaceAuditMetadataRows,
  workspaceAuditTargetLabel,
} from './audit-evidence.ts'

const members = [
  { userId: 'user-1', email: 'owner@example.test', displayName: 'Owner' },
  { userId: 'user-2', email: 'member@example.test', displayName: 'Member' },
]

test('opaque audit evidence resolves through authorized workspace member data', () => {
  const entry = {
    actorUserId: 'user-1',
    targetUserId: 'user-2',
    actorEmail: null,
    targetEmail: null,
  }
  assert.equal(workspaceAuditActorLabel(entry, members), 'Owner')
  assert.equal(workspaceAuditTargetLabel(entry, members), 'Member')
})

test('audit metadata projection is closed and never renders arbitrary diagnostics', () => {
  const rows = workspaceAuditMetadataRows({
    role: 'MSP_VIEWER',
    delivery: 'INVITE',
    password: 'top secret phrase',
    access_token: 'TOKENSECRET',
    message: 'private provider payload',
    nested: { client_secret: 'SECRET' },
  })
  assert.deepEqual(rows, [
    { key: 'delivery', label: 'Delivery type', value: 'INVITE' },
    { key: 'role', label: 'Role', value: 'MSP_VIEWER' },
  ])
  assert.doesNotMatch(JSON.stringify(rows), /secret|token|private provider/i)
})

test('unknown targets show only a bounded opaque suffix', () => {
  assert.equal(
    workspaceAuditTargetLabel(
      {
        targetType: 'WORKSPACE_MEMBER',
        targetOpaqueId: 'invite:12345678-1234-1234-1234-abcdef123456',
      },
      []
    ),
    'workspace member · ef123456'
  )
})
