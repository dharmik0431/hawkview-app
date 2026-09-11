import assert from 'node:assert/strict'
import test from 'node:test'
import {
  IDENTITY_DISCLOSURE_ACTION,
  recordIdentityDisclosure,
} from './identity-disclosure-audit.js'
import { safeWorkspaceAuditMetadata } from './workspace-audit.js'

/** The disclosure writer, and the allowlist that keeps a name out of it. */

function client(options: { fails?: boolean } = {}) {
  const rows: Record<string, unknown>[] = []
  return {
    rows,
    prisma: {
      workspaceAdminAuditLog: {
        create: async ({ data }: { data: Record<string, unknown> }) => {
          if (options.fails) throw new Error('audit table unavailable')
          rows.push(data)
          return data
        },
      },
    } as never,
  }
}

const actor = { organizationId: 'org-1', userId: 'operator-1' }
const disclosure = {
  customerTenantId: 'tenant-1',
  namedSubjectCount: 3,
  surface: 'RISKY_USERS_ASSESSMENT' as const,
  requestId: '3f2504e0-4f89-41d3-9a0c-0305e82c3301',
}

test('it records the count, the tenant and the operator', async () => {
  const world = client()
  await recordIdentityDisclosure(world.prisma, actor, disclosure)

  assert.equal(world.rows.length, 1)
  const row = world.rows[0]
  assert.equal(row.action, IDENTITY_DISCLOSURE_ACTION)
  assert.equal(row.actorUserId, 'operator-1')
  assert.equal(row.organizationId, 'org-1')
  assert.equal(row.targetOpaqueId, 'tenant-1')
  assert.deepEqual(row.metadata, { namedSubjectCount: 3, surface: 'RISKY_USERS_ASSESSMENT' })
})

test('IT NEVER THROWS, whatever the database does', async () => {
  // The read must survive an audit failure. A technician investigating a live
  // attack must not be blocked because an insert failed.
  const broken = client({ fails: true })
  await assert.doesNotReject(() => recordIdentityDisclosure(broken.prisma, actor, disclosure))
  assert.deepEqual(broken.rows, [], 'and it genuinely did not write')

  // POSITIVE CONTROL: the same call against a working client does write, so the
  // tolerance above is about the failure and not a function that does nothing.
  const working = client()
  await recordIdentityDisclosure(working.prisma, actor, disclosure)
  assert.equal(working.rows.length, 1)
})

test('the metadata allowlist drops anything that is not evidence', async () => {
  // THE STRUCTURAL HALF OF "NO NAMES IN THE AUDIT ROW". The writer filters
  // metadata against a fixed set of keys, so a later edit that puts a name in
  // metadata writes nothing rather than leaking. This asserts the filter still
  // behaves that way, because the whole no-names guarantee leans on it.
  const filtered = safeWorkspaceAuditMetadata({
    namedSubjectCount: 3,
    surface: 'RISKY_USERS_ASSESSMENT',
    displayName: 'Eric Raymond',
    userPrincipalName: 'eric@theraymonds.com',
    subjects: ['Eric Raymond', 'Dana Okafor'],
  } as never)

  assert.deepEqual(filtered, { namedSubjectCount: 3, surface: 'RISKY_USERS_ASSESSMENT' })
  const serialised = JSON.stringify(filtered)
  assert.equal(serialised.includes('Eric Raymond'), false)
  assert.equal(serialised.includes('eric@theraymonds.com'), false)
})

test('an implausible count is dropped rather than stored', async () => {
  // The filter bounds integers at 100,000. A count outside that is not a count,
  // and a row with a nonsense number invites someone to explain it rather than
  // to distrust it.
  assert.deepEqual(
    safeWorkspaceAuditMetadata({ namedSubjectCount: -1, surface: 'RISKY_USERS_ASSESSMENT' } as never),
    { surface: 'RISKY_USERS_ASSESSMENT' })

  // POSITIVE CONTROL: an ordinary count survives.
  assert.deepEqual(
    safeWorkspaceAuditMetadata({ namedSubjectCount: 12, surface: 'RISKY_USERS_ASSESSMENT' } as never),
    { namedSubjectCount: 12, surface: 'RISKY_USERS_ASSESSMENT' })
})
