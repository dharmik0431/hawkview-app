import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { assertDisposableTestDatabase } from '../prisma/native-alert-test-database.js'
import test, { after, before } from 'node:test'
import pg from 'pg'
import { PrismaPg } from '@prisma/adapter-pg'
import { PrismaClient } from '../generated/prisma/client.js'
import type { PrismaService } from '../prisma/prisma.service.js'
import { AlertDispositionsService } from './alert-dispositions.service.js'
import { ALERT_CATALOG } from './alert-catalog.js'
import { dispositionIsConsulted } from './alert-type-reach.js'

/**
 * THE SETTINGS PAGE'S TWO ENDPOINTS, against a real database.
 *
 * The write matters more than the read: a settings page that accepts a value the pipeline will
 * never read is the defect the column rename closed — the row exists, the write succeeds, the MSP
 * sees their choice saved, and nothing changes.
 */

const RUN = process.env.HAWKVIEW_RUN_DATABASE_INTEGRATION_TESTS === '1'
const URL = RUN ? assertDisposableTestDatabase().toString() : undefined

/**
 * Keep the shared integration gate for the legacy-value constraint fixture. Each test owns
 * fresh identities and cleans only its own rows before this session releases the gate.
 */
const INTEGRATION_GATE = 8_192_026
let gate: pg.Client | null = null
before(async () => {
  if (!RUN || !URL) return
  gate = new pg.Client({ connectionString: URL })
  await gate.connect()
  await gate.query('SELECT pg_advisory_lock($1)', [INTEGRATION_GATE])
})
after(async () => {
  if (gate === null) return
  const errors: unknown[] = []
  for (const fixture of pendingCleanup) {
    try { await cleanupFixture(gate, fixture) } catch (error) { errors.push(error) }
  }
  try { await gate.query('SELECT pg_advisory_unlock($1)', [INTEGRATION_GATE]) }
  catch (error) { errors.push(error) }
  try { await gate.end() } catch (error) { errors.push(error) }
  gate = null
  throwFailures(errors, 'Owned fixture cleanup or integration gate release failed')
})

const LIVE = 'security.suspected_credential_attack'

interface Fixture {
  org: string
  user: string
  foreignOrg: string
  slug: string
  foreignSlug: string
  identity: { subject: string; email: string }
  organizations: { id: string; slug: string }[]
  userCreated: boolean
}

const pendingCleanup = new Set<Fixture>()

function newFixture(): Fixture {
  const org = randomUUID()
  const user = randomUUID()
  const foreignOrg = randomUUID()
  return {
    org, user, foreignOrg,
    slug: `dispositions-probe-${org}`,
    foreignSlug: `dispositions-foreign-${foreignOrg}`,
    identity: {
      subject: `auth|dispositions-probe-${user}`,
      email: `dispositions-probe+${user}@an-msp.example`,
    },
    organizations: [],
    userCreated: false,
  }
}

function throwFailures(errors: unknown[], message: string) {
  if (errors.length === 1) throw errors[0]
  if (errors.length > 1) throw new AggregateError(errors, message)
}

async function transaction(client: pg.Client, body: () => Promise<void>) {
  await client.query('BEGIN')
  try {
    await body()
    await client.query('COMMIT')
  } catch (error) {
    try { await client.query('ROLLBACK') }
    catch (rollbackError) { throw new AggregateError([error, rollbackError], 'Fixture transaction failed') }
    throw error
  }
}

async function insertOrganization(client: pg.Client, fixture: Fixture, id: string, slug: string) {
  await client.query(
    `INSERT INTO organizations (id, name, slug, created_at, updated_at)
     VALUES ($1, 'Disposition fixture', $2, now(), now())`, [id, slug])
  // Record ownership only after a plain insert succeeds; never adopt a conflicting row.
  fixture.organizations.push({ id, slug })
  pendingCleanup.add(fixture)
}

async function scaffold(client: pg.Client, fixture: Fixture) {
  await transaction(client, async () => {
    await insertOrganization(client, fixture, fixture.org, fixture.slug)
    await client.query(
      `INSERT INTO users (id, email, auth_provider_user_id, updated_at)
       VALUES ($1, $2, $3, now())`, [fixture.user, fixture.identity.email, fixture.identity.subject])
    fixture.userCreated = true
    await client.query(
      `INSERT INTO memberships (id, user_id, organization_id, role, status, created_at, updated_at)
       VALUES (gen_random_uuid(), $1, $2, 'MSP_OWNER', 'ACTIVE', now(), now())`,
      [fixture.user, fixture.org])
  })
}

