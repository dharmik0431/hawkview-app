import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { assertDisposableTestDatabase } from '../prisma/native-alert-test-database.js'
import test, { after, before } from 'node:test'
import pg from 'pg'
import { PrismaPg } from '@prisma/adapter-pg'
import { PrismaClient, type Prisma } from '../generated/prisma/client.js'
import type { PrismaService } from '../prisma/prisma.service.js'
import { AlertDispositionsService } from './alert-dispositions.service.js'
import { ALERT_CATALOG } from './alert-catalog.js'
import { dispositionIsConsulted } from './alert-type-reach.js'
import { NotificationsService } from '../notifications/notifications.service.js'
import { emailNotificationVisible } from './email-release.js'
import { EmailReleaseStore, type EmailClaim } from './email-release-store.js'
import { incidentGrouping } from './alert-incident-key.js'
import type { SqlRunner } from './pipeline-store.js'

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
  emailJobs: string[]
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
    emailJobs: [],
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
  // Email jobs have no organization FK. Delete only successful inserts owned by this fixture.
  for (const messageId of fixture.emailJobs) {
    try {
      await client.query('DELETE FROM alert_email_envelopes WHERE message_id = $1', [messageId])
      await client.query('DELETE FROM alert_send_jobs WHERE message_id = $1', [messageId])
    } catch (error) { errors.push(error) }
  }
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


const preferencesFor = (prisma: PrismaClient) => new NotificationsService(prisma as unknown as PrismaService)
const ROLES = ['MSP_OWNER', 'MSP_ADMIN', 'MSP_TECHNICIAN', 'MSP_VIEWER'] as const

test('workspace policy is owner-only; personal preferences are available to every active role', { skip: !RUN || !URL }, async () =>
  withFixture(async (client, prisma, fixture) => {
    const policy = serviceFor(prisma)
    const personal = preferencesFor(prisma)
    const initial = await personal.preferences(fixture.identity, fixture.org)
    assert.equal(initial.minimumSeverity, 'info')
    assert.equal(initial.digestMode, 'off')
    assert.equal(initial.emailEnabled, false)
    assert.equal(initial.inAppEnabled, true)
    for (const role of ROLES) {
      await client.query('UPDATE memberships SET role = $3::"MembershipRole" WHERE organization_id = $1 AND user_id = $2',
        [fixture.org, fixture.user, role])
      const result = await policy.list(fixture.identity, fixture.org)
      const credential = result.dispositions.find(row => row.alertTypeId === LIVE)!
      assert.equal(result.canManagePolicy, role === 'MSP_OWNER')
      assert.equal(credential.mapped, false)
      assert.equal(credential.capability.observedInput, 'NO_OPEN_FINDING')
      assert.equal(credential.capability.editable, role === 'MSP_OWNER')
      if (role === 'MSP_OWNER') await policy.set(fixture.identity, LIVE, { disposition: 'ACT_TODAY' }, fixture.org)
      else await assert.rejects(policy.set(fixture.identity, LIVE, { disposition: 'RECORD_ONLY' }, fixture.org), /Only MSP_OWNER/)
      const preference = await personal.updatePreferences(fixture.identity, { organizationId: fixture.org, emailEnabled: true })
      assert.equal(preference.emailEnabled, true)
      assert.equal(preference.canManagePolicy, role === 'MSP_OWNER')
    }
    await client.query('UPDATE memberships SET role = \'MSP_OWNER\' WHERE organization_id = $1', [fixture.org])
    for (const type of ALERT_CATALOG.filter(type => type.id !== LIVE)) {
      await client.query(`INSERT INTO alert_rule_dispositions (id, organization_id, alert_type_id, disposition, updated_at)
        VALUES (gen_random_uuid(), $1, $2, 'RECORD_ONLY', now())`, [fixture.org, type.id])
      await assert.rejects(policy.set(fixture.identity, type.id, { disposition: 'ACT_NOW' }, fixture.org), /established producer/)
      const stored = await prisma.alertRuleDisposition.findUnique({
        where: { organizationId_alertTypeId: { organizationId: fixture.org, alertTypeId: type.id } },
      })
      assert.equal(stored?.disposition, 'RECORD_ONLY', 'unsupported stored policies remain untouched')
    }
  }))

