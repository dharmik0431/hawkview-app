/** STEP 03 APPLY AND REVERT: all-or-nothing, with a receipt that outlives the database.
 *
 * Pure. No Prisma, no clock, no environment — the runner wraps this and does the writes in one
 * transaction. Everything is a function between snapshots, which is what reversibility,
 * idempotence and partial failure all need and what `apply(mapping)` could not give.
 *
 * ALL-OR-NOTHING IS STRICTER THAN THE PRE-REGISTERED CONTRACT, DELIBERATELY. QA's design
 * refuses a moved row, names it, and continues. The operator asked for one refusable row to
 * abort the whole run before a single write — because a partial migration IS the
 * two-keying-schemes-at-once state, and he has chosen to make it unreachable rather than
 * detectable. A detectable bad state still has to be noticed by somebody.
 */

import { joinUnambiguously } from './alert-key-encoding.js'
import { type ExclusionKind } from './reconciliation.js'

/** THE FIELDS A NOTIFIER WATCHES. Named as a set because the property is about all of them.
 *
 * "Nothing was delivered" is not an output, so a seam with no notifier parameter only closes
 * the door somebody would knock on. THE REALISTIC ROUTE IS INDIRECT: a notifier watching
 * `occurrenceCount`, `resolvedAt` or `lastOccurredAt` turns a migration that touches one of
 * them into 364 messages without anything ever being called.
 *
 * NEITHER APPLY NOR REVERT WRITES ANY OF THESE — not by discipline, but because there is no
 * assignment to them anywhere in this file. The migration only ever writes two columns that
 * were null before it, which the schema forces (see the runbook), and that is why the same
 * guarantee covers revert for free: A REVERT CANNOT RESTORE `occurrenceCount` BECAUSE THE
 * APPLY NEVER CHANGED IT. */
export interface WatchedFields {
  readonly occurrenceCount: number
  readonly resolvedAt: string | null
  readonly lastOccurredAt: string
}

/** One notification as stored. */
export interface StoredRow extends WatchedFields {
  readonly id: string
  readonly organizationId: string
  readonly dedupeKey: string
  /** The two columns this migration owns. Null before it runs; null again after a revert. */
  readonly incidentKey: string | null
  readonly episode: number | null
}

export type StoredSnapshot = readonly StoredRow[]

/** WHAT THE DRY RUN SAW, not when it looked.
 *
 * A mapping is a photograph and the apply writes to the thing photographed, so through the
 * mapping alone a row that changed since it was measured and one that did not are the same
 * input. Re-running the dry run immediately before narrows the window; it cannot close it,
 * because the write still happens after the read. A TIMESTAMP SAYS WHEN SOMEBODY LOOKED; THIS
 * SAYS WHAT THEY SAW.
 *
 * WHAT IS IN IT, AND WHY IT IS NOT "ALL MUTABLE FIELDS": the digest covers the fields THE
 * MAPPING DEPENDS ON. `resolvedAt` is mutable and watched and is deliberately absent, because
 * a row resolved since the dry run still maps to the same incident — and under all-or-nothing,
 * including it does not refuse one row, it aborts the entire migration on ordinary churn.
 * Flagged in the runbook to be overruled there rather than here. */
export function digestOf(row: Pick<StoredRow, 'dedupeKey' | 'occurrenceCount'>): string {
  return joinUnambiguously(['apply-digest/v1', row.dedupeKey, String(row.occurrenceCount)])
}

/** One row's share of the approved mapping. Saved to disk before the apply and read back by
 * it, so what runs is the artefact that was approved rather than something recomputed. */
