import assert from 'node:assert/strict'
import test from 'node:test'
import { RiskyUsersController } from './risky-users.controller.js'
import { IDENTITY_DISCLOSURE_ACTION } from '../workspace/identity-disclosure-audit.js'
import { WORKSPACE_AUDIT_RETENTION_DAYS } from '../workspace/workspace-audit.js'

/** Does naming a customer's people actually get recorded?
 *
 * The existing controller tests pass whether or not the audit is wired, because
 * the write cannot fail a read and their doubles have no audit table — so the
 * failure is swallowed and everything stays green. That is the vacuity this
 * codebase keeps meeting, and it is why this file exists with a double that DOES
 * accept the write.
 */

const REQUEST_ID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301'
const request = { auth: { subject: 'auth0|caller' }, requestId: REQUEST_ID } as never

const run = {
  evaluationCoverage: {
    version: 'hawkview-run-coverage/v1',
    streams: [{
      stream: 'GRAPH_SIGN_INS',
      coverage: {
        version: 'hawkview-coverage/v1',
        collectionScope: { declared: true, asked: 'GRAPH_INTERACTIVE_ONLY' },
        applies: 503, doesNotApply: {}, notYetCited: {}, unknown: {}, unprocessable: {},
      },
    }],
  },
  evaluationFindings: {
    version: 'hawkview-run-findings/v1',
    sources: [{ source: 'GRAPH_SIGN_INS', status: 'SUCCESS', lastSuccessfulCollectionAt: '2026-09-10T23:00:00.000Z' }],
    count: { accuracy: 'EXACT', value: 2, scope: { evidenceRequested: ['GRAPH_INTERACTIVE_ONLY'], setAside: [], covered: ['repeated-credential-failure'], notCovered: [] } },
    claim: { permitted: true },
    complete: true,
    items: [
      {
        detectorId: 'repeated-credential-failure',
        subject: { kind: 'DIRECTORY_USER', userRef: 'subject:c54eb6ce', correlation: { available: false, because: 'pseudonymous' } },
        signals: [{ signal: 'LOCKED_OUT_AFTER_REPEATED_FAILURES', count: 462, latest: { at: '2026-09-03T10:40:00.000Z', kind: 'EVENT_OCCURRED' }, capped: false }],
      },
      {
        detectorId: 'repeated-credential-failure',
        subject: { kind: 'DIRECTORY_USER', userRef: 'subject:a1b2c3d4', correlation: { available: false, because: 'pseudonymous' } },
        signals: [{ signal: 'PASSWORD_REJECTED', count: 12, latest: { at: '2026-09-09T03:58:00.000Z', kind: 'EVENT_OCCURRED' }, capped: false }],
      },
    ],
  },
  completedAt: new Date('2026-09-10T23:05:00.000Z'),
  windowStart: new Date('2026-08-11T23:05:00.000Z'),
  windowEnd: new Date('2026-09-10T23:05:00.000Z'),
}

const eric = { microsoftUserId: 'c54eb6ce', displayName: 'Eric Raymond', userPrincipalName: 'eric@theraymonds.com' }
const dana = { microsoftUserId: 'a1b2c3d4', displayName: 'Dana Okafor', userPrincipalName: 'dana@theraymonds.com' }

function controller(options: {
  evidenceDetailAllowed?: boolean
  directory?: readonly (typeof eric)[]
  auditFails?: boolean
} = {}) {
  const audited: Record<string, unknown>[] = []
  const identityRisk = {
    authorizeRiskyUsersRead: async () => ({
      gate: null,
      tenant: {
        id: 'authorized-tenant',
        organizationId: 'authorized-org',
        actorUserId: 'operator-user-id',
        evidenceDetailAllowed: options.evidenceDetailAllowed ?? true,
      },
    }),
  } as never
  const prisma = {
    identityRiskEvaluationRun: { findFirst: async () => run },
    directoryUser: { findMany: async () => options.directory ?? [] },
    workspaceAdminAuditLog: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        if (options.auditFails) throw new Error('audit table unavailable')
        audited.push(data)
        return data
      },
    },
  } as never
  return { audited, subject: new RiskyUsersController(identityRisk, prisma) }
}

test('naming a customer’s people writes exactly one disclosure row', async () => {
  const world = controller({ directory: [eric, dana] })
  const response = await world.subject.assessment(request, 'authorized-tenant') as Record<string, any>

  // The names really were served — otherwise there is nothing to have audited.
  assert.equal(response.subjectsNamed, true)
  assert.equal(response.findings.items[0].displayName, 'Eric Raymond')

  assert.equal(world.audited.length, 1, 'one read that named people is one audit row')
  const row = world.audited[0]
  assert.equal(row.action, IDENTITY_DISCLOSURE_ACTION)
  assert.equal(row.targetType, 'CUSTOMER_TENANT')
  assert.equal(row.outcome, 'SUCCEEDED')
  // Scoped to the AUTHORIZED tenant and organization, never anything from the URL.
  assert.equal(row.targetOpaqueId, 'authorized-tenant')
  assert.equal(row.organizationId, 'authorized-org')
  // WHICH operator. Without this the row answers "somebody looked", which is not
  // the question anyone asks after an account is compromised.
  assert.equal(row.actorUserId, 'operator-user-id')
  // How many people, so the row means something on its own.
  assert.deepEqual(row.metadata, { namedSubjectCount: 2, surface: 'RISKY_USERS_ASSESSMENT' })
  // Correlates with the response the operator received.
  assert.equal(row.requestId, REQUEST_ID)
})