test('selected organization is required when ambiguous; inactive and foreign scopes never write', { skip: !RUN || !URL }, async () =>
  withFixture(async (client, prisma, fixture) => {
    await insertOrganization(client, fixture, fixture.foreignOrg, fixture.foreignSlug)
    const policy = serviceFor(prisma)
    const personal = preferencesFor(prisma)
    await assert.rejects(personal.preferences(fixture.identity, fixture.foreignOrg), /Workspace is not available/)
    await assert.rejects(personal.updatePreferences(fixture.identity, { organizationId: fixture.foreignOrg, emailEnabled: true }), /Workspace is not available/)
    await client.query(`INSERT INTO memberships (id, user_id, organization_id, role, status, updated_at)
      VALUES (gen_random_uuid(), $1, $2, 'MSP_OWNER', 'ACTIVE', now())`, [fixture.user, fixture.foreignOrg])
    await assert.rejects(policy.list(fixture.identity), /explicit organizationId/)
    await assert.rejects(policy.set(fixture.identity, LIVE, { disposition: 'ACT_TODAY' }), /explicit organizationId/)
    await assert.rejects(personal.preferences(fixture.identity), /explicit organizationId/)
    await assert.rejects(personal.updatePreferences(fixture.identity, { emailEnabled: true }), /explicit organizationId/)
    for (const organizationId of [fixture.org, fixture.foreignOrg]) {
      assert.equal((await policy.list(fixture.identity, organizationId)).organizationId, organizationId)
      assert.equal((await personal.preferences(fixture.identity, organizationId)).organizationId, organizationId)
    }
    await client.query("UPDATE memberships SET status = 'SUSPENDED' WHERE organization_id = $1", [fixture.foreignOrg])
    for (const role of ROLES) {
      await client.query('UPDATE memberships SET role = $2::"MembershipRole" WHERE organization_id = $1', [fixture.foreignOrg, role])
      await assert.rejects(policy.list(fixture.identity, fixture.foreignOrg), /Workspace is not available/)
      await assert.rejects(personal.preferences(fixture.identity, fixture.foreignOrg), /Workspace is not available/)
      await assert.rejects(policy.set(fixture.identity, LIVE, { disposition: 'ACT_NOW' }, fixture.foreignOrg), /Workspace is not available/)
      await assert.rejects(personal.updatePreferences(fixture.identity, { organizationId: fixture.foreignOrg, emailEnabled: true }), /Workspace is not available/)
    }
    assert.equal((await personal.preferences(fixture.identity)).organizationId, fixture.org, 'single active legacy scope remains compatible')
    await client.query("UPDATE memberships SET status = 'ACTIVE' WHERE organization_id = $1", [fixture.foreignOrg])
    await client.query("UPDATE organizations SET status = 'SUSPENDED' WHERE id = $1", [fixture.foreignOrg])
    await assert.rejects(policy.list(fixture.identity, fixture.foreignOrg), /Workspace is not available/)
    await assert.rejects(personal.updatePreferences(fixture.identity, { organizationId: fixture.foreignOrg, emailEnabled: true }), /Workspace is not available/)
  }))

