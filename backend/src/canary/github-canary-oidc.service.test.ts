import assert from 'node:assert/strict'
import test from 'node:test'
import {
  assertGitHubCanaryClaims,
  HAWKVIEW_CANARY_AUDIENCE,
  HAWKVIEW_CANARY_WORKFLOW_REF,
  HAWKVIEW_GITHUB_REPOSITORY,
  HAWKVIEW_GITHUB_REPOSITORY_ID,
} from './github-canary-oidc.service.js'

test('pins GitHub OIDC to the branded production API audience', () => {
  assert.equal(
    HAWKVIEW_CANARY_AUDIENCE,
    'https://api.hawkviewapp.com/api/internal/canary/sessions',
  )
})

const now = 1_800_000_000
const revision = 'a'.repeat(40)
const validClaims = {
  repository: HAWKVIEW_GITHUB_REPOSITORY,
  repository_id: HAWKVIEW_GITHUB_REPOSITORY_ID,
  ref: 'refs/heads/main',
  sha: revision,
  workflow_ref: HAWKVIEW_CANARY_WORKFLOW_REF,
  event_name: 'deployment_status',
  iat: now - 5,
}

test('accepts only the pinned main deployment workflow and exact revision', () => {
  assert.doesNotThrow(() => assertGitHubCanaryClaims(validClaims, revision, now))
  assert.doesNotThrow(() =>
    assertGitHubCanaryClaims(
      { ...validClaims, event_name: 'workflow_dispatch' },
      revision.toUpperCase(),
      now,
    ),
  )
})

for (const [label, override] of [
  ['repository', { repository: 'attacker/fork' }],
  ['immutable repository id', { repository_id: '1' }],
  ['main ref', { ref: 'refs/heads/feature' }],
  ['workflow file', { workflow_ref: 'dharmik0431/hawkview-app/.github/workflows/quality-gates.yml@refs/heads/main' }],
  ['deployment revision', { sha: 'b'.repeat(40) }],
  ['event type', { event_name: 'pull_request' }],
  ['fresh issue time', { iat: now - 301 }],
] as const) {
  test(`rejects a mismatched ${label}`, () => {
    assert.throws(
      () => assertGitHubCanaryClaims({ ...validClaims, ...override }, revision, now),
      /not authorized/,
    )
  })
}
