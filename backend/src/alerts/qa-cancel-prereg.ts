// QA — C1 and C2 against a real Postgres, because "never cancels a job that may already be at
// the provider" is a claim about contention and a single-threaded fixture cannot settle it.
// Same method that showed the apply's naive control losing 25 rounds of 25.
import pg from 'pg'
const url = process.env.DATABASE_URL

/** THE REFERENCE: one statement, and the refusal is in the WHERE clause. */
const cancelOneStatement = (scopeBefore: string, by: string, because: string) => ({
  sql: `UPDATE alert_send_jobs
           SET state = 'CANCELLED', cancelled_by = $1, cancelled_at = now(), cancelled_because = $2
         WHERE state = 'READY'
           AND claimed_by IS NULL
           AND created_at < $3::timestamptz
        RETURNING message_id`,
  params: [by, because, scopeBefore],
})

/** THE VARIANT: read the state, then write it. The shape an operator scripts by hand. */
const cancelReadThenWrite = async (client: pg.Client, by: string, because: string) => {
  const { rows } = await client.query("SELECT message_id FROM alert_send_jobs WHERE state='READY' AND claimed_by IS NULL")
  await new Promise((r) => setTimeout(r, 120))   // the window every read-then-write has
  let n = 0
  for (const row of rows) {
    const res = await client.query(
      "UPDATE alert_send_jobs SET state='CANCELLED', cancelled_by=$1, cancelled_at=now(), cancelled_because=$2 WHERE message_id=$3",
      [by, because, row.message_id])
    n += res.rowCount ?? 0
  }
  return n
}

const reset = async (c: pg.Client) => {
  await c.query('DELETE FROM alert_send_jobs')
  await c.query("INSERT INTO alert_send_jobs (message_id, state) VALUES ('m1','READY')")
}
const claim = (c: pg.Client) => c.query(
  `UPDATE alert_send_jobs SET state='CLAIMED', claimed_by='w1', claimed_at=now(), claim_expires_at=now()+interval '1 minute'
    WHERE message_id='m1' AND state NOT IN ('SENT','EXHAUSTED','GAVE_UP','CANCELLED') AND claimed_by IS NULL`)

const a = new pg.Client({ connectionString: url }); const b = new pg.Client({ connectionString: url })
await a.connect(); await b.connect()
const ROUNDS = 25
let refOk = 0, refBoth = 0, varBoth = 0

for (let i = 0; i < ROUNDS; i += 1) {
  // REFERENCE: cancel and claim race for the same READY job. Exactly one must win.
  await reset(a)
  const st = cancelOneStatement(new Date(Date.now() + 60_000).toISOString(), 'qa', 'stop button')
  const [cancelRes, claimRes] = await Promise.all([a.query(st.sql, st.params), claim(b)])
  const winners = ((cancelRes.rowCount ?? 0) > 0 ? 1 : 0) + ((claimRes.rowCount ?? 0) > 0 ? 1 : 0)
  if (winners === 1) refOk += 1
  if (winners === 2) refBoth += 1

  // VARIANT: read-then-write, with a claim landing inside its window.
  await reset(a)
  const [, claimed2] = await Promise.all([
    cancelReadThenWrite(a, 'qa', 'stop button'),
    (async () => { await new Promise((r) => setTimeout(r, 40)); return claim(b) })(),
  ])
  const after = await a.query("SELECT state, claimed_by FROM alert_send_jobs WHERE message_id='m1'")
  // The defect: the job was claimed AND then overwritten as CANCELLED, so a worker holds a
  // message the operator has been told was stopped.
  if ((claimed2.rowCount ?? 0) > 0 && after.rows[0].state === 'CANCELLED') varBoth += 1
}

console.log(JSON.stringify({
  QA_CANCEL_C1_C2: {
    rounds: ROUNDS,
    reference: { exactlyOneWinner: refOk, bothWon: refBoth },
    readThenWriteVariant: { cancelledAJobAWorkerHadClaimed: varBoth },
    verdict: refOk === ROUNDS && refBoth === 0 && varBoth > 0
      ? 'C1+C2 BOUND — one statement never cancels a claimed job, and the read-then-write shape '
        + 'the operator would script by hand does exactly that'
      : `INCONCLUSIVE: ref ${refOk}/${ROUNDS}, variant caught ${varBoth}`,
  },
}, null, 2))
await a.end(); await b.end()