export interface MappingEntry {
  /** WRITE OR EXCLUDE, ON EVERY ROW THE MAPPING SAW.
   *
   * ADDED WHEN THE RULING CAME BACK AS (b) — key only the rows whose shape determines a
   * type. That makes 317 of 364 rows DELIBERATELY unwritable, and with the mapping being
   * only a list of writes, every one of them landed in the final loop below as
   * `ROW_UNEXPECTED`. **The preflight aborted with 317 differences, every time, by
   * construction.** Not a reporting nicety: the apply could never have run.
   *
   * The cause is that the scope of the run was INFERRED — "everything in the table" — so a
   * row left out on purpose and a row nobody had ever seen were the same input. They are
   * different facts and the report must not collapse them: one is a decision, the other is
   * an alert that arrived after the mapping was saved.
   *
   * So the mapping states its scope instead. A row it decided about is decided about,
   * whichever way; a row it never saw is still an abort, which is the original property
   * unchanged. */
  readonly decision: 'WRITE'
  readonly notificationId: string
  readonly incidentKey: string
  /** Null where the episode count could not be recovered — the 47 aggregate rows. Null is the
   * honest answer and is distinguishable from episode 1. */
  readonly episode: number | null
  /** What the dry run saw. */
  readonly observed: string
}

/** Why the mapping is not writing a row it saw. NOT A FAILURE, and not a `Difference`.
 *
 * `TYPE_UNDETERMINED` is the 317: `TYPE_FOR_SHAPE` maps `DIRECTORY_AUDIT` to null on purpose,
 * because the key shape does not determine the alert type and defaulting it would file real
 * privileged changes as routine. Migrating them as routine would be the defect this migration
 * exists to clear, re-entering through the migration.
 *
 * `SUBJECT_UNRESOLVED` is a row whose type IS determined but whose declared subject did not
 * resolve for THIS row — a missing audit join, an absent actor. Another row of the same shape
 * might resolve; this one did not.
 *
 * `SHAPE_CANNOT_NAME_SUBJECT` IS THE ONE THAT IS NOT WAITING FOR ANYTHING. The key shape has
 * no segment that could ever carry what its declared subject reads, so no classifier and no
 * future data changes it. `tenant:<id>:initial-sync` types to `monitoring.collector_failing`,
 * whose subject is COLLECTOR, which reads a resource type the shape cannot express.
 *
 * THREE REASONS RATHER THAN TWO because "left alone" was collapsing a row that clears when
 * the classifier lands with one that never clears. An operator reading one number waits for
 * something that is not coming, which is the same collapse this feature has refused five
 * times elsewhere.
 *
 * RE-EXPORTED, NOT REDECLARED. Deciding which of the three applies needs the catalogue and
 * the key grammar, so the vocabulary is owned by `reconciliation.ts` and this is an alias.
 * Two identical literal unions in two files are two things that can disagree. */
export type ExclusionReason = ExclusionKind

export interface Excluded {
  readonly decision: 'EXCLUDE'
  readonly notificationId: string
  readonly because: ExclusionReason
}

/** One decision per row the mapping saw. */
export type MappingDecision = MappingEntry | Excluded

/** THE MAPPING, WHICH IS A DECISION ABOUT A SET OF ROWS RATHER THAN A LIST OF WRITES.
 *
 * ONE LIST, NOT TWO. Writes and exclusions in separate fields would be two collections that
 * can disagree — a row in both, a row in neither, and nothing owning the answer. Here a row
 * has exactly one decision or it is not in the mapping at all, and `MAPPED_TWICE` names the
 * remaining way to get it wrong. */
export type Mapping = readonly MappingDecision[]

/** Why a run cannot proceed. Every variant names the row, because "4 problems" is not
 * something an operator can act on. */
export type Difference =
  | Readonly<{ kind: 'ROW_CHANGED'; notificationId: string; observed: string; now: string }>
  | Readonly<{ kind: 'ROW_MISSING'; notificationId: string }>
  | Readonly<{ kind: 'ROW_UNEXPECTED'; notificationId: string }>
  | Readonly<{ kind: 'ALREADY_KEYED_DIFFERENTLY'; notificationId: string; held: string; wanted: string }>
  /** A row the mapping deliberately excluded is carrying an incident key anyway. Somebody
   * else keyed it, which is the two-keying-schemes state the abort exists to prevent —
   * arriving through the rows we said not to touch. */
  | Readonly<{ kind: 'EXCLUDED_BUT_KEYED'; notificationId: string; held: string }>
  | Readonly<{ kind: 'MAPPED_TWICE'; notificationId: string }>

declare const VALIDATED: unique symbol

