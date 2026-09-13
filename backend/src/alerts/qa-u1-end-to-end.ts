// QA — U1, AT LAST, END TO END: does a setting a person makes over HTTP change what a tick does?
//
// I bound the pipeline half months of rounds ago and said so every time: a test that supplies its
// own disposition row tests the half that already works. The endpoint did not exist, so the join
// could not be checked from either side. Both sides exist now, and this is one run that starts at
// an HTTP PATCH and ends at the rows a tick wrote.
//
// THE AUTH PATH IS REAL, NOT STUBBED. `IdentityTokenVerifier` fetches a JWKS from `SUPABASE_URL`
// and verifies an RS256 token against it — so instead of replacing the verifier with a double,
// this generates a keypair, SERVES A REAL JWKS over a real socket, points SUPABASE_URL at it, and
// mints real tokens. The guard, the verifier, the membership check, the controller and the service
// are all the shipping code. Nothing in the request path is a test seam.
//
// AND THE APPLICATION IS THE REAL `AppModule` with `HAWKVIEW_NEST_OPTIONS`, for the reason the
// rawBody work established: a check whose module is not the module that ships is the same gap as
// the ones being fixed.
import { Module } from '@nestjs/common'
import { NestFactory } from '@nestjs/core'
import { createServer } from 'node:http'
import { request as httpRequest } from 'node:http'
import { exportJWK, generateKeyPair, SignJWT, type JWK } from 'jose'
import pg from 'pg'
import { AppModule } from '../app.module.js'
import { HAWKVIEW_NEST_OPTIONS } from '../bootstrap-options.js'
import { runIntake, type PipelineStore, type Watermark } from './finding-pipeline.js'
import { pipelineStore, type SqlRunner } from './pipeline-store.js'

const URL_ENV = process.env.DATABASE_URL
if (URL_ENV === undefined) throw new Error('DATABASE_URL is required; use a disposable test database.')
if (!/hvu1test/.test(URL_ENV)) throw new Error('refusing to run against a database that is not the disposable one')

const ORG = '11111111-1111-1111-1111-111111111111'
const OTHER_ORG = '1a1a1a1a-1111-1111-1111-111111111111'
const TENANT = '22222222-2222-2222-2222-222222222222'
const USER = '77777777-7777-7777-7777-777777777777'
const SUBJECT = '88888888-8888-4888-8888-888888888888' // MUST be a UUID: the verifier requires it
const T0 = '2026-09-12T09:00:00.000Z'
const TYPE = 'security.suspected_credential_attack' // catalogue severity ACT_NOW, and CONSULTED
const RULE = 'HV-ID-AUTH-001.v1'

const WATERMARK: Watermark = {
  sendNothingObservedBeforeIso: '2026-09-12T00:00:00.000Z',
  because: 'the instant this pipeline was first switched on',
}

// ── the SqlRunner adapter, the same three methods the shipped store takes ────────────────────
const inTx = (c: pg.Client): SqlRunner => ({
  query: async <T>(sql: string, params: readonly unknown[]) => (await c.query(sql, [...params])).rows as T[],
  execute: async (sql: string, params: readonly unknown[]) => (await c.query(sql, [...params])).rowCount ?? 0,
  transaction: (run) => run(inTx(c)),
})
const runnerFor = (c: pg.Client): SqlRunner => ({
  query: async <T>(sql: string, params: readonly unknown[]) => (await c.query(sql, [...params])).rows as T[],
  execute: async (sql: string, params: readonly unknown[]) => (await c.query(sql, [...params])).rowCount ?? 0,
  transaction: async (run) => {
    await c.query('BEGIN')
    try { const r = await run(inTx(c)); await c.query('COMMIT'); return r }
    catch (e) { await c.query('ROLLBACK'); throw e }
  },
})
const storeFor = (c: pg.Client): PipelineStore => pipelineStore(runnerFor(c))

