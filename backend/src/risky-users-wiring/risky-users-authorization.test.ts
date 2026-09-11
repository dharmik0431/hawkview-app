import assert from 'node:assert/strict'
import test from 'node:test'
import { RiskyUsersController } from './risky-users.controller.js'

/** The three gates and the name tier, each with a positive control.
 *
 * A separate file from the shape tests because these are the assertions whose
 * failure mode is exposure rather than a wrong number — and because an
 * authorization test that passes because the fixture never reached the guard is
 * the worst available version of the vacuity this team has hit five times today.
 * Every test here therefore also proves the permitted path works on the same
 * double.
 */

const request = { auth: { subject: 'auth0|caller' } } as never

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
    count: { accuracy: 'AT_LEAST', value: 1, scope: { evidenceRequested: ['AUDIT_STS_LOGON_EVENTS'], setAside: [], covered: ['repeated-credential-failure'], notCovered: [] } },
    claim: { permitted: false, withheld: [{ stream: 'M365_AUDIT_STS', because: 'UNINTERPRETED_EVENTS' }] },
    complete: true,
    items: [{
      detectorId: 'repeated-credential-failure',
      subject: { kind: 'DIRECTORY_USER', userRef: 'subject:c54eb6ce', correlation: { available: true, matchedBy: 'USER_PRINCIPAL_NAME', ref: 'subject:c54eb6ce' } },
      signals: [
        { signal: 'LOCKED_OUT_AFTER_REPEATED_FAILURES', count: 467, latest: { at: '2026-09-03T10:40:00.000Z', kind: 'EVENT_OCCURRED' }, capped: false },
        { signal: 'PASSWORD_REJECTED', count: 12, latest: { at: '2026-09-09T03:58:00.000Z', kind: 'EVENT_OCCURRED' }, capped: false },
      ],
    }],
  },
  completedAt: new Date('2026-09-10T23:05:00.000Z'),
  windowStart: new Date('2026-08-11T23:05:00.000Z'),
  windowEnd: new Date('2026-09-10T23:05:00.000Z'),
}

const eric = { microsoftUserId: 'c54eb6ce', displayName: 'Eric Raymond', userPrincipalName: 'eric@theraymonds.com' }

type DirectoryRow = { microsoftUserId: string; displayName: string | null; userPrincipalName: string }

function controller(options: {
  gate?: string | null
  evidenceDetailAllowed?: boolean
  tenantId?: string
  organizationId?: string
  directory?: readonly DirectoryRow[]
}) {
  const reads: Record<string, unknown>[] = []
  const lookups: Record<string, unknown>[] = []
  const identityRisk = {
    authorizeRiskyUsersRead: async () => options.gate
      ? { gate: options.gate }
      : {
        gate: null,
        tenant: {
          id: options.tenantId ?? 'tenant-1',
          organizationId: options.organizationId ?? 'org-1',
          evidenceDetailAllowed: options.evidenceDetailAllowed ?? true,
        },
      },
  } as never
  const prisma = {
    identityRiskEvaluationRun: {
      findFirst: async (args: Record<string, unknown>) => { reads.push(args); return run },
    },
    directoryUser: {
      findMany: async (args: Record<string, unknown>) => { lookups.push(args); return options.directory ?? [] },
    },
  } as never
  return { reads, lookups, subject: new RiskyUsersController(identityRisk, prisma) }
}

const serialised = (value: unknown) => JSON.stringify(value)

test('the operator kill switch stops the display, and keeps its own answer', async () => {
  // The gate I missed entirely. Every other identity-risk read checks it, and
  // this endpoint is the rebuilt engine's first exposure to customers — the path
  // most likely to need stopping. A kill switch that does not stop the display is
  // not a kill switch.
  const halted = controller({ gate: 'EVALUATION_DISABLED' })
  const response = await halted.subject.assessment(request, 'tenant-1') as Record<string, unknown>

  assert.equal(response.available, false)
  assert.equal(response.because, 'EVALUATION_DISABLED')
  // Distinct from the pilot gate. "Not enabled here" and "an operator halted
  // this" send a reader to different places.
  assert.notEqual(response.because, 'NOT_ENABLED_FOR_TENANT')
  assert.deepEqual(halted.reads, [], 'a halted tenant must not be read at all')

  // POSITIVE CONTROL: the same double with no gate serves, so the above is about
  // the switch rather than a controller that never reads anything.
  const open = controller({})
  const served = await open.subject.assessment(request, 'tenant-1') as Record<string, unknown>
  assert.equal(served.available, true)
})

