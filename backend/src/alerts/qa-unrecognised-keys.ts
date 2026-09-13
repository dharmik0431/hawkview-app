// QA — a saved setting with no row to appear on, checked AT BOTH ENDS.
//
// The finding was that "reported, never defaulted" held where the stored VALUE was unreadable and
// failed where the stored KEY was: a row whose `alert_type_id` is a risk rule id — exactly what
// this column held before the rename — was invisible to the endpoint, which walks the catalogue
// and never looks at it, and was collected by the store into `Dispositions.unreadable` and then
// dropped, because `IntakeReport` had no field for it.
//
// A FIX TO ONE END IS NOT A FIX. The endpoint is where somebody sees their setting; the tick is
// where it is decided whether an email goes. So both are driven here, over the same database, in
// the same run.
//
// AND A REPORT THAT NAMES A KEY IS SATISFIED BY A CONSTANT. So the key is varied between runs and
// the output has to follow it, a run with no such row has to name NOTHING rather than something
// empty, and a valid row has to appear in neither list.
import { Module } from '@nestjs/common'
import { NestFactory } from '@nestjs/core'
import { createServer, request as httpRequest } from 'node:http'
import { exportJWK, generateKeyPair, SignJWT, type JWK } from 'jose'
import pg from 'pg'
import { AppModule } from '../app.module.js'
import { HAWKVIEW_NEST_OPTIONS } from '../bootstrap-options.js'
import { runIntake, type PipelineStore, type Watermark } from './finding-pipeline.js'
import { pipelineStore, type SqlRunner } from './pipeline-store.js'

const URL_ENV = process.env.DATABASE_URL
if (URL_ENV === undefined || !/hvukeys/.test(URL_ENV)) {
  throw new Error('refusing to run against a database that is not the disposable one (hvukeys)')
}

const ORG = '11111111-1111-1111-1111-111111111111'
const TENANT = '22222222-2222-2222-2222-222222222222'
const USER = '77777777-7777-7777-7777-777777777777'
const SUBJECT = '88888888-8888-4888-8888-888888888888'
const T0 = '2026-09-12T09:00:00.000Z'
const GOOD_TYPE = 'security.suspected_credential_attack'
const RULE = 'HV-ID-AUTH-001.v1'
const WATERMARK: Watermark = { sendNothingObservedBeforeIso: '2026-09-12T00:00:00.000Z', because: 'qa' }

const inTx = (c: pg.Client): SqlRunner => ({
  query: async <T>(sql: string, p: readonly unknown[]) => (await c.query(sql, [...p])).rows as T[],
  execute: async (sql: string, p: readonly unknown[]) => (await c.query(sql, [...p])).rowCount ?? 0,
  transaction: (run) => run(inTx(c)),
})
const runnerFor = (c: pg.Client): SqlRunner => ({
  query: async <T>(sql: string, p: readonly unknown[]) => (await c.query(sql, [...p])).rows as T[],
  execute: async (sql: string, p: readonly unknown[]) => (await c.query(sql, [...p])).rowCount ?? 0,
  transaction: async (run) => {
    await c.query('BEGIN')
    try { const r = await run(inTx(c)); await c.query('COMMIT'); return r }
    catch (e) { await c.query('ROLLBACK'); throw e }
  },
})
const storeFor = (c: pg.Client): PipelineStore => pipelineStore(runnerFor(c))

async function identityProvider() {
  const { publicKey, privateKey } = await generateKeyPair('RS256', { extractable: true })
  const jwk: JWK = { ...(await exportJWK(publicKey)), kid: 'qa', alg: 'RS256', use: 'sig' }
  const server = createServer((req, res) => {
    if (req.url === '/auth/v1/.well-known/jwks.json') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ keys: [jwk] }))
      return
    }
    res.writeHead(404).end()
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const base = 'http://127.0.0.1:' + (server.address() as { port: number }).port
  const token = () => new SignJWT({
    email: 'operator@an-msp.example', aal: 'aal2', role: 'authenticated', is_anonymous: false,
    session_id: '99999999-9999-4999-8999-999999999999',
  }).setProtectedHeader({ alg: 'RS256', kid: 'qa' })
    .setIssuer(base + '/auth/v1').setAudience('authenticated').setSubject(SUBJECT)
    .setIssuedAt().setExpirationTime('10m').sign(privateKey)
  return { base, token, close: () => new Promise<void>((r) => server.close(() => r())) }
}