/** A run that has been checked and may proceed.
 *
 * BRANDED, SO THERE IS NO WAY TO APPLY WITHOUT VALIDATING. `applyValidated` takes one of these
 * and nothing else constructs one — "abort before writing anything" is then a property of the
 * shape rather than a rule the runner has to remember in the right order. */
export interface ValidatedRun {
  readonly writes: readonly Readonly<{
    notificationId: string
    previous: Readonly<{ incidentKey: string | null; episode: number | null }>
    next: Readonly<{ incidentKey: string; episode: number | null }>
    observed: string
    /** The version predicate, as COLUMNS rather than a digest, because the check has to be
     * expressible in SQL. A digest would force a read into the application to compute it --
     * which is the naive shape that lost every round of QA concurrency test. */
    expectedDedupeKey: string
    expectedOccurrenceCount: number
  }>[]
  /** Rows already carrying exactly this mapping. Not written again; counted so the operator
   * can tell a re-run from a first run. */
  readonly alreadyApplied: readonly string[]
  /** Rows the mapping saw and decided not to write, with why.
   *
   * CARRIED ON THE RUN so the operator sees the split BEFORE anything is written rather than
   * inferring it from a row count afterwards. Under ruling (b) this is the larger number, and
   * a preflight reporting "47 rows would be written" without saying what happened to the
   * other 317 is the same sentence whether the exclusion was deliberate or a bug. */
  readonly excluded: readonly Excluded[]
  readonly [VALIDATED]: true
}

export type ApplyDecision =
  | Readonly<{ proceed: true; run: ValidatedRun }>
  | Readonly<{ proceed: false; differences: readonly Difference[] }>

/** Check the saved mapping still describes reality. WRITES NOTHING, EVER.
 *
 * Aborts on any of: a mapping input changed, a row is missing, an unexpected row is present, or
 * a row is already keyed to something else. One is enough. */
export function validateApply(store: StoredSnapshot, mapping: Mapping): ApplyDecision {
  const byId = new Map(store.map((row) => [row.id, row]))
  const decided = new Set(mapping.map((entry) => entry.notificationId))
  const differences: Difference[] = []
  const writes: ValidatedRun['writes'][number][] = []
  const alreadyApplied: string[] = []
  const excluded: Excluded[] = []

  const seen = new Set<string>()
  for (const entry of mapping) {
    if (seen.has(entry.notificationId)) {
      differences.push({ kind: 'MAPPED_TWICE', notificationId: entry.notificationId })
      continue
    }
    seen.add(entry.notificationId)

    if (entry.decision === 'EXCLUDE') {
      const held = byId.get(entry.notificationId)
      // A ROW WE SAID NOT TO TOUCH THAT IS KEYED ANYWAY IS STILL AN ABORT. The exclusion is a
      // decision about what WE write, never a promise about what the row holds.
      if (held !== undefined && held.incidentKey !== null) {
        differences.push({
          kind: 'EXCLUDED_BUT_KEYED', notificationId: entry.notificationId,
          held: `${held.incidentKey}/${held.episode ?? 'null'}`,
        })
        continue
      }
      // A row the mapping excluded that is no longer in the table is not a problem: nothing
      // was going to be written to it. Recorded so the count still reconciles.
      excluded.push(entry)
      continue
    }

    const row = byId.get(entry.notificationId)
    if (row === undefined) {
      differences.push({ kind: 'ROW_MISSING', notificationId: entry.notificationId })
      continue
    }
    const now = digestOf(row)
    if (now !== entry.observed) {
      differences.push({ kind: 'ROW_CHANGED', notificationId: row.id, observed: entry.observed, now })
      continue
    }
    if (row.incidentKey !== null) {
      if (row.incidentKey === entry.incidentKey && row.episode === entry.episode) {
        alreadyApplied.push(row.id)
      } else {
        differences.push({
          kind: 'ALREADY_KEYED_DIFFERENTLY', notificationId: row.id,
          held: `${row.incidentKey}/${row.episode ?? 'null'}`,
          wanted: `${entry.incidentKey}/${entry.episode ?? 'null'}`,
        })
      }
      continue
    }
    writes.push({
      notificationId: row.id,
      previous: { incidentKey: row.incidentKey, episode: row.episode },
      next: { incidentKey: entry.incidentKey, episode: entry.episode },
      observed: entry.observed,
      expectedDedupeKey: row.dedupeKey,
      expectedOccurrenceCount: row.occurrenceCount,
    })
  }

  // A ROW THE MAPPING NEVER SAW IS A DIFFERENCE, NOT A NOTE. It was never measured, so no
  // digest can speak for it: apply while three alerts arrive and the table holds two keying
  // schemes with nothing saying so. Under all-or-nothing that state is unreachable.
  //
  // NOTE WHAT CHANGED AND WHAT DID NOT. This reads `decided`, not the write list — so a row
  // excluded on purpose is not a surprise, and a row that arrived after the mapping was saved
  // still is. The original property is intact; what it is measured against is now stated by
  // the mapping instead of inferred from the table.
  for (const row of store) {
    if (!decided.has(row.id)) differences.push({ kind: 'ROW_UNEXPECTED', notificationId: row.id })
  }

  return differences.length > 0
    ? { proceed: false, differences: sorted(differences) }
    : { proceed: true, run: { writes, alreadyApplied, excluded } as unknown as ValidatedRun }
}