test('both mutations recheck revocation after context read and immediately before the write', { skip: !RUN || !URL }, async () => {
  for (const target of ['policy', 'personal']) {
    for (const revoke of ['membership', 'organization', 'disabled', ...(target === 'policy' ? ['role'] : [])]) {
      await withFixture(async (client, prisma, fixture) => {
        await preferencesFor(prisma).preferences(fixture.identity, fixture.org)
        await serviceFor(prisma).list(fixture.identity, fixture.org)
        const wrapped = {
          user: prisma.user,
          $transaction: async (body: any) => {
            if (revoke === 'membership') await client.query("UPDATE memberships SET status = 'SUSPENDED' WHERE organization_id = $1", [fixture.org])
            if (revoke === 'organization') await client.query("UPDATE organizations SET status = 'SUSPENDED' WHERE id = $1", [fixture.org])
            if (revoke === 'disabled') await client.query('UPDATE users SET disabled_at = now() WHERE id = $1', [fixture.user])
            if (revoke === 'role') await client.query("UPDATE memberships SET role = 'MSP_ADMIN' WHERE organization_id = $1", [fixture.org])
            return prisma.$transaction(body)
          },
        } as unknown as PrismaService
        const action = target === 'policy'
          ? new AlertDispositionsService(wrapped).set(fixture.identity, LIVE, { disposition: 'RECORD_ONLY' }, fixture.org)
          : new NotificationsService(wrapped).updatePreferences(fixture.identity, { organizationId: fixture.org, emailEnabled: true })
        await assert.rejects(action, /not available|no longer available/, target + ':' + revoke)
        assert.equal((await prisma.notificationPreference.findUnique({
          where: { userId_organizationId: { userId: fixture.user, organizationId: fixture.org } },
        }))?.emailEnabled, false)
        assert.equal(await prisma.alertRuleDisposition.count({ where: { organizationId: fixture.org } }), 0)
      })
    }
  }
})

test('policy read failure propagates instead of presenting healthy default controls', { skip: !RUN || !URL }, async () =>
  withFixture(async (_client, prisma, fixture) => {
    const failing = new AlertDispositionsService({
      user: prisma.user, alertRuleDisposition: prisma.alertRuleDisposition,
      identityRiskFinding: { findMany: async () => { throw new Error('synthetic input read unavailable') } },
    } as unknown as PrismaService)
    await assert.rejects(failing.list(fixture.identity, fixture.org), /input read unavailable/)
  }))

function runnerForPreferences(client: pg.Client): SqlRunner {
  const runner: SqlRunner = {
    query: async (sql, params) => (await client.query(sql, [...params])).rows,
    execute: async (sql, params) => (await client.query(sql, [...params])).rowCount ?? 0,
    transaction: async body => {
      await client.query('BEGIN')
      try {
        const result = await body(runner)
        await client.query('COMMIT')
        return result
      } catch (error) { await client.query('ROLLBACK'); throw error }
    },
  }
  return runner
}