type Wire = { status: number; body: { dispositions?: { alertTypeId: string; storedValueIgnored?: string }[]; unrecognisedKeys?: string[] } }
function get(port: number, path: string, headers: Record<string, string>): Promise<Wire> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, path, method: 'GET', headers }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (c: Buffer) => chunks.push(c))
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        try { resolve({ status: res.statusCode ?? 0, body: JSON.parse(text) }) }
        catch { resolve({ status: res.statusCode ?? 0, body: {} }) }
      })
    })
    req.on('error', reject)
    req.end()
  })
}

async function scaffold(c: pg.Client) {
  await c.query(`INSERT INTO organizations (id,name,slug,created_at,updated_at)
    VALUES ($1,'Probe','probe',now(),now()) ON CONFLICT (id) DO NOTHING`, [ORG])
  await c.query(`INSERT INTO customer_tenants (id,organization_id,microsoft_tenant_id,display_name,created_at,updated_at)
    VALUES ($1,$2,'99999999-9999-9999-9999-999999999999','T',now(),now()) ON CONFLICT (id) DO NOTHING`, [TENANT, ORG])
  await c.query(`INSERT INTO users (id,auth_provider_user_id,email,updated_at)
    VALUES ($1,$2,'operator@an-msp.example',now())
    ON CONFLICT (id) DO UPDATE SET auth_provider_user_id = EXCLUDED.auth_provider_user_id`, [USER, SUBJECT])
  await c.query(`INSERT INTO memberships (id,user_id,organization_id,role,status,updated_at)
    VALUES (gen_random_uuid(),$1,$2,'MSP_OWNER','ACTIVE',now()) ON CONFLICT DO NOTHING`, [USER, ORG])
  await c.query(`INSERT INTO notification_preferences (id,user_id,organization_id,email_enabled,updated_at)
    VALUES (gen_random_uuid(),$1,$2,true,now()) ON CONFLICT DO NOTHING`, [USER, ORG])
}

async function seedFinding(c: pg.Client) {
  await c.query('TRUNCATE alert_send_jobs, alert_incidents, notifications CASCADE')
  await c.query('DELETE FROM identity_risk_findings')
  const runId = '33333333-3333-3333-3333-333333333333'
  const matched = '44444444-4444-4444-4444-444444444444'
  await c.query(`INSERT INTO identity_risk_evaluation_runs
    (id,organization_id,customer_tenant_id,run_key,engine_version,catalog_version,status,window_start,
     window_end,source_watermark_hash,source_content_hash,expires_at,completed_at,created_at)
    VALUES ($1,$2,$3,'r','t','t','COMPLETED',now()-interval '1 hour',now(),'h','h',
            now()+interval '30 days',now(),now()) ON CONFLICT DO NOTHING`, [runId, ORG, TENANT])
  await c.query(`INSERT INTO identity_risk_matched_results
    (id,organization_id,customer_tenant_id,evaluation_run_id,result_key,rule_id,subject_type,subject_id,
     severity,confidence,coverage,observed_at,expires_at,created_at)
    VALUES ($1,$2,$3,$4,'rk',$5,'USER','seed','HIGH','HIGH','FULL',now(),now()+interval '30 days',now())
    ON CONFLICT DO NOTHING`, [matched, ORG, TENANT, runId, RULE])
  await c.query(`INSERT INTO identity_risk_findings
    (id,organization_id,customer_tenant_id,matched_result_id,dedupe_key,rule_id,rule_version,subject_type,
     subject_id,state,severity,confidence,coverage,observed_at,expires_at,updated_at)
    VALUES ('55555555-5555-5555-5555-555555555555',$1,$2,$3,'d',$4,'v1','USER','user-1','OPEN','HIGH',
            'HIGH','FULL',$5::timestamptz,now()+interval '30 days',now())`,
    [ORG, TENANT, matched, RULE, T0])
}