// ── a real JWKS over a real socket ───────────────────────────────────────────────────────────
async function identityProvider() {
  const { publicKey, privateKey } = await generateKeyPair('RS256', { extractable: true })
  const jwk: JWK = { ...(await exportJWK(publicKey)), kid: 'qa-u1', alg: 'RS256', use: 'sig' }
  const server = createServer((req, res) => {
    if (req.url === '/auth/v1/.well-known/jwks.json') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ keys: [jwk] }))
      return
    }
    res.writeHead(404).end()
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port
  const base = 'http://127.0.0.1:' + port
  const token = async (over: Record<string, unknown> = {}) =>
    new SignJWT({
      // EVERY CLAIM THE REAL VERIFIER DEMANDS. My first token carried only email and aal and was
      // refused - a confirmed, non-anonymous Supabase session needs role, is_anonymous and a
      // session_id UUID too. The 401 was my instrument, not the endpoint.
      email: 'operator@an-msp.example', aal: 'aal2', role: 'authenticated', is_anonymous: false,
      session_id: '99999999-9999-4999-8999-999999999999', ...over })
      .setProtectedHeader({ alg: 'RS256', kid: 'qa-u1' })
      .setIssuer(base + '/auth/v1').setAudience('authenticated').setSubject(SUBJECT)
      .setIssuedAt().setExpirationTime('10m').sign(privateKey)
  return { base, token, close: () => new Promise<void>((r) => server.close(() => r())) }
}

// ── the HTTP client, exact bytes, status always returned ─────────────────────────────────────
type Wire = { status: number; body: unknown }
function call(port: number, method: string, path: string, headers: Record<string, string>, body?: string): Promise<Wire> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : Buffer.from(body, 'utf8')
    const req = httpRequest({
      host: '127.0.0.1', port, path, method,
      headers: {
        ...(payload ? { 'content-type': 'application/json', 'content-length': String(payload.length) } : {}),
        ...headers,
      },
    }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (c: Buffer) => chunks.push(c))
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        let parsed: unknown = text
        try { parsed = JSON.parse(text) } catch { /* keep the text */ }
        resolve({ status: res.statusCode ?? 0, body: parsed })
      })
    })
    req.on('error', reject)
    if (payload) req.write(payload)
    req.end()
  })
}

// ── seeding ──────────────────────────────────────────────────────────────────────────────────
async function scaffold(c: pg.Client) {
  await c.query(`INSERT INTO organizations (id, name, slug, created_at, updated_at)
    VALUES ($1,'Probe','probe',now(),now()) ON CONFLICT (id) DO NOTHING`, [ORG])
  await c.query(`INSERT INTO organizations (id, name, slug, created_at, updated_at)
    VALUES ($1,'Other','other',now(),now()) ON CONFLICT (id) DO NOTHING`, [OTHER_ORG])
  await c.query(`INSERT INTO customer_tenants (id, organization_id, microsoft_tenant_id, display_name, created_at, updated_at)
    VALUES ($1,$2,'99999999-9999-9999-9999-999999999999','Probe Tenant',now(),now())
    ON CONFLICT (id) DO NOTHING`, [TENANT, ORG])
  // DO UPDATE, NOT DO NOTHING. An earlier run of this file left a user row carrying a different
  // auth_provider_user_id, and DO NOTHING kept it — so the token verified and the lookup found
  // nobody, which arrived as a 403 that read exactly like the endpoint refusing me.
  await c.query(`INSERT INTO users (id, auth_provider_user_id, email, updated_at)
    VALUES ($1,$2,'operator@an-msp.example',now())
    ON CONFLICT (id) DO UPDATE SET auth_provider_user_id = EXCLUDED.auth_provider_user_id`,
    [USER, SUBJECT])
  await c.query(`INSERT INTO memberships (id, user_id, organization_id, role, status, updated_at)
    VALUES (gen_random_uuid(),$1,$2,'MSP_OWNER','ACTIVE',now()) ON CONFLICT DO NOTHING`, [USER, ORG])
  await c.query(`INSERT INTO notification_preferences (id, user_id, organization_id, email_enabled, updated_at)
    VALUES (gen_random_uuid(),$1,$2,true,now()) ON CONFLICT DO NOTHING`, [USER, ORG])
}