async function emailEligibilityFixture(client: pg.Client, prisma: PrismaClient, fixture: Fixture) {
  const tenant = await prisma.customerTenant.create({ data: {
    organizationId: fixture.org, microsoftTenantId: randomUUID(),
    displayName: 'Synthetic preferences tenant', primaryDomain: 'preferences.example.test', status: 'ACTIVE',
  } })
  const grouping = incidentGrouping({ id: LIVE, subject: 'ACCOUNT' },
    { organizationId: fixture.org, customerTenantId: tenant.id },
    { resolved: true, id: 'subject:' + randomUUID() })
  assert.ok(grouping.groups)
  const incidentKey = grouping.key
  const messageId = 'incident/' + fixture.org + '|' + incidentKey
  const by = 'preferences/' + randomUUID()
  const key = 'hv-email-v1-' + randomUUID()
  await prisma.notificationPreference.create({ data: {
    userId: fixture.user, organizationId: fixture.org, emailEnabled: true, securityEnabled: true,
    minimumSeverity: 'info', digestMode: 'off',
  } })
  await client.query(`INSERT INTO alert_incidents
    (id, organization_id, incident_key, alert_type_id, ownership, condition, investigation,
     ownership_at, condition_at, investigation_at, updated_at)
    VALUES (gen_random_uuid(), $1, $2, $3, 'UNACKNOWLEDGED', 'ACTIVE', 'OPEN', now(), now(), now(), now())`,
  [fixture.org, incidentKey, LIVE])
  const notification = await prisma.notification.create({ data: {
    organizationId: fixture.org, customerTenantId: tenant.id,
    eventType: 'security.preferences_test', category: 'warning',
    severity: 'info', title: 'Synthetic preferences fixture', description: 'Synthetic source-only regression',
    dedupeKey: incidentKey, source: 'preferences-test', alertTypeId: LIVE, incidentKey,
  } })
  await client.query(`INSERT INTO alert_send_jobs
    (id, message_id, idempotency_key, state, attempts_made, max_attempts, not_before_at,
     claimed_by, claimed_at, claim_expires_at, updated_at)
    VALUES (gen_random_uuid(), $1, $2, 'CLAIMED', 1, 3, now(), $3, now(), now() + interval '5 minutes', now())`,
  [messageId, key, by])
  fixture.emailJobs.push(messageId)
  await client.query(`INSERT INTO alert_email_envelopes
    (message_id, activation_id, organization_id, owner_user_id, recipient_hash, starts_at, expires_at,
     from_address, app_origin, recipient_address, verified_at, payload, idempotency_key)
    VALUES ($1, $2, $3, $4, $5, now() - interval '1 minute', now() + interval '5 minutes',
      'alerts@example.test', 'https://console.hawkviewapp.com', $6, now(), '{}', $7)`,
  [messageId, randomUUID(), fixture.org, fixture.user, 'a'.repeat(64), fixture.identity.email, key])
  // Only gate methods are invoked. There is no provider, activation, claim, or send call.
  const claim = { by, config: { organizationId: fixture.org, ownerUserId: fixture.user }, job: {
    messageId, idempotencyKey: key, state: 'CLAIMED', attemptsMade: 0, maxAttempts: 3,
    notBeforeIso: new Date().toISOString(), claim: null, providerId: null,
  } } as EmailClaim
  const envelope = { key, recipient: fixture.identity.email, payload: '{}' }
  const runner = runnerForPreferences(client)
  const store = new EmailReleaseStore(runner)
  return {
    notification, store, claim, envelope,
    initial: () => emailNotificationVisible(runner, fixture.org, incidentKey, fixture.user),
    final: () => store.maySend(claim, envelope, LIVE, 'ACT_NOW'),
  }
}

