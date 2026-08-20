import assert from 'node:assert/strict'
import test from 'node:test'

import {
  PassiveWorkspaceRefreshLimiter,
  WorkspaceBootstrapRefreshQueue,
  WorkspaceChangeSignalGuard,
  normalizeWorkspaceChangeSignal,
} from './workspace-onboarding-sync.ts'

const SUBJECT_A = '123e4567-e89b-42d3-a456-426614174000'
const SUBJECT_B = '223e4567-e89b-42d3-a456-426614174000'
const ORG_A = '323e4567-e89b-42d3-a456-426614174000'
const ORG_B = '423e4567-e89b-42d3-a456-426614174000'
const now = 2_000_000_000_000

function session(subject: string, organizationId: string) {
  return {
    user: {
      id: subject,
      email: 'owner@example.test',
      displayName: null,
      timeZone: null,
      dateFormat: 'yyyy-MM-dd',
      timeFormat: '12h' as const,
      platformRole: 'STANDARD_USER' as const,
      memberships: [
        {
          id: 'membership-1',
          role: 'MSP_OWNER' as const,
          status: 'ACTIVE' as const,
          organization: {
            id: organizationId,
            name: 'MSP',
            slug: 'internal',
            status: 'ACTIVE',
          },
        },
      ],
    },
  }
}

const signal = (subject = SUBJECT_A, organizationId = ORG_A, generation = 1) => ({
  version: 1,
  subject,
  organizationId,
  generation,
  emittedAt: now,
})

test('cross-tab signals are subject and organization scoped and generation ordered', () => {
  const guard = new WorkspaceChangeSignalGuard()
  assert.ok(guard.accept(signal(), SUBJECT_A, session(SUBJECT_A, ORG_A), now))
  assert.equal(guard.accept(signal(), SUBJECT_A, session(SUBJECT_A, ORG_A), now), null)
  assert.ok(guard.accept(signal(SUBJECT_A, ORG_A, 2), SUBJECT_A, session(SUBJECT_A, ORG_A), now))

  assert.equal(guard.accept(signal(SUBJECT_A, ORG_A, 3), SUBJECT_B, session(SUBJECT_B, ORG_B), now), null)
  assert.equal(guard.accept(signal(SUBJECT_A, ORG_B, 3), SUBJECT_A, session(SUBJECT_A, ORG_A), now), null)
})

test('malformed, inherited, stale, and future signals fail closed', () => {
  assert.equal(normalizeWorkspaceChangeSignal(Object.create(signal()), now), null)
  assert.equal(normalizeWorkspaceChangeSignal({ ...signal(), emittedAt: now - 300_001 }, now), null)
  assert.equal(normalizeWorkspaceChangeSignal({ ...signal(), emittedAt: now + 10_001 }, now), null)
  assert.equal(normalizeWorkspaceChangeSignal({ ...signal(), subject: 'not-a-uuid' }, now), null)
})

test('focus and visibility refreshes are bounded', () => {
  const limiter = new PassiveWorkspaceRefreshLimiter()
  assert.equal(limiter.allow(now), true)
  assert.equal(limiter.allow(now + 100), false)
  assert.equal(limiter.allow(now + 5_000), true)
})

test('a workspace change queues exactly one bootstrap after a stale request settles', async () => {
  const queue = new WorkspaceBootstrapRefreshQueue()
  let release!: () => void
  const staleRequest = new Promise<void>((resolve) => {
    release = resolve
  })
  let refreshes = 0
  const first = queue.request(staleRequest, async () => ++refreshes)
  const latest = queue.request(staleRequest, async () => ++refreshes)

  await Promise.resolve()
  assert.equal(refreshes, 0)
  release()

  assert.equal(await first, null)
  assert.equal(await latest, 1)
  assert.equal(refreshes, 1)
})