async function resetAndSeedOneFinding(c: pg.Client) {
  await c.query('TRUNCATE alert_send_jobs, alert_incidents, alert_rule_dispositions, notifications CASCADE')
  await c.query('DELETE FROM identity_risk_findings')
  const runId = '33333333-3333-3333-3333-333333333333'
  const matched = '44444444-4444-4444-4444-444444444444'
  await c.query(`INSERT INTO identity_risk_evaluation_runs
    (id,organization_id,customer_tenant_id,run_key,engine_version,catalog_version,status,
     window_start,window_end,source_watermark_hash,source_content_hash,expires_at,completed_at,created_at)
    VALUES ($1,$2,$3,'seed-run','test','test','COMPLETED',now()-interval '1 hour',now(),'h','h',
            now()+interval '30 days',now(),now()) ON CONFLICT DO NOTHING`, [runId, ORG, TENANT])
  await c.query(`INSERT INTO identity_risk_matched_results
    (id,organization_id,customer_tenant_id,evaluation_run_id,result_key,rule_id,subject_type,
     subject_id,severity,confidence,coverage,observed_at,expires_at,created_at)
    VALUES ($1,$2,$3,$4,'seed-result',$5,'USER','seed','HIGH','HIGH','FULL',now(),
            now()+interval '30 days',now()) ON CONFLICT DO NOTHING`, [matched, ORG, TENANT, runId, RULE])
  await c.query(`INSERT INTO identity_risk_findings
    (id,organization_id,customer_tenant_id,matched_result_id,dedupe_key,rule_id,rule_version,
     subject_type,subject_id,state,severity,confidence,coverage,observed_at,expires_at,updated_at)
    VALUES ('55555555-5555-5555-5555-555555555555',$1,$2,$3,'dedupe-u1',$4,'v1','USER','user-1',
            'OPEN','HIGH','HIGH','FULL',$5::timestamptz,now()+interval '30 days',now())`,
    [ORG, TENANT, matched, RULE, T0])
}

/** WHAT THE TICK ACTUALLY PRODUCED. Read back out of the database rather than taken from the
 * report, because the report is the pipeline's own account of itself. */
async function whatWasWritten(c: pg.Client) {
  const jobs = (await c.query(`SELECT message_id, state, max_attempts FROM alert_send_jobs ORDER BY message_id`)).rows
  const incidents = (await c.query(`SELECT incident_key, alert_type_id FROM alert_incidents ORDER BY incident_key`)).rows
  const notes = (await c.query(`SELECT alert_type_id, severity FROM notifications ORDER BY created_at`)).rows
  return { jobs, incidents, notifications: notes }
}