test('all 25 severity/threshold pairs run through BOTH actual PostgreSQL email eligibility gates', { skip: !RUN || !URL }, async () =>
  withFixture(async (client, prisma, fixture) => {
    const gates = await emailEligibilityFixture(client, prisma, fixture)
    const severities = ['info', 'low', 'medium', 'high', 'critical']
    for (const [rank, severity] of severities.entries()) {
      await client.query('UPDATE notifications SET severity = $2 WHERE id = $1', [gates.notification.id, severity])
      for (const [minimumRank, minimum] of severities.entries()) {
        await client.query('UPDATE notification_preferences SET minimum_severity = $3 WHERE organization_id = $1 AND user_id = $2',
          [fixture.org, fixture.user, minimum])
        assert.equal(await gates.initial(), rank >= minimumRank, 'initial ' + severity + '/' + minimum)
        assert.equal(await gates.final(), rank >= minimumRank, 'final ' + severity + '/' + minimum)
      }
    }
    for (const [severity, disposition] of [['high', 'ACT_TODAY'], ['critical', 'ACT_NOW']]) {
      await serviceFor(prisma).set(fixture.identity, LIVE, { disposition }, fixture.org)
      await client.query('UPDATE notifications SET severity = $2 WHERE id = $1', [gates.notification.id, severity])
      await client.query('UPDATE notification_preferences SET minimum_severity = $3 WHERE organization_id = $1 AND user_id = $2',
        [fixture.org, fixture.user, severity])
      assert.equal(await gates.initial(), true)
      assert.equal(await gates.final(), true)
    }
    // The disposable-only NULL probe runs serially under the integration gate. Rollback restores
    // constraints AND fixture values; no migration or application schema is changed.
    await client.query('BEGIN')
    try {
      await client.query('ALTER TABLE notifications ALTER COLUMN severity DROP NOT NULL')
      await client.query('ALTER TABLE notification_preferences ALTER COLUMN minimum_severity DROP NOT NULL')
      for (const invalid of [null, 'unknown', 'warning', 'error', 'ACT_NOW']) {
        for (const badColumn of ['severity', 'minimum']) {
          await client.query('UPDATE notifications SET severity = $2 WHERE id = $1',
            [gates.notification.id, badColumn === 'severity' ? invalid : 'critical'])
          await client.query('UPDATE notification_preferences SET minimum_severity = $3 WHERE organization_id = $1 AND user_id = $2',
            [fixture.org, fixture.user, badColumn === 'minimum' ? invalid : 'info'])
          assert.equal(await gates.initial(), false, 'initial invalid ' + badColumn + ':' + invalid)
          assert.equal(await gates.final(), false, 'final invalid ' + badColumn + ':' + invalid)
        }
      }
    } finally { await client.query('ROLLBACK') }
    const nullable = await client.query(`SELECT table_name, is_nullable FROM information_schema.columns
      WHERE table_schema = 'public' AND ((table_name = 'notifications' AND column_name = 'severity')
        OR (table_name = 'notification_preferences' AND column_name = 'minimum_severity')) ORDER BY table_name`)
    assert.equal(nullable.rows.length, 2)
    assert.ok(nullable.rows.every(row => row.is_nullable === 'NO'), 'NULL probe restores both NOT NULL constraints')
    assert.equal(await gates.final(), true, 'rollback restores a valid, eligible boundary')
    for (const [deny, restore, params] of [
      ["UPDATE notification_preferences SET email_enabled = false WHERE organization_id = $1", "UPDATE notification_preferences SET email_enabled = true WHERE organization_id = $1", [fixture.org]],
      ["UPDATE notification_preferences SET security_enabled = false WHERE organization_id = $1", "UPDATE notification_preferences SET security_enabled = true WHERE organization_id = $1", [fixture.org]],
      ["UPDATE notification_preferences SET digest_mode = 'daily' WHERE organization_id = $1", "UPDATE notification_preferences SET digest_mode = 'off' WHERE organization_id = $1", [fixture.org]],
      ["UPDATE users SET disabled_at = now() WHERE id = $1", "UPDATE users SET disabled_at = NULL WHERE id = $1", [fixture.user]],
      ["UPDATE memberships SET role = 'MSP_ADMIN' WHERE organization_id = $1", "UPDATE memberships SET role = 'MSP_OWNER' WHERE organization_id = $1", [fixture.org]],
      ["UPDATE memberships SET status = 'SUSPENDED' WHERE organization_id = $1", "UPDATE memberships SET status = 'ACTIVE' WHERE organization_id = $1", [fixture.org]],
      ["UPDATE organizations SET status = 'SUSPENDED' WHERE id = $1", "UPDATE organizations SET status = 'ACTIVE' WHERE id = $1", [fixture.org]],
      ["UPDATE alert_rule_dispositions SET disposition = 'RECORD_ONLY' WHERE organization_id = $1", "UPDATE alert_rule_dispositions SET disposition = 'ACT_NOW' WHERE organization_id = $1", [fixture.org]],
    ] as const) {
      await client.query(deny, [...params])
      assert.equal(await gates.final(), false, deny)
      await client.query(restore, [...params])
      assert.equal(await gates.final(), true, restore)
    }
  }))

