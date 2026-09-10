import assert from 'node:assert/strict'
import test from 'node:test'
import { ForbiddenException } from '@nestjs/common'
import { RISKY_USERS_RESPONSE_VERSION, RiskyUsersController } from './risky-users.controller.js'

/** The endpoint serves one tenant's credential-attack evidence to whoever asks,
 * so the first thing asserted is that it cannot be made to serve somebody
 * else's. Everything below that is shape. */

const request = { auth: { subject: 'auth0|caller' } } as never

const run = {
  evaluationCoverage: {
    version: 'hawkview-run-coverage/v1',
    streams: [{
      stream: 'GRAPH_SIGN_INS',
      coverage: {
        version: 'hawkview-coverage/v1',
        collectionScope: { declared: true, asked: 'GRAPH_INTERACTIVE_ONLY' },
        applies: 2042, doesNotApply: {}, notYetCited: {}, unknown: {}, unprocessable: {},
      },
    }],
  },
  evaluationFindings: {
    version: 'hawkview-run-findings/v1',
    count: { accuracy: 'EXACT', value: 1, scope: { evidenceRequested: ['GRAPH_INTERACTIVE_ONLY'], setAside: [], covered: ['repeated-credential-failure'], notCovered: [] } },
    claim: { permitted: true },
    complete: true,
    sources: [{ source: 'GRAPH_SIGN_INS', status: 'SUCCESS', lastSuccessfulCollectionAt: '2026-09-10T20:55:00.000Z' }],
    items: [{
      detectorId: 'repeated-credential-failure',
      subject: { kind: 'DIRECTORY_USER', userRef: 'subject:c54eb6ce', correlation: { available: false, because: 'pseudonymous' } },
      signals: [
        { signal: 'LOCKED_OUT_AFTER_REPEATED_FAILURES', count: 462, latest: { at: '2026-09-03T10:40:00.000Z', kind: 'EVENT_OCCURRED' }, capped: false },
        { signal: 'PASSWORD_REJECTED', count: 12, latest: { at: '2026-09-09T03:58:00.000Z', kind: 'EVENT_OCCURRED' }, capped: false },
      ],
    }],
  },
  completedAt: new Date('2026-09-10T21:00:00.000Z'),
  windowStart: new Date('2026-08-11T21:00:00.000Z'),
  windowEnd: new Date('2026-09-10T21:00:00.000Z'),
}

function controller(options: Readonly<{
  authorize: () => Promise<{ id: string; organizationId: string } | null>
  row?: typeof run | null
}>) {
  const queried: Record<string, unknown>[] = []
  const identityRisk = { authorizeRiskyUsersRead: options.authorize } as never
  const prisma = {
    identityRiskEvaluationRun: {
      findFirst: async (args: Record<string, unknown>) => {
        queried.push(args)
        return options.row === undefined ? run : options.row
      },
    },
  } as never
  return { queried, controller: new RiskyUsersController(identityRisk, prisma) }
}

test('a tenant the caller cannot reach is refused by the shared check, not by this endpoint', async () => {
  // Authorization is NOT reimplemented here. `scope` throws Forbidden for a
  // tenant outside the caller's active organizations, and this endpoint must let
  // that propagate rather than catching it into an "unavailable" — which would
  // turn a permission failure into a reassuring absence.
  const { controller: subject, queried } = controller({
    authorize: async () => { throw new ForbiddenException('Tenant access denied') },
  })

  await assert.rejects(
    () => subject.assessment(request, 'someone-elses-tenant'),
    (error: unknown) => error instanceof ForbiddenException)

  // And nothing was read. A refused caller must not reach the database at all.
  assert.deepEqual(queried, [])
})

test('the pilot gate declining is its own answer, not a missing assessment', async () => {
  // "You may not read this yet" and "there is nothing to read" are different
  // facts and a technician acts on them differently. Collapsing them into one
  // "unavailable" is the undifferentiated answer this whole vocabulary removes.
  const { controller: subject, queried } = controller({ authorize: async () => null })

  const response = await subject.assessment(request, 'tenant-1') as Record<string, unknown>
  assert.equal(response.available, false)
  assert.equal(response.because, 'NOT_ENABLED_FOR_TENANT')
  assert.deepEqual(queried, [], 'a gated tenant must not be read either')
})

test('an authorized read is scoped to the organization the check returned', async () => {
  // THE QUERY IS BUILT FROM THE AUTHORIZED TENANT, never from the path
  // parameter. If it used the parameter, a caller who passed authorization for
  // one tenant could name another in the URL.
  const { controller: subject, queried } = controller({
    authorize: async () => ({ id: 'authorized-tenant', organizationId: 'authorized-org' }),
  })

  await subject.assessment(request, 'a-different-id-in-the-url')

  const where = queried[0]?.where as Record<string, unknown>
  assert.equal(where.customerTenantId, 'authorized-tenant')
  assert.equal(where.organizationId, 'authorized-org')
  assert.notEqual(where.customerTenantId, 'a-different-id-in-the-url')
})