test('the pilot gate keeps its own answer too', async () => {
  const gated = controller({ gate: 'NOT_ENABLED_FOR_TENANT' })
  const response = await gated.subject.assessment(request, 'tenant-1') as Record<string, unknown>
  assert.equal(response.because, 'NOT_ENABLED_FOR_TENANT')
  assert.deepEqual(gated.reads, [])
})

test('a role without evidence detail gets the counts and not the names', async () => {
  // What makes the tier a product statement rather than an arbitrary role check:
  // every role sees the counts, the coverage and the opaque ref. Only MSP_OWNER
  // and MSP_ADMIN see who.
  const restricted = controller({ evidenceDetailAllowed: false, directory: [eric] })
  const hidden = await restricted.subject.assessment(request, 'tenant-1') as Record<string, any>

  assert.equal(hidden.available, true)
  assert.equal(hidden.subjectsNamed, false)
  // The finding and its counts are still there — this restricts naming, not access.
  assert.equal(hidden.findings.items[0].signals[0].count, 467)

  // Asserted on the serialised payload so a nested field cannot smuggle a name
  // through a shape I did not think to check.
  assert.equal(serialised(hidden).includes('Eric Raymond'), false)
  assert.equal(serialised(hidden).includes('eric@theraymonds.com'), false)
  // And the directory was never queried for a role that may not see it.
  assert.deepEqual(restricted.lookups, [])

  // POSITIVE CONTROL: the permitted role gets the name from the SAME double.
  // Without this, everything above would also pass against a lookup that simply
  // never works.
  const permitted = controller({ evidenceDetailAllowed: true, directory: [eric] })
  const named = await permitted.subject.assessment(request, 'tenant-1') as Record<string, any>
  assert.equal(named.subjectsNamed, true)
  assert.equal(named.findings.items[0].displayName, 'Eric Raymond')
  assert.equal(named.findings.items[0].userPrincipalName, 'eric@theraymonds.com')
})

test('the name lookup cannot reach another tenant directory', async () => {
  // A display-name join is exactly how the cross-tenant exposure avoided
  // everywhere else tonight would arrive. Both scope columns must be present and
  // must carry the AUTHORIZED ids, never anything taken from the URL.
  const scoped = controller({
    tenantId: 'authorized-tenant',
    organizationId: 'authorized-org',
    directory: [eric],
  })
  await scoped.subject.assessment(request, 'a-different-id-in-the-url')

  const where = scoped.lookups[0]?.where as Record<string, unknown>
  assert.ok(where, 'the lookup must have happened for this control to mean anything')
  assert.equal(where.organizationId, 'authorized-org')
  assert.equal(where.customerTenantId, 'authorized-tenant')
  assert.notEqual(where.customerTenantId, 'a-different-id-in-the-url')
})

test('a subject with no directory row stays opaque, not blank and not invented', async () => {
  // Absent rather than empty. A blank name reads as "this person has no name";
  // an invented placeholder reads as a fact. The opaque ref is the honest answer
  // and it is already in the payload.
  const unmatched = controller({ evidenceDetailAllowed: true, directory: [] })
  const response = await unmatched.subject.assessment(request, 'tenant-1') as Record<string, any>

  const [finding] = response.findings.items
  assert.equal('displayName' in finding, false)
  assert.equal('userPrincipalName' in finding, false)
  // The ref survives, so the subject stays identifiable to someone with database
  // access even when the directory cannot name them.
  assert.equal(finding.subject.userRef, 'subject:c54eb6ce')

  // POSITIVE CONTROL: a matching row does produce a name, so the absences above
  // are about the missing directory row rather than a resolver that never runs.
  const matched = controller({ evidenceDetailAllowed: true, directory: [eric] })
  const withName = await matched.subject.assessment(request, 'tenant-1') as Record<string, any>
  assert.equal(withName.findings.items[0].displayName, 'Eric Raymond')
})