async function main() {
  const idp = await identityProvider()
  process.env.SUPABASE_URL = idp.base
  process.env.HAWKVIEW_CANARY_ENABLED = 'false'

  const app = await NestFactory.create(AppModule, { ...HAWKVIEW_NEST_OPTIONS, logger: ['error'], abortOnError: false })
  await app.listen(0, '127.0.0.1')
  const port = Number(new URL(await app.getUrl()).port)
  const c = new pg.Client({ connectionString: URL_ENV })
  await c.connect()

  try {
    await scaffold(c)

    const store = async (keys: readonly string[], value = 'RECORD_ONLY') => {
      await c.query('TRUNCATE alert_rule_dispositions')
      for (const k of keys) {
        await c.query(`INSERT INTO alert_rule_dispositions (id,organization_id,alert_type_id,disposition,updated_at)
          VALUES (gen_random_uuid(),$1,$2,$3,now())`, [ORG, k, value])
      }
    }

    const look = async (label: string) => {
      const headers = { authorization: 'Bearer ' + (await idp.token()) }
      const page = await get(port, '/api/alerts/dispositions', headers)
      await seedFinding(c)
      const outcome = await runIntake(storeFor(c), WATERMARK, T0, Date.now() + 30_000, '2026-01-01T00:00:00.000Z')
      const report = outcome.kind === 'RAN' ? outcome.report : null
      return {
        label,
        endpointStatus: page.status,
        catalogueRowsReturned: (page.body.dispositions ?? []).length,
        unrecognisedKeys: page.body.unrecognisedKeys ?? null,
        rowsWithStoredValueIgnored: (page.body.dispositions ?? [])
          .filter((r) => r.storedValueIgnored !== undefined)
          .map((r) => ({ alertTypeId: r.alertTypeId, storedValueIgnored: r.storedValueIgnored })),
        tickOutcome: outcome.kind,
        unreadableDispositions: report?.unreadableDispositions ?? null,
        jobsWritten: report?.jobsWritten ?? null,
      }
    }

    // ── A. NOTHING STORED — the control that stops an empty list reading as a finding ────────
    await store([])
    const noneStored = await look('no rows at all')

    // ── B. A VALID ROW — must appear in neither list ─────────────────────────────────────────
    await store([GOOD_TYPE])
    const validOnly = await look('one valid row, RECORD_ONLY')

    // ── C & D. TWO DIFFERENT UNRECOGNISED KEYS, SEPARATELY ──────────────────────────────────
    // The output must FOLLOW the key. A constant that looks like an attribution passes one of
    // these and fails the other.
    await store(['HV-ID-AUTH-010.v1'])
    const keyOne = await look('one unrecognised key: HV-ID-AUTH-010.v1')
    await store(['HV-ID-MBX-001.v1'])
    const keyTwo = await look('a DIFFERENT unrecognised key: HV-ID-MBX-001.v1')

    // ── E. BOTH, PLUS A VALID ROW ───────────────────────────────────────────────────────────
    await store(['HV-ID-MBX-001.v1', GOOD_TYPE, 'HV-ID-AUTH-010.v1'])
    const mixed = await look('two unrecognised keys beside one valid row')

    // ── F. AN UNREADABLE VALUE ON A VALID KEY — the other arm, which must stay distinct ──────
    await c.query('TRUNCATE alert_rule_dispositions')
    await c.query('ALTER TABLE alert_rule_dispositions DROP CONSTRAINT IF EXISTS alert_rule_dispositions_disposition_check')
    await c.query(`INSERT INTO alert_rule_dispositions (id,organization_id,alert_type_id,disposition,updated_at)
      VALUES (gen_random_uuid(),$1,$2,'RING',now())`, [ORG, GOOD_TYPE])
    const badValue = await look('a valid key holding RING, the old vocabulary')
    await c.query('TRUNCATE alert_rule_dispositions')
    await c.query(`ALTER TABLE alert_rule_dispositions ADD CONSTRAINT alert_rule_dispositions_disposition_check
      CHECK (disposition IN ('ACT_NOW','ACT_TODAY','RECORD_ONLY'))`)

    const named = (r: typeof keyOne) => (r.unreadableDispositions ?? []).map((u) => u.alertTypeId)

    console.log(JSON.stringify({
      QA_UNRECOGNISED_KEYS: {
        boundTo: 'ac6318f (tip of agent/alerts-step-01); the backend half is 73222f6',
        cases: { noneStored, validOnly, keyOne, keyTwo, mixed, badValue },

        BOTH_ENDS_NAME_IT: {
          endpoint: keyOne.unrecognisedKeys,
          tick: keyOne.unreadableDispositions,
          ENDPOINT_NAMES_THE_KEY: JSON.stringify(keyOne.unrecognisedKeys) === JSON.stringify(['HV-ID-AUTH-010.v1']),
          TICK_NAMES_THE_KEY: JSON.stringify(named(keyOne)) === JSON.stringify(['HV-ID-AUTH-010.v1']),
          TICK_GIVES_THE_REASON: (keyOne.unreadableDispositions ?? [])[0]?.because === 'UNKNOWN_ALERT_TYPE',
        },

        // The two checks that separate a report from a placeholder.
        IT_FOLLOWS_THE_KEY_RATHER_THAN_BEING_A_CONSTANT:
          JSON.stringify(keyOne.unrecognisedKeys) !== JSON.stringify(keyTwo.unrecognisedKeys)
          && JSON.stringify(keyTwo.unrecognisedKeys) === JSON.stringify(['HV-ID-MBX-001.v1'])
          && JSON.stringify(named(keyTwo)) === JSON.stringify(['HV-ID-MBX-001.v1']),

        NOTHING_STORED_NAMES_NOTHING:
          JSON.stringify(noneStored.unrecognisedKeys) === '[]'
          && JSON.stringify(noneStored.unreadableDispositions) === '[]',

        A_VALID_ROW_APPEARS_IN_NEITHER_LIST:
          JSON.stringify(validOnly.unrecognisedKeys) === '[]'
          && JSON.stringify(validOnly.unreadableDispositions) === '[]'
          && validOnly.rowsWithStoredValueIgnored.length === 0,

        BOTH_KEYS_AT_ONCE_AND_THE_VALID_ONE_STILL_WORKS: {
          endpoint: mixed.unrecognisedKeys,
          tick: named(mixed),
          // The valid row was RECORD_ONLY, so the tick must still silence the finding — the
          // report is not achieved by the lookup breaking.
          jobsWritten: mixed.jobsWritten,
          THE_VALID_SETTING_STILL_TOOK_EFFECT: mixed.jobsWritten === 0,
        },

        THE_TWO_ARMS_STAY_DISTINCT: {
          unreadableValue_endpoint: badValue.rowsWithStoredValueIgnored,
          unreadableValue_unrecognisedKeys: badValue.unrecognisedKeys,
          unreadableValue_tick: badValue.unreadableDispositions,
          VALUE_ARM_IS_NOT_IN_THE_KEY_LIST: JSON.stringify(badValue.unrecognisedKeys) === '[]',
          VALUE_ARM_APPEARS_ON_ITS_ROW: badValue.rowsWithStoredValueIgnored.length === 1,
          TICK_CALLS_IT_UNKNOWN_DISPOSITION:
            (badValue.unreadableDispositions ?? [])[0]?.because === 'UNKNOWN_DISPOSITION',
        },
      },
    }, null, 2))
  } finally {
    await c.end()
    await app.close()
    await idp.close()
  }
}

main().catch((e) => { console.error('QA PROBE FAILED:', e); process.exitCode = 1 })