async function assertOwnedRowsAbsent(client: pg.Client, fixtures: Fixture[]) {
  const organizations = fixtures.flatMap((fixture) => fixture.organizations.map(({ id }) => id))
  const users = fixtures.filter((fixture) => fixture.userCreated).map((fixture) => fixture.user)
  const result = await client.query(
    `SELECT
       (SELECT count(*)::int FROM organizations WHERE id = ANY($1::uuid[])) AS organizations,
       (SELECT count(*)::int FROM users WHERE id = ANY($2::uuid[])) AS users,
       (SELECT count(*)::int FROM memberships
        WHERE organization_id = ANY($1::uuid[]) OR user_id = ANY($2::uuid[])) AS memberships,
       (SELECT count(*)::int FROM alert_rule_dispositions
        WHERE organization_id = ANY($1::uuid[])) AS dispositions`, [organizations, users])
  assert.deepEqual(result.rows[0], { organizations: 0, users: 0, memberships: 0, dispositions: 0 },
    'only this invocation\'s owned rows must be absent; the database need not be empty')
}

async function cleanupFixture(client: pg.Client, fixture: Fixture) {
  const errors: unknown[] = []
  // The migrated foreign keys cascade owned dispositions and memberships from organizations.
  for (const organization of fixture.organizations) {
    try {
      await client.query('DELETE FROM organizations WHERE id = $1 AND slug = $2',
        [organization.id, organization.slug])
    } catch (error) { errors.push(error) }
  }
  if (fixture.userCreated) {
    try {
      await client.query('DELETE FROM users WHERE id = $1 AND email = $2 AND auth_provider_user_id = $3',
        [fixture.user, fixture.identity.email, fixture.identity.subject])
    } catch (error) { errors.push(error) }
  }
  try { await assertOwnedRowsAbsent(client, [fixture]) } catch (error) { errors.push(error) }
  throwFailures(errors, 'Owned disposition fixture cleanup failed')
  pendingCleanup.delete(fixture)
}

async function withFixture(body: (client: pg.Client, prisma: PrismaClient, fixture: Fixture) => Promise<void>) {
  const fixture = newFixture()
  const client = new pg.Client({ connectionString: URL })
  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: URL }) })
  const errors: unknown[] = []
  let connected = false
  try {
    await client.connect()
    connected = true
    await scaffold(client, fixture)
    await body(client, prisma, fixture)
  } catch (error) { errors.push(error) }
  try { await prisma.$disconnect() } catch (error) { errors.push(error) }
  if (connected) {
    try { await cleanupFixture(client, fixture) } catch (error) { errors.push(error) }
  }
  try { await client.end() } catch (error) { errors.push(error) }
  throwFailures(errors, 'Disposition test and fixture teardown failed')
}

async function withUnreadableDisposition(client: pg.Client, org: string, body: () => Promise<void>) {
  const errors: unknown[] = []
  let committed = false
  try {
    // The exclusive integration gate protects this existing legacy-state fixture. Failed
    // setup rolls back the constraint change as well as the deliberately invalid owned row.
    await transaction(client, async () => {
      await client.query('ALTER TABLE alert_rule_dispositions DROP CONSTRAINT alert_rule_dispositions_disposition_check')
      await client.query(
        `INSERT INTO alert_rule_dispositions (id, organization_id, alert_type_id, disposition, updated_at)
         VALUES (gen_random_uuid(), $1, $2, 'EMAIL', now())`, [org, LIVE])
      await client.query(
        `ALTER TABLE alert_rule_dispositions ADD CONSTRAINT alert_rule_dispositions_disposition_check
         CHECK (disposition IN ('ACT_NOW', 'ACT_TODAY', 'RECORD_ONLY')) NOT VALID`)
    })
    committed = true
    await body()
  } catch (error) { errors.push(error) }
  if (committed) {
    try {
      await client.query('DELETE FROM alert_rule_dispositions WHERE organization_id = $1 AND alert_type_id = $2',
        [org, LIVE])
    } catch (error) { errors.push(error) }
    try {
      await client.query('ALTER TABLE alert_rule_dispositions VALIDATE CONSTRAINT alert_rule_dispositions_disposition_check')
    } catch (error) { errors.push(error) }
  }
  throwFailures(errors, 'Legacy disposition assertion or constraint restoration failed')
}

const serviceFor = (prisma: PrismaClient) =>
  new AlertDispositionsService(prisma as unknown as PrismaService)