/** What a run did, in enough detail to undo it WITHOUT CONSULTING THE DATABASE.
 *
 * That independence is the requirement: a receipt saying "see the table" is no use when the
 * table is the thing in doubt. Each entry carries the previous value, the value written, and
 * the digest the row had when written — so a revert can tell "still as I left it" from
 * "somebody has been here since". */
export interface ApplyReceipt {
  readonly runId: string
  readonly appliedAt: string
  readonly changed: readonly Readonly<{
    notificationId: string
    /** What the row held before this run wrote to it.
     *
     * FOR THIS MIGRATION IT IS ALWAYS NULL, and that is a measured fact rather than an
     * assumption: only a null-keyed row is ever written, so no reachable input makes this
     * anything else. A mutation replacing it with a hardcoded null survives the whole suite,
     * because the two are indistinguishable on every input the apply can accept.
     *
     * It is carried anyway because a revert that reads a recorded value is the shape that
     * stays correct if a later migration ever writes over a non-null key -- but any property
     * claiming it RESTORES A PREVIOUS VALUE is weaker than it reads, and no fixture here can
     * make it stronger. Recorded rather than contrived around. */
    previous: Readonly<{ incidentKey: string | null; episode: number | null }>
    written: Readonly<{ incidentKey: string; episode: number | null }>
    observed: string
  }>[]
  /** Rows that already carried the mapping and were not written. Recorded so every row in the
   * mapping is accounted for, and so a revert does not undo an earlier run's work. */
  readonly untouched: readonly string[]
}

/** Perform a validated run. Cannot be called without validating, because nothing else makes a
 * `ValidatedRun`. */
export function applyValidated(
  store: StoredSnapshot,
  run: ValidatedRun,
  runId: string,
  appliedAt: string,
): Readonly<{ after: StoredSnapshot; receipt: ApplyReceipt }> {
  const writes = new Map(run.writes.map((write) => [write.notificationId, write]))
  const after = store.map((row) => {
    const write = writes.get(row.id)
    return write === undefined ? row : { ...row, incidentKey: write.next.incidentKey, episode: write.next.episode }
  })
  return {
    after,
    receipt: {
      runId,
      appliedAt,
      changed: run.writes.map((write) => ({
        notificationId: write.notificationId,
        previous: write.previous,
        written: write.next,
        observed: write.observed,
      })),
      untouched: [...run.alreadyApplied].sort(),
    },
  }
}

/** What a revert did and declined to do.
 *
 * PER ROW, NOT WHOLESALE — the opposite of apply, and the asymmetry is the reason rather
 * than an inconsistency.
 *
 * The apply aborts wholesale because a partial migration is DANGEROUS FOR BEING SILENT:
 * the table holds two keying schemes and nothing records which rows are which, so it reads
 * as finished. A partial revert has no such silence — the receipt names every row this run
 * changed, and this report names which of them were put back and which were declined. The
 * state is described rather than inferred.
 *
 * And a declined row is not half-done work. It means somebody changed that row after this
 * run, so it is no longer ours to undo; leaving it alone is the correct answer, not a
 * partial one. Refusing the other 363 as well would block a recovery action over a row the
 * revert was right to skip — during an incident, which is when reverts happen. */