test('THE AUDIT ROW DOES NOT CONTAIN THE NAMES', async () => {
  // THE CONSTRAINT THAT MATTERS MOST. An audit log of who saw which identities
  // must never become a second, longer-lived copy of those identities — it would
  // be the largest identity store in the product, kept for a year, and justified
  // as a control.
  const world = controller({ directory: [eric, dana] })
  const response = await world.subject.assessment(request, 'authorized-tenant')

  const row = JSON.stringify(world.audited[0])
  for (const identifying of ['Eric Raymond', 'eric@theraymonds.com', 'Dana Okafor', 'dana@theraymonds.com']) {
    assert.equal(row.includes(identifying), false, `${identifying} must not reach the audit row`)
  }
  // The opaque subject refs must not travel either: they are stable per person
  // and would re-identify across rows.
  assert.equal(row.includes('c54eb6ce'), false)
  // And the email columns stay null rather than being filled with something.
  assert.equal(world.audited[0].actorEmail, null)
  assert.equal(world.audited[0].targetEmail, null)

  // POSITIVE CONTROL: those names ARE in the response. Without this the test
  // would also pass against a controller that never named anybody, which is the
  // cheapest way to satisfy an assertion about absence.
  const served = JSON.stringify(response)
  assert.equal(served.includes('Eric Raymond'), true)
  assert.equal(served.includes('dana@theraymonds.com'), true)
})

test('a role that may not see names produces no names and no row', async () => {
  const restricted = controller({ evidenceDetailAllowed: false, directory: [eric, dana] })
  const response = await restricted.subject.assessment(request, 'authorized-tenant') as Record<string, any>

  assert.equal(response.subjectsNamed, false)
  assert.equal(JSON.stringify(response).includes('Eric Raymond'), false)
  assert.deepEqual(restricted.audited, [], 'nothing was disclosed, so there is nothing to record')

  // POSITIVE CONTROL: the permitted role on the same fixture writes one.
  const permitted = controller({ evidenceDetailAllowed: true, directory: [eric, dana] })
  await permitted.subject.assessment(request, 'authorized-tenant')
  assert.equal(permitted.audited.length, 1)
})

test('a permitted read that names nobody is not recorded as a disclosure', async () => {
  // subjectsNamed can be true while no directory row matched, so nothing
  // identifying reached the operator. Recording those would fill the log with
  // rows in which nothing was shown, and a log that is mostly noise is one
  // nobody reads when it matters.
  const empty = controller({ evidenceDetailAllowed: true, directory: [] })
  const response = await empty.subject.assessment(request, 'authorized-tenant') as Record<string, any>

  assert.equal(response.subjectsNamed, true, 'the role still permits naming')
  assert.equal('displayName' in response.findings.items[0], false, 'but nobody was named')
  assert.deepEqual(empty.audited, [])

  // POSITIVE CONTROL: one matching row is one disclosure, and the count says one.
  const partial = controller({ evidenceDetailAllowed: true, directory: [eric] })
  await partial.subject.assessment(request, 'authorized-tenant')
  assert.equal(partial.audited.length, 1)
  assert.deepEqual(
    (partial.audited[0].metadata as Record<string, unknown>).namedSubjectCount, 1,
    'the count is who was actually named, not how many were asked about')
})

test('an audit failure does not refuse the read', async () => {
  // A technician investigating a live attack must not be blocked because an
  // audit insert failed. Same rule as the secret store re-seal.
  const broken = controller({ directory: [eric, dana], auditFails: true })
  const response = await broken.subject.assessment(request, 'authorized-tenant') as Record<string, any>

  assert.equal(response.available, true)
  assert.equal(response.findings.items[0].displayName, 'Eric Raymond', 'the names must still be served')
  assert.deepEqual(broken.audited, [], 'and the row genuinely did not get written')
})

test('the row expires on the existing workspace retention window', async () => {
  // One retention policy, not two. A second one stops silently and nobody
  // notices for a year.
  const world = controller({ directory: [eric] })
  const before = Date.now()
  await world.subject.assessment(request, 'authorized-tenant')

  const expiresAt = world.audited[0].expiresAt as Date
  const days = (expiresAt.getTime() - before) / (24 * 60 * 60 * 1000)
  assert.ok(Math.abs(days - WORKSPACE_AUDIT_RETENTION_DAYS) < 1, `expected ~${WORKSPACE_AUDIT_RETENTION_DAYS} days, got ${days}`)
})
