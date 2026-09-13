import assert from 'node:assert/strict'
import test, { after, before } from 'node:test'
import pg from 'pg'
import { PrismaPg } from '@prisma/adapter-pg'
import { PrismaClient } from '../generated/prisma/client.js'
import type { PrismaService } from '../prisma/prisma.service.js'
import { AlertDispositionsService } from './alert-dispositions.service.js'
import { ALERT_CATALOG } from './alert-catalog.js'

/**
 * THE SETTINGS PAGE'S TWO ENDPOINTS, against a real database.
 *
 * The write matters more than the read: a settings page that accepts a value the pipeline will
 * never read is the defect the column rename closed — the row exists, the write succeeds, the MSP
 * sees their choice saved, and nothing changes.
 */

const RUN = process.env.HAWKVIEW_RUN_DATABASE_INTEGRATION_TESTS === '1'
const URL = process.env.DATABASE_URL

/**
 * ONE DATABASE, SO ONE FILE AT A TIME. See the identical block in the other alerting integration
 * files: `node --test` runs files in parallel, these truncate shared tables, and a session
 * advisory lock serialises them across processes where a CLI flag would not.
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
  await gate.query('SELECT pg_advisory_unlock($1)', [INTEGRATION_GATE])
  await gate.end()
  gate = null
})

const ORG = '11111111-1111-1111-1111-111111111111'
const USER = 'bbbbbbbb-0000-4000-8000-00000000b11b'
const SUBJECT = 'auth|dispositions-probe'
const IDENTITY = { subject: SUBJECT, email: 'dispositions-probe@an-msp.example' }
const LIVE = 'security.suspected_credential_attack'

async function scaffold(client: pg.Client) {
  await client.query(
    `INSERT INTO organizations (id, name, slug, created_at, updated_at)
     VALUES ($1, 'Probe', 'probe', now(), now()) ON CONFLICT (id) DO NOTHING`, [ORG])
  await client.query(
    `INSERT INTO users (id, email, auth_provider_user_id, updated_at)
     VALUES ($1, 'dispositions-probe@an-msp.example', $2, now())
     ON CONFLICT (id) DO UPDATE SET auth_provider_user_id = EXCLUDED.auth_provider_user_id,
                                    disabled_at = NULL`, [USER, SUBJECT])
  await client.query(
    `INSERT INTO memberships (id, user_id, organization_id, role, status, created_at, updated_at)
     VALUES (gen_random_uuid(), $1, $2, 'MSP_OWNER', 'ACTIVE', now(), now())
     ON CONFLICT (user_id, organization_id) DO NOTHING`, [USER, ORG])
  await client.query('DELETE FROM alert_rule_dispositions WHERE organization_id = $1', [ORG])
}

const serviceFor = (prisma: PrismaClient) =>
  new AlertDispositionsService(prisma as unknown as PrismaService)

test('EVERY CATALOGUE TYPE IS LISTED, defaulting to the catalogue judgement', { skip: !RUN || !URL }, async () => {
  const client = new pg.Client({ connectionString: URL })
  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: URL }) })
  await client.connect()
  try {
    await scaffold(client)
    const { dispositions } = await serviceFor(prisma).list(IDENTITY)

    assert.equal(dispositions.length, ALERT_CATALOG.length, 'all seven, none hidden')

    // NOTHING IS SEEDED, so with no rows every type reports the catalogue's own judgement. The
    // default cannot drift from the tiering the catalogue states because it IS that tiering.
    for (const row of dispositions) {
      assert.equal(row.disposition, row.catalogueSeverity)
      assert.equal(row.storedValueIgnored, undefined)
    }

    // `mapped` IS DERIVED, and today two of seven are consulted. A row that says a setting works
    // when it does not is worse than one saying nothing feeds it yet — the alerts arrive while
    // the switch says they should not.
    assert.equal(dispositions.filter((row) => row.mapped).length, 2)
    assert.equal(dispositions.find((row) => row.alertTypeId === LIVE)?.mapped, true)
  } finally {
    await prisma.$disconnect()
    await client.end()
  }
})

test('A WRITE IS STORED AND READ BACK, and the catalogue judgement stays visible beside it', { skip: !RUN || !URL }, async () => {
  const client = new pg.Client({ connectionString: URL })
  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: URL }) })
  await client.connect()
  try {
    await scaffold(client)
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
  } finally {
    await prisma.$disconnect()
    await client.end()
  }
})

test('THE WRITE REFUSES A VALUE OUTSIDE THE VOCABULARY, and writes nothing', { skip: !RUN || !URL }, async () => {
  const client = new pg.Client({ connectionString: URL })
  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: URL }) })
  await client.connect()
  try {
    await scaffold(client)
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
  } finally {
    await prisma.$disconnect()
    await client.end()
  }
})

test('AN UNREADABLE STORED VALUE IS REPORTED, never defaulted away', { skip: !RUN || !URL }, async () => {
  // A row the endpoint could not have written, but a hand, an older build or a half-run
  // migration could. The product WILL use the default — an unreadable value never reaches the
  // lookup — and saying so is true. What must not happen is the row looking like nobody chose.
  const client = new pg.Client({ connectionString: URL })
  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: URL }) })
  await client.connect()
  try {
    await scaffold(client)
    // The CHECK refuses it, so it is inserted with the constraint briefly dropped — which is the
    // only honest way to reproduce a state the database now prevents.
    await client.query('ALTER TABLE alert_rule_dispositions DROP CONSTRAINT alert_rule_dispositions_disposition_check')
    await client.query(
      `INSERT INTO alert_rule_dispositions (id, organization_id, alert_type_id, disposition, updated_at)
       VALUES (gen_random_uuid(), $1, $2, 'EMAIL', now())`, [ORG, LIVE])
    await client.query(
      `ALTER TABLE alert_rule_dispositions ADD CONSTRAINT alert_rule_dispositions_disposition_check
       CHECK (disposition IN ('ACT_NOW', 'ACT_TODAY', 'RECORD_ONLY'))
       NOT VALID`)

    const row = (await serviceFor(prisma).list(IDENTITY)).dispositions
      .find((each) => each.alertTypeId === LIVE)

    assert.equal(row?.storedValueIgnored, 'EMAIL', 'THE SETTING SOMEBODY MADE IS VISIBLE')
    assert.equal(row?.disposition, 'ACT_NOW',
      'and what will actually happen is the catalogue default, stated as such')
  } finally {
    await client.query(
      'ALTER TABLE alert_rule_dispositions VALIDATE CONSTRAINT alert_rule_dispositions_disposition_check')
      .catch(() => undefined)
    await prisma.$disconnect()
    await client.end()
  }
})

test('A CALLER WHO IS NOT A MEMBER GETS NOTHING', { skip: !RUN || !URL }, async () => {
  const client = new pg.Client({ connectionString: URL })
  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: URL }) })
  await client.connect()
  try {
    await scaffold(client)
    const service = serviceFor(prisma)

    // A real organisation this user is not in. Naming one that exists is the point — refusing an
    // id that does not exist proves nothing about membership.
    const other = '99999999-0000-4000-8000-000000009999'
    await client.query(
      `INSERT INTO organizations (id, name, slug, created_at, updated_at)
       VALUES ($1, 'Somebody Else', 'somebody-else', now(), now()) ON CONFLICT (id) DO NOTHING`, [other])

    await assert.rejects(() => service.list(IDENTITY, other), /Workspace is not available/)
    await assert.rejects(
      () => service.set(IDENTITY, LIVE, { disposition: 'RECORD_ONLY' }, other),
      /Workspace is not available/)
    assert.equal((await client.query(
      'SELECT count(*)::int AS n FROM alert_rule_dispositions WHERE organization_id = $1', [other]
    )).rows[0].n, 0)

    // NOT VACUOUS: their own organisation works, so the refusal is about membership.
    assert.ok((await service.list(IDENTITY, ORG)).dispositions.length > 0)
  } finally {
    await prisma.$disconnect()
    await client.end()
  }
})