test('EVERY CATALOGUE TYPE IS LISTED, defaulting to the catalogue judgement', { skip: !RUN || !URL }, async () =>
  withFixture(async (_client, prisma, { identity: IDENTITY }) => {
    const { dispositions } = await serviceFor(prisma).list(IDENTITY)

    assert.equal(dispositions.length, ALERT_CATALOG.length, 'all seven, none hidden')

    // NOTHING IS SEEDED, so with no rows every type reports the catalogue's own judgement. The
    // default cannot drift from the tiering the catalogue states because it IS that tiering.
    for (const row of dispositions) {
      assert.equal(row.disposition, row.catalogueSeverity)
      assert.equal(row.storedValueIgnored, undefined)
    }

    // `mapped` IS BOTH HALVES: a producer wired to the type, AND this organisation holding
    // findings for it to carry. Nothing is seeded here, so nothing is fed, and NO row may claim a
    // working setting — including the two whose wiring is live.
    //
    // It asserted 2 before, which was true about the wiring and wrong about the reader's
    // question: an MSP reading those two rows was told their switch worked while the pipeline
    // behind it had never been handed a finding.
    assert.equal(dispositions.filter((row) => row.mapped).length, 0)
    assert.equal(dispositions.find((row) => row.alertTypeId === LIVE)?.mapped, false)

    // AND THE ZERO IS THE INPUT HALF BITING, not the catalogue having lost its producers. Without
    // this line the assertion above would pass just as happily if `reachOfAlertTypes` broke.
    assert.equal(dispositionIsConsulted(LIVE), true)

    // THE POSITIVE CASE — `mapped` flipping to true once a finding exists — is covered in
    // `alert-type-reach.test.ts`, not here, and deliberately. Seeding a finding needs a matched
    // result plus severity, confidence and coverage as non-null strings: a fixture this file does
    // not have, and one that would assert behaviour through three values invented to satisfy NOT
    // NULL. The derivation is pure and is tested there against real rule ids.
  }))

test('A WRITE IS STORED AND READ BACK, and the catalogue judgement stays visible beside it', { skip: !RUN || !URL }, async () =>
  withFixture(async (client, prisma, { org: ORG, user: USER, identity: IDENTITY }) => {
    const service = serviceFor(prisma)
    const before = (await service.list(IDENTITY)).dispositions.find((row) => row.alertTypeId === LIVE)
    assert.equal(before?.disposition, 'ACT_NOW', 'the control: it starts at the catalogue value')

    await service.set(IDENTITY, LIVE, { disposition: 'RECORD_ONLY' })
    const after = (await service.list(IDENTITY)).dispositions.find((row) => row.alertTypeId === LIVE)

    assert.equal(after?.disposition, 'RECORD_ONLY', 'the MSP has departed from the default')
    assert.equal(after?.catalogueSeverity, 'ACT_NOW', 'AND CAN SEE WHAT THEY DEPARTED FROM')

    // IT REACHES THE COLUMN THE PIPELINE READS, under the id the pipeline keys on. This is the
    // half that was silently broken when the column was named for a different vocabulary.
    const row = await client.query(
      'SELECT alert_type_id, disposition, set_by_user_id FROM alert_rule_dispositions WHERE organization_id = $1',
      [ORG])
    assert.equal(row.rowCount, 1)
    assert.equal(row.rows[0].alert_type_id, LIVE)
    assert.equal(row.rows[0].disposition, 'RECORD_ONLY')
    assert.equal(row.rows[0].set_by_user_id, USER, 'and who set it, so it can be asked about')

    // A SECOND WRITE UPDATES RATHER THAN DUPLICATING — the unique index is on the pair.
    await service.set(IDENTITY, LIVE, { disposition: 'ACT_TODAY' })
    assert.equal((await client.query(
      'SELECT count(*)::int AS n FROM alert_rule_dispositions WHERE organization_id = $1', [ORG]
    )).rows[0].n, 1)
  }))

test('THE WRITE REFUSES A VALUE OUTSIDE THE VOCABULARY, and writes nothing', { skip: !RUN || !URL }, async () =>
  withFixture(async (client, prisma, { org: ORG, identity: IDENTITY }) => {
    const service = serviceFor(prisma)

    // THE OLD VOCABULARY IS REFUSED, and it is the one somebody will try: it is what the column
    // held until this change, and it is still the right answer to a different question.
    await assert.rejects(() => service.set(IDENTITY, LIVE, { disposition: 'EMAIL' }), /must be one of/)
    await assert.rejects(() => service.set(IDENTITY, LIVE, { disposition: 'RING' }), /must be one of/)
    await assert.rejects(() => service.set(IDENTITY, LIVE, { disposition: 'OFF' }), /must be one of/)
    await assert.rejects(() => service.set(IDENTITY, LIVE, { disposition: 42 }), /must be one of/)
    await assert.rejects(() => service.set(IDENTITY, LIVE, {}), /must be one of/)

    // AND AN ALERT TYPE THE CATALOGUE DOES NOT DECLARE, including a rule id — the exact value
    // that was silently accepted and ignored before the column was renamed.
    await assert.rejects(
      () => service.set(IDENTITY, 'HV-ID-AUTH-010.v1', { disposition: 'RECORD_ONLY' }),
      /No alert type is declared/)

    assert.equal((await client.query(
      'SELECT count(*)::int AS n FROM alert_rule_dispositions WHERE organization_id = $1', [ORG]
    )).rows[0].n, 0, 'nothing was written by any of them')

    // NOT VACUOUS: a good write does go in, so the refusals above are about the values.
    await service.set(IDENTITY, LIVE, { disposition: 'ACT_TODAY' })
    assert.equal((await client.query(
      'SELECT count(*)::int AS n FROM alert_rule_dispositions WHERE organization_id = $1', [ORG]
    )).rows[0].n, 1)
  }))