async function main() {
  const idp = await identityProvider()
  process.env.SUPABASE_URL = idp.base          // BEFORE the app is created; the verifier reads it in its constructor
  process.env.HAWKVIEW_CANARY_ENABLED = 'false' // so the aal2 path is the one exercised, not the canary escape

  const app = await NestFactory.create(AppModule, { ...HAWKVIEW_NEST_OPTIONS, logger: ['error'], abortOnError: false })
  await app.listen(0, '127.0.0.1')
  const port = Number(new URL(await app.getUrl()).port)

  const client = new pg.Client({ connectionString: URL_ENV })
  await client.connect()

  const bearer = async () => ({ authorization: 'Bearer ' + (await idp.token()) })
  const rowsInTable = async () =>
    Number((await client.query('SELECT count(*)::int AS n FROM alert_rule_dispositions')).rows[0].n)

  try {
    await scaffold(client)

    // ══ THE FOUR CASES. Each one: reset, set the disposition OVER HTTP, run a tick. ══════════
    const run = async (set: string | null) => {
      await resetAndSeedOneFinding(client)
      let write: Wire | null = null
      if (set !== null) {
        write = await call(port, 'PATCH', '/api/alerts/dispositions/' + TYPE,
          await bearer(), JSON.stringify({ disposition: set }))
      }
      const stored = (await client.query(
        'SELECT disposition FROM alert_rule_dispositions WHERE organization_id=$1 AND alert_type_id=$2',
        [ORG, TYPE])).rows[0]?.disposition ?? null
      // `runIntake` returns an outcome union since 28b6ddd. Unwrapped rather than cast, and the
      // probe FAILS rather than reports zeros if a tick did not run — the typecheck caught the
      // change when I re-pointed this file at a newer tip, which is the reason for typechecking
      // a probe at all.
      const outcome = await runIntake(storeFor(client), WATERMARK, T0, Date.now() + 30_000, '2026-01-01T00:00:00.000Z')
      if (outcome.kind !== 'RAN') throw new Error('the tick did not run: ' + JSON.stringify(outcome))
      const report = outcome.report
      return { writeStatus: write?.status ?? null, stored, report, written: await whatWasWritten(client) }
    }

    const withNoRow = await run(null)
    const actNow = await run('ACT_NOW')
    const actToday = await run('ACT_TODAY')
    const recordOnly = await run('RECORD_ONLY')

    const outcome = (r: Awaited<ReturnType<typeof run>>) => JSON.stringify({
      jobs: r.report.jobsWritten, incidents: r.report.incidentsWritten,
      notifications: r.report.notificationsWritten, skipped: r.report.skipped, written: r.written,
    })

    // ══ THE ATTACKS ═════════════════════════════════════════════════════════════════════════
    await resetAndSeedOneFinding(client)

    const noToken = await call(port, 'GET', '/api/alerts/dispositions', {})
    const noTokenWrite = await call(port, 'PATCH', '/api/alerts/dispositions/' + TYPE, {},
      JSON.stringify({ disposition: 'RECORD_ONLY' }))
    const badToken = await call(port, 'GET', '/api/alerts/dispositions',
      { authorization: 'Bearer not-a-real-token' })
    const aal1 = await call(port, 'GET', '/api/alerts/dispositions',
      { authorization: 'Bearer ' + (await idp.token({ aal: 'aal1' })) })
    const afterUnauthenticated = await rowsInTable()

    const badValue = await call(port, 'PATCH', '/api/alerts/dispositions/' + TYPE,
      await bearer(), JSON.stringify({ disposition: 'RING' }))
    const badValueLowercase = await call(port, 'PATCH', '/api/alerts/dispositions/' + TYPE,
      await bearer(), JSON.stringify({ disposition: 'act_now' }))
    const noBody = await call(port, 'PATCH', '/api/alerts/dispositions/' + TYPE, await bearer(), '{}')
    const unknownType = await call(port, 'PATCH', '/api/alerts/dispositions/not.a.type',
      await bearer(), JSON.stringify({ disposition: 'ACT_NOW' }))
    const foreignOrg = await call(port, 'PATCH',
      '/api/alerts/dispositions/' + TYPE + '?organizationId=' + OTHER_ORG,
      await bearer(), JSON.stringify({ disposition: 'ACT_NOW' }))
    const afterRefusals = await rowsInTable()

    // Can the DATABASE hold a value outside the vocabulary at all? If the CHECK constraint holds,
    // the store not validating `disposition` is defended one layer down rather than by luck.
    let directWrite = 'accepted'
    try {
      await client.query(`INSERT INTO alert_rule_dispositions (id, organization_id, alert_type_id, disposition, updated_at)
        VALUES (gen_random_uuid(),$1,$2,'RING',now())`, [ORG, TYPE])
    } catch (e) { directWrite = 'refused: ' + String((e as { code?: string }).code) }

    // IS `storedValueIgnored` REACHABLE AT ALL? It fires when a CATALOGUE type's stored value is
    // outside the vocabulary — which the CHECK constraint forbids. So the branch is dropped
    // through the only door that could open it: the constraint is removed, the value written, the
    // list read, and the constraint put back. If the row reports it here and cannot arise in a
    // real database, the branch is defensive rather than live — and the case that CAN arise is a
    // different one.
    await client.query('TRUNCATE alert_rule_dispositions')
    await client.query('ALTER TABLE alert_rule_dispositions DROP CONSTRAINT IF EXISTS alert_rule_dispositions_disposition_check')
    await client.query(`INSERT INTO alert_rule_dispositions (id, organization_id, alert_type_id, disposition, updated_at)
      VALUES (gen_random_uuid(),$1,$2,'RING',now())`, [ORG, TYPE])
    const listWithABadValue = await call(port, 'GET', '/api/alerts/dispositions', await bearer())
    const badValueRows = ((listWithABadValue.body as { dispositions?: { alertTypeId: string; disposition: string; storedValueIgnored?: string }[] }).dispositions ?? [])
      .filter((r) => r.storedValueIgnored !== undefined)
    await client.query('TRUNCATE alert_rule_dispositions')
    await client.query(`ALTER TABLE alert_rule_dispositions ADD CONSTRAINT alert_rule_dispositions_disposition_check
      CHECK (disposition IN ('ACT_NOW','ACT_TODAY','RECORD_ONLY'))`)

    // AN UNREADABLE STORED TYPE ID — the shape that was silently ignored before the rename.
    await client.query('TRUNCATE alert_rule_dispositions')
    await client.query(`INSERT INTO alert_rule_dispositions (id, organization_id, alert_type_id, disposition, updated_at)
      VALUES (gen_random_uuid(),$1,'HV-ID-AUTH-010.v1','RECORD_ONLY',now())`, [ORG])
    const listWithUnreadable = await call(port, 'GET', '/api/alerts/dispositions', await bearer())
    await resetAndSeedOneFinding(client)
    await client.query(`INSERT INTO alert_rule_dispositions (id, organization_id, alert_type_id, disposition, updated_at)
      VALUES (gen_random_uuid(),$1,'HV-ID-AUTH-010.v1','RECORD_ONLY',now())`, [ORG])
    const unreadableOutcome = await runIntake(storeFor(client), WATERMARK, T0, Date.now() + 30_000, '2026-01-01T00:00:00.000Z')
    if (unreadableOutcome.kind !== 'RAN') throw new Error('the tick did not run: ' + JSON.stringify(unreadableOutcome))
    const tickWithUnreadable = unreadableOutcome.report

    const list = listWithUnreadable.body as { dispositions?: { alertTypeId: string; storedValueIgnored?: string }[] }

    console.log(JSON.stringify({
      QA_U1_END_TO_END: {
        boundTo: '6fdfa4a',
        authPath: 'REAL — a generated RS256 keypair served as a real JWKS, real tokens, the real '
          + 'guard and the real verifier. Nothing in the request path is a double.',

        // ══ U1 ITSELF ══════════════════════════════════════════════════════════════════════
        u1: {
          withNoRow: { jobs: withNoRow.report.jobsWritten, skipped: withNoRow.report.skipped.map((s) => s.because) },
          actNow: { writeStatus: actNow.writeStatus, stored: actNow.stored, jobs: actNow.report.jobsWritten },
          actToday: { writeStatus: actToday.writeStatus, stored: actToday.stored, jobs: actToday.report.jobsWritten },
          recordOnly: { writeStatus: recordOnly.writeStatus, stored: recordOnly.stored, jobs: recordOnly.report.jobsWritten,
            skipped: recordOnly.report.skipped.map((s) => s.because) },

          A_SETTING_MADE_OVER_HTTP_CHANGES_THE_TICK:
            withNoRow.report.jobsWritten === 1 && recordOnly.report.jobsWritten === 0,
          // and the write really reached the table, so the path is not short-circuited somewhere
          THE_WRITE_REACHED_THE_DATABASE: recordOnly.stored === 'RECORD_ONLY',

          // ══ THE TIER QUESTION ════════════════════════════════════════════════════════════
          // "the disposition becomes the tier" — does moving between the two non-silencing
          // tiers change ANYTHING the tick produces?
          ACT_NOW_AND_ACT_TODAY_PRODUCE_THE_SAME_OUTPUT: outcome(actNow) === outcome(actToday),
          AND_BOTH_MATCH_NO_ROW_AT_ALL: outcome(actNow) === outcome(withNoRow),
          theOutputs: {
            noRow: JSON.parse(outcome(withNoRow)),
            actNow: JSON.parse(outcome(actNow)),
            actToday: JSON.parse(outcome(actToday)),
            recordOnly: JSON.parse(outcome(recordOnly)),
          },
        },

        // ══ ATTACK 1: THE ENDPOINT IS NOT PUBLIC ═══════════════════════════════════════════
        notPublic: {
          getWithNoToken: noToken.status,
          patchWithNoToken: noTokenWrite.status,
          getWithAGarbageToken: badToken.status,
          getWithAal1: aal1.status,
          rowsWrittenByUnauthenticatedCallers: afterUnauthenticated,
          BOTH_VERBS_REFUSED: noToken.status === 401 && noTokenWrite.status === 401,
          A_FORGED_TOKEN_IS_REFUSED: badToken.status === 401,
          NOTHING_WAS_WRITTEN: afterUnauthenticated === 0,
        },

        // ══ ATTACK 2: A VALUE OUTSIDE THE VOCABULARY IS REFUSED AT THE WRITE ═══════════════
        refusedAtTheWrite: {
          oldChannelVocabulary_RING: badValue.status,
          wrongCase_act_now: badValueLowercase.status,
          noDispositionAtAll: noBody.status,
          unknownAlertType: unknownType.status,
          anotherOrganisation: foreignOrg.status,
          rowsAfterAllFiveRefusals: afterRefusals,
          EVERY_REFUSAL_IS_400_OR_403:
            [badValue.status, badValueLowercase.status, noBody.status, unknownType.status]
              .every((s) => s === 400) && foreignOrg.status === 403,
          NONE_OF_THEM_WROTE: afterRefusals === 0,
          // and the database refuses it too, one layer down
          directInsertOfAChannelValue: directWrite,
        },

        // ══ ATTACK 3: AN UNREADABLE STORED VALUE IS REPORTED, NOT DEFAULTED ════════════════
        unreadableStoredValue: {
          listStatus: listWithUnreadable.status,
          // WITHOUT THIS THE NEGATIVE BELOW IS VACUOUS. A list that returned nothing would also
          // report nothing, and "no row reports it" would be a pass produced by finding nothing.
          catalogueRowsReturned: (list.dispositions ?? []).length,
          // The branch that IS built for this, reached by removing the constraint that forbids it.
          withTheConstraintRemoved: {
            status: listWithABadValue.status,
            rowsReportingIt: badValueRows,
            THE_BRANCH_WORKS: badValueRows.length === 1,
            butItCannotArise: 'the CHECK constraint refuses every value outside the vocabulary — '
              + 'measured above as 23514 — so this branch is defensive, not live',
          },
          // The settings page's own answer: is the ignored value visible on any row?
          anyRowReportsIt: (list.dispositions ?? []).some((r) => r.storedValueIgnored !== undefined),
          rowsReportingIt: (list.dispositions ?? []).filter((r) => r.storedValueIgnored !== undefined),
          // And the tick's answer: does its report say anything at all about it?
          tickReportKeys: Object.keys(tickWithUnreadable),
          tickMentionsIt: JSON.stringify(tickWithUnreadable).includes('HV-ID-AUTH-010'),
          tickJobs: tickWithUnreadable.jobsWritten,
        },
      },
    }, null, 2))
  } finally {
    await client.end()
    await app.close()
    await idp.close()
  }
}

main().catch((e) => { console.error('QA U1 PROBE FAILED:', e); process.exitCode = 1 })
