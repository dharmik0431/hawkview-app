import { type OperatorAddress } from './email-delivery.js'
import { type Settled } from './send-queue.js'
import { type Suppressions } from './alert-sender.js'

/**
 * SUPPRESSION THAT SURVIVES A RESTART.
 *
 * `Suppressions` was an interface with one in-memory implementation, which meant a hard bounce
 * was forgotten on the next deploy and the dead address was attempted again. That is not a
 * suppression, it is a cache with a very short life — and a mailbox retried after every release
 * is exactly what costs a sending domain its reputation, on every other message rather than on
 * the one that bounced.
 *
 * THE INTERFACE STAYS SYNCHRONOUS. `attemptSend` asks `has(address)` in the middle of deciding
 * whether to open an attempt, and making that await would put a database round trip inside the
 * send path for every message. Instead a tick loads the set once — the same shape the intake
 * pipeline already uses for dispositions — and the sender reads a snapshot.
 *
 * WHAT A SNAPSHOT COSTS, STATED RATHER THAN DISCOVERED: an address suppressed by another worker
 * DURING this tick is not in this tick's set, so one further attempt can be made to it. That is
 * bounded by the tick, and the alternative — a query per message — spends far more to close a
 * window that a single retry already tolerates.
 */

/** Why an address is suppressed. Three different facts with three different remedies, which is
 * why they are not one flag: a hard bounce means the mailbox is gone and somebody should ask the
 * MSP for a new address; a complaint means somebody there marked us as spam and the remedy is a
 * conversation, not a correction; MANUAL means a person decided, and the reason lives with them. */
export type SuppressionReason = 'HARD_BOUNCE' | 'COMPLAINT' | 'MANUAL'

/** THE RFC MAXIMUM: 64 local + `@` + 255 domain. A longer string is not an address, and
 * truncating one to fit would suppress a DIFFERENT address than the one that bounced. */
export const MAX_ADDRESS_LENGTH = 320

export interface SuppressionRow {
  readonly address: string
  readonly reason: SuppressionReason
  readonly because: string | null
  readonly messageId: string | null
  readonly firstSuppressedAtIso: string
  readonly lastSeenAtIso: string
}

/** A suppression to write. `messageId` is required for the two machine-made reasons and absent
 * for `MANUAL`, so a write with no provenance is unavailable rather than discouraged — the
 * database carries the same rule as a CHECK, because this type cannot reach a hand-written INSERT. */
export type SuppressionWrite =
  | Readonly<{ address: string; reason: 'HARD_BOUNCE' | 'COMPLAINT'; because: string; messageId: string }>
  | Readonly<{ address: string; reason: 'MANUAL'; because: string; messageId?: undefined }>

export interface SuppressionStatement {
  readonly sql: string
  readonly params: readonly unknown[]
}

/** Every suppressed address. No pagination and no filter: the set is small by construction —
 * one row per address that has ever hard-bounced — and a partial set is worse than none, because
 * the addresses it omits are the ones that get written to. */
export const SUPPRESSION_SELECT_SQL =
  `SELECT address, reason, because, message_id, first_suppressed_at, last_seen_at
     FROM alert_suppressed_addresses`

/** The snapshot the sender reads.
 *
 * MATCHING IS CASE-INSENSITIVE ON THE WHOLE ADDRESS, which is not what the RFC says: the local
 * part is technically case-sensitive. It is done anyway because no mail provider in practice
 * treats `Ops@` and `ops@` as different mailboxes, and the direction of the error decides it —
 * matching case-sensitively would let one capital letter defeat a suppression and write to a dead
 * mailbox, while matching case-insensitively can at worst withhold a message from an address
 * somebody has already proven dead in another case. */
export function suppressionsFrom(rows: Iterable<Pick<SuppressionRow, 'address'>>): Suppressions {
  const set = new Set<string>()
  for (const row of rows) set.add(row.address.trim().toLowerCase())
  return { has: (address: OperatorAddress) => set.has(String(address).trim().toLowerCase()) }
}

/** Upsert one suppression.
 *
 * `first_suppressed_at` IS NOT UPDATED ON CONFLICT, AND THAT IS THE POINT. It answers "since
 * when", and a repeat bounce moving it would reset the age of every suppression that is still
 * bouncing — so the addresses dead longest would read as the newest, which is the exact reverse
 * of what anybody looks at this table to find out.
 *
 * THE REASON IS NOT UPDATED EITHER. A complaint arriving after a hard bounce does not make the
 * mailbox exist again, and letting the last event win would let a softer reason overwrite a
 * harder one. The first fact that stopped us writing is the one that explains the silence. */
export function suppressionUpsert(write: SuppressionWrite, nowIso: string): SuppressionStatement {
  return {
    sql: `INSERT INTO alert_suppressed_addresses
            (address, reason, because, message_id, first_suppressed_at, last_seen_at)
          VALUES ($1, $2, $3, $4, $5::timestamptz, $5::timestamptz)
          ON CONFLICT (address) DO UPDATE SET last_seen_at = EXCLUDED.last_seen_at`,
    params: [
      write.address.trim().toLowerCase(),
      write.reason,
      write.because.slice(0, 500),
      write.messageId ?? null,
      nowIso,
    ],
  }
}

/** What a settlement implies about the address. THREE ANSWERS, because there are three cases and
 * two of them are not "nothing to do".
 *
 * `NONE` is a settlement that does not suppress. `UNSUPPRESSABLE` is one that should have and
 * cannot — an address that will not fit the column, which would otherwise be retried for ever
 * while the code read as if it had handled it. Collapsing those two into `null` is how a
 * permanent hole acquires the shape of a working guard.
 *
 * DERIVED FROM `Settled` RATHER THAN DECIDED HERE, so this cannot disagree with
 * `suppressesAddress` about which settlements suppress. Two functions answering the same question
 * from the same input is two places holding one fact, and they drift.
 *
 * A refusal longer than the column is truncated rather than dropped: losing the tail of a
 * provider's explanation is a smaller loss than losing the suppression. An ADDRESS is never
 * truncated, because a truncated address is a different address and suppressing it would silence
 * a mailbox that never bounced. */
export type SuppressionDecision =
  | Readonly<{ kind: 'NONE' }>
  | Readonly<{ kind: 'SUPPRESS'; write: SuppressionWrite }>
  | Readonly<{ kind: 'UNSUPPRESSABLE'; address: string; because: string }>

export function suppressionFor(
  settled: Settled,
  address: string,
  messageId: string,
): SuppressionDecision {
  if (settled.kind !== 'REFUSED_PERMANENT') return { kind: 'NONE' }
  const trimmed = address.trim()
  if (trimmed.length === 0) {
    return { kind: 'UNSUPPRESSABLE', address, because: 'the address is empty' }
  }
  if (trimmed.length > MAX_ADDRESS_LENGTH) {
    return {
      kind: 'UNSUPPRESSABLE',
      address,
      because: `the address is ${trimmed.length} characters, past the ${MAX_ADDRESS_LENGTH} the column holds`,
    }
  }
  return {
    kind: 'SUPPRESS',
    write: { address: trimmed, reason: 'HARD_BOUNCE', because: settled.because, messageId },
  }
}