export interface RevertReceipt {
  readonly runId: string
  readonly revertedAt: string
  /** Rows put back to null. */
  readonly reverted: readonly string[]
  /** Rows this run changed but no longer owns, with why. Empty is a complete revert. */
  readonly refused: readonly Difference[]
}

export type RevertDecision = Readonly<{
  rows: readonly string[]
  refused: readonly Difference[]
}>

/** Which rows a revert may put back, and which it must decline.
 *
 * NEVER A BLANKET UPDATE — it reads the receipt and touches only the rows that run changed,
 * and only where they are still exactly as it left them. Declining is per row; see
 * `RevertReceipt` for why this differs from the apply. */
export function validateRevert(store: StoredSnapshot, receipt: ApplyReceipt): RevertDecision {
  const byId = new Map(store.map((row) => [row.id, row]))
  const differences: Difference[] = []
  const rows: string[] = []

  for (const entry of receipt.changed) {
    const row = byId.get(entry.notificationId)
    if (row === undefined) {
      differences.push({ kind: 'ROW_MISSING', notificationId: entry.notificationId })
      continue
    }
    // THE TWO VERSION CHECKS HAVE DIFFERENT SCOPES, AND THIS IS THE TRAP.
    //
    // Apply checks every mapping input: if anything moved, the mapping describes a situation
    // that no longer exists. REVERT CHECKS `incidentKey` AND `episode` ONLY.
    //
    // I had `digestOf(row) !== entry.observed` here — apply's check, reused — and reusing it
    // LOOKS LIKE CONSISTENCY, which is exactly why it is the trap. Occurrences arrive between
    // apply and revert; that is the system working. A row reading 301 at apply time may read
    // 305 an hour later, and apply's digest covers `occurrenceCount`, so the revert would
    // have refused every row within five minutes of any new event — un-runnable by design, at
    // precisely the moment somebody needs it.
    //
    // With the narrow scope a refusal means somebody re-keyed this incident since the receipt,
    // which is genuinely exceptional rather than routine.
    if (row.incidentKey !== entry.written.incidentKey || row.episode !== entry.written.episode) {
      differences.push({
        kind: 'ALREADY_KEYED_DIFFERENTLY', notificationId: row.id,
        held: `${row.incidentKey ?? 'null'}/${row.episode ?? 'null'}`,
        wanted: `${entry.written.incidentKey}/${entry.written.episode ?? 'null'}`,
      })
      continue
    }
    rows.push(row.id)
  }

  return { rows, refused: sorted(differences) }
}

/** Undo one run's changes — RESTORING ONLY THE FIELDS THE APPLY CHANGED — and say what
 * happened.
 *
 * A REVERT THAT RESTORES THE ROW AS THE RECEIPT FOUND IT DESTROYS REAL EVENTS. Occurrences
 * arrive between apply and revert; a row reading 301 at apply time may read 305 by the time
 * anyone reverts, and writing the snapshot back rolls it to 301 — four real events gone. And
 * `occurrenceCount` is a watched field, so the same write can deliver. Both failures are one
 * mistake: reading "restore the prior state" as "restore the prior row".
 *
 * THE RECEIPT MAKES THAT EASIER TO GET WRONG, NOT HARDER, because the old values sit in it
 * looking authoritative. It exists to make revert safe and it is the thing that would tempt
 * somebody into the unsafe version. So this writes two columns and nothing else — which is
 * also how the no-delivery guarantee stays true for revert.
 *
 * THE REPORT IS WHAT MAKES PER-ROW SAFE. A partial revert is acceptable because it is
 * described: every row put back is listed, every row declined is listed with why, and the
 * pair accounts for the whole receipt. Without that this would be the apply's silent
 * mixed state wearing a different name. */