test('critical in-app override never bypasses user or organization scope; preferences do not stop publication', { skip: !RUN || !URL }, async () =>
  withFixture(async (_client, prisma, fixture) => {
    await withFixture(async (_otherClient, _otherPrisma, other) => {
      const personal = preferencesFor(prisma)
      await personal.updatePreferences(fixture.identity, { organizationId: fixture.org, inAppEnabled: false, securityEnabled: false, emailEnabled: false })
      const make = (organizationId: string, severity: string, recipientUserId?: string) => prisma.notification.create({ data: {
        organizationId, severity, recipientUserId, eventType: 'security.preferences_test', category: 'warning',
        title: 'Synthetic visibility fixture', description: 'Synthetic only', dedupeKey: randomUUID(), source: 'preferences-test',
      } })
      const ownCritical = await make(fixture.org, 'critical')
      await make(fixture.org, 'high')
      await make(fixture.org, 'critical', other.user)
      await make(other.org, 'critical')
      const result = await personal.list(fixture.identity)
      assert.deepEqual(result.items.map(item => item.id), [ownCritical.id])
      assert.equal(result.total, 1)
      const published = await personal.publishIncident({
        organizationId: fixture.org, eventType: 'security.preferences_test', category: 'warning', severity: 'high',
        title: 'Synthetic collected event', description: 'Delivery preferences are not collection controls',
        dedupeKey: randomUUID(), source: 'preferences-test',
      })
      assert.ok(published, 'OFF does not stop event publication')
      assert.equal((await personal.list(fixture.identity)).total, 1)
      await prisma.notificationPreference.update({
        where: { userId_organizationId: { userId: fixture.user, organizationId: fixture.org } },
        data: { inAppEnabled: true, securityEnabled: true, minimumSeverity: 'unknown' },
      })
      assert.deepEqual((await personal.list(fixture.identity)).items.map(item => item.id), [ownCritical.id])
      await prisma.membership.update({
        where: { userId_organizationId: { userId: fixture.user, organizationId: fixture.org } }, data: { status: 'SUSPENDED' },
      })
      assert.equal((await personal.list(fixture.identity)).total, 0)
      await prisma.user.update({ where: { id: fixture.user }, data: { disabledAt: new Date() } })
      await assert.rejects(personal.list(fixture.identity), /cannot access notifications/)
    })
  }))


function preferenceBarrier<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(complete => { resolve = complete })
  return { promise, resolve }
}