test('AN UNREADABLE STORED VALUE IS REPORTED, never defaulted away', { skip: !RUN || !URL }, async () => {
  // A row the endpoint could not have written, but a hand, an older build or a half-run
  // migration could. The product WILL use the default — an unreadable value never reaches the
  // lookup — and saying so is true. What must not happen is the row looking like nobody chose.
  await withFixture(async (client, prisma, { org: ORG, identity: IDENTITY }) => {
    await withUnreadableDisposition(client, ORG, async () => {
      const row = (await serviceFor(prisma).list(IDENTITY)).dispositions
        .find((each) => each.alertTypeId === LIVE)

      assert.equal(row?.storedValueIgnored, 'EMAIL', 'THE SETTING SOMEBODY MADE IS VISIBLE')
      assert.equal(row?.disposition, 'ACT_NOW',
        'and what will actually happen is the catalogue default, stated as such')
    })
  })
})

test('A CALLER WHO IS NOT A MEMBER GETS NOTHING', { skip: !RUN || !URL }, async () =>
  withFixture(async (client, prisma, fixture) => {
    const { org: ORG, identity: IDENTITY } = fixture
    const service = serviceFor(prisma)

    // A real organisation this user is not in. Naming one that exists is the point — refusing an
    // id that does not exist proves nothing about membership.
    const other = fixture.foreignOrg
    await insertOrganization(client, fixture, other, fixture.foreignSlug)

    await assert.rejects(() => service.list(IDENTITY, other), /Workspace is not available/)
    await assert.rejects(
      () => service.set(IDENTITY, LIVE, { disposition: 'RECORD_ONLY' }, other),
      /Workspace is not available/)
    assert.equal((await client.query(
      'SELECT count(*)::int AS n FROM alert_rule_dispositions WHERE organization_id = $1', [other]
    )).rows[0].n, 0)

    // NOT VACUOUS: their own organisation works, so the refusal is about membership.
    assert.ok((await service.list(IDENTITY, ORG)).dispositions.length > 0)
  }))

test('OWNED FIXTURES REMAIN ISOLATED and cleanup preserves another live fixture', { skip: !RUN || !URL }, async () => {
  const fixtures: Fixture[] = []
  await withFixture(async (clientA, prismaA, fixtureA) => {
    fixtures.push(fixtureA)
    const serviceA = serviceFor(prismaA)
    await serviceA.set(fixtureA.identity, LIVE, { disposition: 'RECORD_ONLY' })

    await withFixture(async (clientB, prismaB, fixtureB) => {
      fixtures.push(fixtureB)
      assert.notEqual(fixtureA.org, fixtureB.org)
      assert.notEqual(fixtureA.user, fixtureB.user)
      assert.notEqual(fixtureA.identity.subject, fixtureB.identity.subject)
      const { dispositions } = await serviceFor(prismaB).list(fixtureB.identity)
      assert.equal(dispositions.length, ALERT_CATALOG.length)
      for (const row of dispositions) {
        assert.equal(row.disposition, row.catalogueSeverity)
        assert.equal(row.storedValueIgnored, undefined)
      }
      assert.equal(dispositions.filter((row) => row.mapped).length, 0)
      assert.equal((await clientB.query(
        'SELECT count(*)::int AS n FROM alert_rule_dispositions WHERE organization_id = $1', [fixtureB.org]
      )).rows[0].n, 0)
    })

    await assertOwnedRowsAbsent(clientA, [fixtures[1]!])
    const row = (await serviceA.list(fixtureA.identity)).dispositions.find((each) => each.alertTypeId === LIVE)
    assert.equal(row?.disposition, 'RECORD_ONLY', 'cleaning B must preserve A\'s real saved setting')
    assert.equal((await clientA.query(
      'SELECT count(*)::int AS n FROM memberships WHERE organization_id = $1 AND user_id = $2',
      [fixtureA.org, fixtureA.user]
    )).rows[0].n, 1, 'cleaning B must preserve A\'s membership')
  })
  assert.ok(gate)
  await assertOwnedRowsAbsent(gate, fixtures)
  // This disposition sentinel checks ownership, not the retained-finding contamination itself.
})