export function revertValidated(
  store: StoredSnapshot,
  receipt: ApplyReceipt,
  decision: RevertDecision,
  revertedAt: string,
): Readonly<{ after: StoredSnapshot; receipt: RevertReceipt }> {
  const restore = new Map(receipt.changed.map((entry) => [entry.notificationId, entry.previous]))
  const touching = new Set(decision.rows)
  const after = store.map((row) => {
    if (!touching.has(row.id)) return row
    const previous = restore.get(row.id)
    return previous === undefined ? row : { ...row, incidentKey: previous.incidentKey, episode: previous.episode }
  })
  return {
    after,
    receipt: {
      runId: receipt.runId,
      revertedAt,
      reverted: [...decision.rows].sort(),
      refused: decision.refused,
    },
  }
}

/** Which rows had a watched field modified between two snapshots. Empty is healthy.
 *
 * EXPORTED SO IT CAN BE TESTED AT ALL. No input makes apply or revert write these fields, so in
 * place this is a TRIPWIRE against a future change rather than an input-falsifiable check — a
 * mutation disabling it survived the whole suite until it was tested directly. */
export function watchedFieldsDisturbedBetween(
  before: StoredSnapshot,
  after: StoredSnapshot,
): readonly string[] {
  const seen = new Map(after.map((row) => [row.id, row]))
  return before
    .filter((row) => { const now = seen.get(row.id); return now !== undefined && watchedOf(row) !== watchedOf(now) })
    .map((row) => `${row.id}: a field a notifier watches was modified`)
}

/** Any sentinel works because the join is length-prefixed: a resolvedAt that literally read
 * '(not set)' would still encode differently from an absent one. Printable rather than a NUL,
 * because a NUL in source makes git and grep treat the file as binary -- which is how this one
 * was noticed. */
const NOT_SET = '(not set)'
const watchedOf = (row: StoredRow): string =>
  joinUnambiguously([row.id, String(row.occurrenceCount), row.resolvedAt ?? NOT_SET, row.lastOccurredAt])

const sorted = (differences: readonly Difference[]): readonly Difference[] =>
  [...differences].sort((left, right) => left.notificationId.localeCompare(right.notificationId))

/** The abort report, as an operator reads it. Grouped by kind, every row named.
 *
 * A COUNT IS NOT SOMETHING SOMEBODY CAN ACT ON at the moment they are deciding whether to run
 * a migration against production. */
export function explain(differences: readonly Difference[]): string {
  if (differences.length === 0) return 'No differences. The mapping still describes the data.'
  const lines = [`ABORTED - ${differences.length} difference(s). Nothing was written.`, '']
  const say: Record<Difference['kind'], string> = {
    ROW_CHANGED: 'changed since the mapping was saved',
    ROW_MISSING: 'in the mapping but not in the table',
    ROW_UNEXPECTED: 'in the table but not in the mapping (arrived after the mapping was saved)',
    ALREADY_KEYED_DIFFERENTLY: 'already carries a different incident key',
    EXCLUDED_BUT_KEYED: 'excluded by the mapping, but carries an incident key already',
    MAPPED_TWICE: 'decided about more than once by the mapping',
  }
  for (const kind of Object.keys(say) as Difference['kind'][]) {
    const of = differences.filter((difference) => difference.kind === kind)
    if (of.length === 0) continue
    lines.push(`${of.length} ${say[kind]}:`)
    for (const difference of of) {
      lines.push(difference.kind === 'ROW_CHANGED'
        ? `  ${difference.notificationId}  saw ${difference.observed}  now ${difference.now}`
        : difference.kind === 'ALREADY_KEYED_DIFFERENTLY'
          ? `  ${difference.notificationId}  holds ${difference.held}  mapping says ${difference.wanted}`
          : difference.kind === 'EXCLUDED_BUT_KEYED'
            ? `  ${difference.notificationId}  holds ${difference.held}  mapping says leave it alone`
            : `  ${difference.notificationId}`)
    }
    lines.push('')
  }
  return lines.join('\n')
}