test('a complete run is served natively, with each signal keeping its own date', async () => {
  const { controller: subject } = controller({
    authorize: async () => ({ id: 'tenant-1', organizationId: 'org-1' }),
  })

  const response = await subject.assessment(request, 'tenant-1') as Record<string, any>

  assert.equal(response.version, RISKY_USERS_RESPONSE_VERSION)
  assert.equal(response.available, true)
  assert.equal(response.count.accuracy, 'EXACT')
  assert.equal(response.claim.permitted, true)
  assert.equal(response.findings.complete, true)

  // The Raymonds shape. 462 lockouts last seen 3 September beside 12 rejections
  // last seen the 9th — the pairing that was wrong before per-signal recency,
  // and the thing a response mapping could silently re-collapse.
  const [finding] = response.findings.items
  assert.equal(finding.signals[0].count, 462)
  assert.equal(finding.signals[0].latest.at, '2026-09-03T10:40:00.000Z')
  assert.equal(finding.signals[0].latest.kind, 'EVENT_OCCURRED')
  assert.equal(finding.signals[1].latest.at, '2026-09-09T03:58:00.000Z')

  // The run's own timing, which a surface needs to say "this assessment is about
  // a window that closed N days ago".
  assert.equal(response.run.windowEnd, '2026-09-10T21:00:00.000Z')
  assert.equal(response.run.completedAt, '2026-09-10T21:00:00.000Z')
})

test('the old engine\'s vocabulary is absent — nothing here invents a capability', async () => {
  // A native endpoint has no envelope to fill, so there are no boundaries to
  // invent. Serving `capability` would mean deciding which withheld reasons are
  // PARTIAL and which are UNAVAILABLE, for a word read before the reasons are.
  const { controller: subject } = controller({
    authorize: async () => ({ id: 'tenant-1', organizationId: 'org-1' }),
  })

  const response = await subject.assessment(request, 'tenant-1') as Record<string, unknown>

  // POSITIVE CONTROL FIRST. An unavailable response carries none of those keys
  // either, so without this the loop below passes on a failed read and proves
  // nothing. This test was written without it and did exactly that.
  assert.equal(response.available, true)
  assert.ok(response.count, 'the control must be a real assessment, not an absence')

  for (const borrowed of ['capability', 'reasonCode', 'freshness', 'selectedSource', 'meta', 'rules', 'sources']) {
    assert.equal(borrowed in response, false, `${borrowed} is the old engine's vocabulary`)
  }
})

test('no run, and an unreadable run, keep their own reasons', async () => {
  const authorize = async () => ({ id: 'tenant-1', organizationId: 'org-1' })

  const none = await controller({ authorize, row: null }).controller
    .assessment(request, 'tenant-1') as Record<string, unknown>
  assert.equal(none.because, 'NO_RUN')

  // Findings that do not decode must not degrade into a count with an empty
  // list — the all-clear over real findings. The reader refuses; the endpoint
  // carries the reason through rather than flattening it.
  const broken = await controller({
    authorize,
    row: { ...run, evaluationFindings: { version: 'hawkview-run-findings/v9' } } as never,
  }).controller.assessment(request, 'tenant-1') as Record<string, unknown>
  assert.equal(broken.available, false)
  assert.equal(broken.because, 'FINDINGS_UNREADABLE')
})

test('the collector facts are served under their own name, and no freshness verdict is', async () => {
  // The consumer derives coverage from these and downgrades an EXACT claim the
  // evidence does not support. That check is only meaningful if it gets the
  // facts rather than our conclusion about them — the same principle as not
  // serving `capability`, one level down.
  const { controller: subject } = controller({
    authorize: async () => ({ id: 'tenant-1', organizationId: 'org-1' }),
  })

  const response = await subject.assessment(request, 'tenant-1') as Record<string, any>
  assert.equal(response.available, true)

  const [source] = response.collectors
  assert.equal(source.source, 'GRAPH_SIGN_INS')
  // Deliberately not under `sources`: that key belongs to the old envelope and
  // carries a different shape. A colliding name is a claim nobody checked.
  assert.equal('sources' in response, false)
  assert.equal(source.lastSuccessfulCollectionAt, '2026-09-10T20:55:00.000Z')
  // Null would mean never collected — a different fact from an old collection,
  // and the one a consumer needs to tell "stale" from "never".
  assert.notEqual(source.lastSuccessfulCollectionAt, null)

  // And no verdict derived FOR them.
  for (const verdict of ['freshness', 'capability', 'complete']) {
    assert.equal(verdict in source, false, `${verdict} is the consumer's to derive`)
  }
})
