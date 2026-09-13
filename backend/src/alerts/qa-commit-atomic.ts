// QA — is the commit ATOMIC, or merely sequential inside one function? The distinction only
// shows when the process dies between the two inserts. A killed backend is the faithful
// version of that: Postgres rolls back an uncommitted transaction when the connection drops.
import pg from 'pg'
const url = process.env.DATABASE_URL
const victim = new pg.Client({ connectionString: url })
const killer = new pg.Client({ connectionString: url })
victim.on('error', () => {})  // the kill arrives as a socket error; swallow it, it is the point
await victim.connect(); await killer.connect()
const pid = (await victim.query('SELECT pg_backend_pid() AS pid')).rows[0].pid

const ORG = '11111111-1111-1111-1111-111111111111'
await victim.query('BEGIN')
await victim.query(
  `INSERT INTO alert_incidents (id,organization_id,incident_key,alert_type_id,ownership,condition,investigation,ownership_at,condition_at,investigation_at,created_at,updated_at)
   VALUES (gen_random_uuid(),$1,'qa-atomic-key','security.suspected_credential_attack','UNACKNOWLEDGED','ACTIVE','OPEN',now(),now(),now(),now(),now())`, [ORG])
const midFlight = Number((await victim.query('SELECT count(*)::int AS n FROM alert_incidents')).rows[0].n)

// THE PROCESS DIES HERE — after the incident insert, before the job insert and the COMMIT.
await killer.query('SELECT pg_terminate_backend($1)', [pid])
let victimErr = 'none'
try { await victim.query('SELECT 1') } catch (e) { victimErr = String((e as Error).message).slice(0, 60) }

const survived = Number((await killer.query('SELECT count(*)::int AS n FROM alert_incidents')).rows[0].n)
const jobs = Number((await killer.query('SELECT count(*)::int AS n FROM alert_send_jobs')).rows[0].n)
console.log(JSON.stringify({
  QA_COMMIT_ATOMIC: {
    visibleInsideTheTransaction: midFlight,
    connectionKilled: victimErr,
    incidentsSurviving: survived,
    jobsSurviving: jobs,
    verdict: survived === 0 && jobs === 0
      ? 'ATOMIC — the incident was visible inside the transaction and did not survive the kill, so a crash between the two inserts leaves neither'
      : `NOT ATOMIC — ${survived} incident(s) survived a kill before COMMIT`,
  },
}, null, 2))
await killer.end()