test('authorization locks order concurrent revocation AFTER the actual service mutation', { skip: !RUN || !URL }, async t => {
  for (const target of ['policy', 'personal'] as const) {
    for (const revoke of ['membership', 'organization', 'disabled', ...(target === 'policy' ? ['role'] : [])]) {
      await t.test(target + ':' + revoke, async () => withFixture(async (client, prisma, fixture) => {
        await preferencesFor(prisma).preferences(fixture.identity, fixture.org)
        if (target === 'policy') {
          await serviceFor(prisma).set(fixture.identity, LIVE, { disposition: 'ACT_NOW' }, fixture.org)
        }
        const revokerPid = Number((await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid)
        const locked = preferenceBarrier<Prisma.TransactionClient>()
        const resume = preferenceBarrier<void>()
        const wrapped = {
          user: prisma.user,
          alertRuleDisposition: prisma.alertRuleDisposition,
          identityRiskFinding: prisma.identityRiskFinding,
          $transaction: (body: (tx: Prisma.TransactionClient) => Promise<unknown>) =>
            prisma.$transaction(async tx => body(new Proxy(tx, {
              get(database, property, receiver) {
                if (property === '$queryRaw') {
                  return async (query: TemplateStringsArray, ...values: unknown[]) => {
                    // Execute the REAL service authorization SELECT before introducing the barrier.
                    const rows = await database.$queryRaw(query, ...values)
                    locked.resolve(database)
                    await resume.promise
                    return rows
                  }
                }
                return Reflect.get(database, property, receiver)
              },
            })), { maxWait: 5_000, timeout: 15_000 }),
        } as unknown as PrismaService
        await client.query('BEGIN')
        let committed = false
        let mutation: Promise<unknown> | undefined
        let revocation: Promise<unknown> | undefined
        let revocationFinished = false
        try {
          await client.query("SET LOCAL lock_timeout = '10s'")
          mutation = target === 'policy'
            ? new AlertDispositionsService(wrapped).set(fixture.identity, LIVE, { disposition: 'RECORD_ONLY' }, fixture.org)
            : new NotificationsService(wrapped).updatePreferences(fixture.identity, { organizationId: fixture.org, emailEnabled: true })
          const held = await Promise.race([
            locked.promise,
            mutation.then(() => { throw new Error('Mutation finished without the authorization barrier.') }),
          ])
          const statement = revoke === 'membership'
            ? ["UPDATE memberships SET status = 'SUSPENDED' WHERE organization_id = $1 AND user_id = $2", [fixture.org, fixture.user]] as const
            : revoke === 'organization'
              ? ["UPDATE organizations SET status = 'SUSPENDED' WHERE id = $1", [fixture.org]] as const
              : revoke === 'disabled'
                ? ['UPDATE users SET disabled_at = now() WHERE id = $1', [fixture.user]] as const
                : ["UPDATE memberships SET role = 'MSP_ADMIN' WHERE organization_id = $1 AND user_id = $2", [fixture.org, fixture.user]] as const
          revocation = client.query(statement[0], [...statement[1]]).then(
            result => { revocationFinished = true; return result },
            error => { revocationFinished = true; throw error },
          )
          // Handle any failure immediately; the same promise is still asserted below.
          void revocation.catch(() => {})
          const deadline = Date.now() + 5_000
          for (;;) {
            // Observe from the already-held service connection: exactly two DB connections.
            // Refresh PostgreSQL's per-transaction statistics snapshot before each observation.
            await held.$executeRaw`SELECT pg_stat_clear_snapshot()`
            const activity = await held.$queryRaw<{ wait_event_type: string | null }[]>`
              SELECT wait_event_type FROM pg_stat_activity WHERE pid = ${revokerPid}`
            if (activity[0]?.wait_event_type === 'Lock') break
            assert.equal(revocationFinished, false, 'revocation must not escape the authorization locks')
            assert.ok(Date.now() < deadline, 'revoker must reach an observable PostgreSQL lock wait')
            await new Promise(resolve => setTimeout(resolve, 10))
          }
          assert.equal(revocationFinished, false, 'revocation is blocked while the service holds FOR SHARE')
          resume.resolve(undefined)
          await mutation
          await revocation
          // Revocation has acquired its row lock, but has not committed yet. Seeing the changed
          // setting from this other connection proves the mutation committed BEFORE it unblocked.
          if (target === 'policy') {
            const saved = await client.query(
              'SELECT disposition FROM alert_rule_dispositions WHERE organization_id = $1 AND alert_type_id = $2',
              [fixture.org, LIVE])
            assert.equal(saved.rows[0]?.disposition, 'RECORD_ONLY')
          } else {
            const saved = await client.query(
              'SELECT email_enabled FROM notification_preferences WHERE organization_id = $1 AND user_id = $2',
              [fixture.org, fixture.user])
            assert.equal(saved.rows[0]?.email_enabled, true)
          }
          await client.query('COMMIT')
          committed = true
          // Once revocation wins, a subsequent mutation cannot reuse the earlier grant.
          if (target === 'policy') {
            await assert.rejects(serviceFor(prisma).set(fixture.identity, LIVE, { disposition: 'ACT_NOW' }, fixture.org),
              /Only MSP_OWNER|Workspace is not available|cannot access alert settings/)
          } else {
            await assert.rejects(preferencesFor(prisma).updatePreferences(fixture.identity, { organizationId: fixture.org, emailEnabled: false }),
              /Workspace is not available|cannot access notifications/)
          }
        } finally {
          resume.resolve(undefined)
          await mutation?.catch(() => {})
          await revocation?.catch(() => {})
          if (!committed) await client.query('ROLLBACK')
        }
      }))
    }
  }
})
