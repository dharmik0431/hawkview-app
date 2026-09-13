// QA — R5, ONE CLAIM WINS, against a real Postgres. The other nine are pure; this one is a
// claim about what the DATABASE does under contention, and a single-threaded fixture cannot
// establish it. Same method that showed the apply's naive control losing 25 rounds of 25.
import { PrismaPg } from '@prisma/adapter-pg'
import { PrismaClient } from '../generated/prisma/client.js'
import { claimStatement, workerId } from './send-queue.js'
import { messageId } from './email-delivery.js'

const url = process.env.DATABASE_URL ?? ''
const client = () => new PrismaClient({ adapter: new PrismaPg({ connectionString: url, max: 1 }) })

const ROUNDS = 25
let bothWon = 0, exactlyOne = 0, neither = 0

for (let round = 0; round < ROUNDS; round += 1) {
  const a = client(), b = client()
  await a.$executeRawUnsafe(
    "UPDATE alert_send_jobs SET state='READY', attempts_made=0, claimed_by=NULL, claimed_at=NULL, claim_expires_at=NULL WHERE message_id='m1'")
  const now = new Date().toISOString()
  const s1 = claimStatement(messageId('m1'), workerId('w1'), now, 60_000)
  const s2 = claimStatement(messageId('m1'), workerId('w2'), now, 60_000)
  // BOTH WORKERS GO AT ONCE, against the same READY row.
  const [r1, r2] = await Promise.all([
    a.$executeRawUnsafe(s1.sql, ...s1.params),
    b.$executeRawUnsafe(s2.sql, ...s2.params),
  ])
  const winners = (r1 === 1 ? 1 : 0) + (r2 === 1 ? 1 : 0)
  if (winners === 2) bothWon += 1
  else if (winners === 1) exactlyOne += 1
  else neither += 1
  await a.$disconnect(); await b.$disconnect()
}

const check = client()
const held = await check.$queryRawUnsafe<{ claimed_by: string | null; state: string }[]>(
  "SELECT claimed_by, state FROM alert_send_jobs WHERE message_id='m1'")
await check.$disconnect()

console.log(JSON.stringify({
  QA_R5_AGAINST_POSTGRES: {
    rounds: ROUNDS,
    exactlyOneWinner: exactlyOne,
    bothWon,
    neitherWon: neither,
    finalRow: held[0],
    verdict: exactlyOne === ROUNDS && bothWon === 0
      ? 'BOUND - one claim wins, 25 of 25, against a real database'
      : `FAILED - both won ${bothWon} time(s)`,
    note: 'expectedRowCount is 1 and a zero means the other worker won; a caller that ignores '
      + 'the row count and sends anyway reintroduces the duplicate this layer prevents.',
  },
}, null, 2))
