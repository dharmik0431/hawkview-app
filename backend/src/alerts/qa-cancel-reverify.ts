// QA — the cancel's three gaps re-verified at 59f3a40, against the register at c370af8.
// The standard is the measured case from last time: a queue where some jobs have attempts and
// some do not, cancelled in ONE call, and the result must say which is which PER JOB.
import pg from 'pg'
import { cancelReason, cancelStatement, classifyCancellation, type CancelledRow } from './send-queue.js'
const c = new pg.Client({ connectionString: process.env.DATABASE_URL }); await c.connect()
const r: Record<string, unknown> = {}

const st = cancelStatement({
  scope: { kind: 'ORGANISATION', organizationId: 'org-1', createdBeforeIso: new Date().toISOString() },
  by: 'dharmik', because: cancelReason('bad first run, stopping everything'),
}, new Date().toISOString())

r.C2_oneStatement = {
  statements: st.sql.split(';').filter((x) => x.trim() !== '').length,
  hasReturning: /RETURNING/i.test(st.sql),
  hasForUpdate: /FOR UPDATE/i.test(st.sql),
  verdict: st.sql.split(';').filter((x) => x.trim() !== '').length === 1 && /RETURNING/i.test(st.sql)
    ? 'BOUND — one statement, and it returns rows rather than a count' : 'FAILED',
}

const res = await c.query(st.sql, st.params as unknown[])
const classified = classifyCancellation(res.rows as CancelledRow[])
const short = (m: string) => m.replace('incident/org-1|', '').replace('incident/org-12|', 'OTHERORG:')

// THE GAP THAT CAME BACK AS A ROW COUNT LAST TIME.
r.perJobOutcome = {
  rowsReturned: res.rowCount,
  perJob: classified.map((j) => ({ job: short(j.messageId as unknown as string), outcome: j.outcome })),
  neverAttempted: classified.filter((j) => j.outcome === 'STOPPED_BEFORE_ANY_ATTEMPT').map((j) => short(j.messageId as unknown as string)),
  mayHaveReached: classified.filter((j) => j.outcome === 'MAY_HAVE_REACHED_PROVIDER').map((j) => short(j.messageId as unknown as string)),
}

// THE CTE MUST CAPTURE THE PRE-IMAGE. If it read the updated row, every job would look
// unclaimed and unattempted, and everything would classify as stopped-before-any-attempt.
r.preImageNotPostImage = {
  claimedClassifiedAs: classified.find((j) => short(j.messageId as unknown as string) === 'claimed')?.outcome,
  triedClassifiedAs: classified.find((j) => short(j.messageId as unknown as string) === 'tried')?.outcome,
  neverClassifiedAs: classified.find((j) => short(j.messageId as unknown as string) === 'never')?.outcome,
  verdict: classified.find((j) => short(j.messageId as unknown as string) === 'claimed')?.outcome === 'MAY_HAVE_REACHED_PROVIDER'
    && classified.find((j) => short(j.messageId as unknown as string) === 'never')?.outcome === 'STOPPED_BEFORE_ANY_ATTEMPT'
    ? 'BOUND — the RETURNING reads the locked pre-image; a post-image read would call everything stopped'
    : 'FAILED — classification does not reflect the state before the cancel',
}

const after = await c.query(`SELECT message_id, state, cancelled_by, cancelled_because, cancelled_at FROM alert_send_jobs ORDER BY message_id`)
const row = (m: string) => after.rows.find((x) => x.message_id.endsWith(m))
r.C7_provenance = {
  cancelledBy: row('|never')?.cancelled_by, because: row('|never')?.cancelled_because,
  hasTimestamp: row('|never')?.cancelled_at !== null,
  verdict: row('|never')?.cancelled_by === 'dharmik' && row('|never')?.cancelled_because !== null && row('|never')?.cancelled_at !== null
    ? 'BOUND — who, when and why are on the job' : 'NOT MET',
}
r.C4_boundary_C5_terminal_C3_scope = {
  createdAfterTheBoundary: row('|toonew')?.state,
  otherOrganisation: row('|other')?.state,
  sent: row('|sent')?.state, exhausted: row('|exhausted')?.state,
  verdict: row('|toonew')?.state === 'READY' && row('|other')?.state === 'READY'
    && row('|sent')?.state === 'SENT' && row('|exhausted')?.state === 'EXHAUSTED'
    ? 'BOUND — the boundary excludes newer jobs, the scope excludes org-12, history is not relabelled'
    : 'FAILED',
}
console.log(JSON.stringify({ QA_CANCEL_REVERIFY: r }, null, 2))
await c.end()