/** THE WRITE, AS ONE STATEMENT. Emitted here so the runner cannot quietly become a loop.
 *
 * MEASURED, at 364 rows: a per-row UPDATE is 395 ms on loopback and 5,623 ms with a 14.5 ms
 * round trip; one statement is 12 ms either way, because it is one round trip. THE DRIVER IS
 * ROUND TRIPS MULTIPLIED BY LATENCY, NOT ROW COUNT — per row, 364 to 5,000 rows is only 395 ms
 * to 1,034 ms, under 3x for 14x the rows.
 *
 * That matters more than usual here because production is not loopback: Supabase in
 * ca-central-1 with the backend on Render is a real network hop, and nobody has measured it.
 * **The shape that does not depend on the number is the one to ship.**
 *
 * AND IT KEEPS EVERY GUARANTEE. Still all-or-nothing — the runner compares the returned row
 * count against `expectedRowCount` and rolls back if they differ. Still version-checked per
 * row: THE CHECK MOVES INTO THE JOIN CONDITION rather than a loop, so the check and the write
 * remain one statement, which was always the property. A bulk statement satisfies it more
 * obviously than a loop does.
 *
 * The alternative was a runbook telling the operator to pick a quiet moment. YOU DO NOT NEED A
 * MAINTENANCE WINDOW IF THE WINDOW IS TWELVE MILLISECONDS — a structural mitigation rather than
 * an operational one. */
export interface BulkStatement {
  /** One statement. Not a template to run per row. */
  readonly sql: string
  readonly params: readonly unknown[]
  /** The runner MUST compare the driver's reported row count against this and roll back on any
   * difference. That comparison is the all-or-nothing guarantee; the statement alone only
   * declines the rows whose version moved. */
  readonly expectedRowCount: number
}

/** The apply, as one conditional UPDATE.
 *
 * The version predicate is `dedupe_key` and `occurrence_count` — apply's scope, every mapping
 * input — plus `incident_key IS NULL` so a row somebody else keyed is declined by the database
 * rather than by application logic. */
export function applyStatement(run: ValidatedRun): BulkStatement {
  const params: unknown[] = []
  const rows = run.writes.map((write) => {
    const at = params.length
    params.push(write.notificationId, write.next.incidentKey, write.next.episode,
      write.expectedDedupeKey, write.expectedOccurrenceCount)
    return `($${at + 1}::uuid, $${at + 2}::varchar, $${at + 3}::int, $${at + 4}::varchar, $${at + 5}::int)`
  })

  return {
    sql: [
      'UPDATE notifications AS n',
      'SET incident_key = v.incident_key, episode = v.episode',
      `FROM (VALUES ${rows.join(', ')})`,
      'AS v(id, incident_key, episode, expected_dedupe_key, expected_occurrence_count)',
      'WHERE n.id = v.id',
      '  AND n.incident_key IS NULL',
      '  AND n.dedupe_key = v.expected_dedupe_key',
      '  AND n.occurrence_count = v.expected_occurrence_count',
    ].join('\n'),
    params,
    expectedRowCount: run.writes.length,
  }
}

/** The revert, as one conditional UPDATE.
 *
 * DELIBERATELY A NARROWER PREDICATE THAN THE APPLY'S, and this is B8 expressed in SQL: there is
 * no `occurrence_count` here. Occurrences arriving between apply and revert are the system
 * working, and a revert that checked them would refuse every row within five minutes of any new
 * event — un-runnable at the moment somebody needs it.
 *
 * `expectedRowCount` is the rows the decision approved, and the runner reports rather than
 * rolls back on a shortfall: the revert refuses per row and says which. */
export function revertStatement(
  receipt: ApplyReceipt,
  decision: RevertDecision,
): BulkStatement {
  const approved = new Set(decision.rows)
  const params: unknown[] = []
  const rows = receipt.changed
    .filter((entry) => approved.has(entry.notificationId))
    .map((entry) => {
      const at = params.length
      params.push(entry.notificationId, entry.written.incidentKey, entry.written.episode)
      return `($${at + 1}::uuid, $${at + 2}::varchar, $${at + 3}::int)`
    })

  return {
    sql: [
      'UPDATE notifications AS n',
      'SET incident_key = NULL, episode = NULL',
      `FROM (VALUES ${rows.join(', ')})`,
      'AS v(id, written_incident_key, written_episode)',
      'WHERE n.id = v.id',
      '  AND n.incident_key = v.written_incident_key',
      '  AND n.episode IS NOT DISTINCT FROM v.written_episode',
    ].join('\n'),
    params,
    expectedRowCount: rows.length,
  }
}
