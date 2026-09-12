import { ALERT_CATALOG } from './alert-catalog.js'
import { episodesOf } from './alert-episode.js'
import { quietIntervalMsOf } from './alert-episode-interval.js'
import { eventInstant } from './alert-event-time.js'
import { incidentGrouping, type Grouping, type ResolvedSubject } from './alert-incident-key.js'
import type { AlertTypeDeclaration, SubjectRole } from './alert-type.js'

/** The step-03 dry run: what the existing notifications become, as a report.
 *
 * WRITES NOTHING. This is a pure function from rows to a report — no Prisma client, no
 * clock, no environment. The runner beside it does a read-only query and prints this; the
 * decision to apply anything is a separate step and a separate approval.
 *
 * THREE SAFETY PROPERTIES, AND THE GENERATOR CHECKS ITS OWN:
 *
 * 1. EVERY ROW APPEARS EXACTLY ONCE in the mapping. A reconciliation that loses rows is
 *    the failure that matters, and "364 became 51" is indistinguishable from "364 became
 *    51 and we dropped 12" unless something counts.
 * 2. THE MAPPING IS REVERSIBLE. Each entry carries the original notification id, so the
 *    inverse is derivable without re-deriving anything. Nothing is applied on the strength
 *    of a report that cannot be undone.
 * 3. AN UNRECOGNISED KEY IS REPORTED, NEVER DROPPED. The catalogue of key shapes is an
 *    allow-list, and unlisted is not harmless — the same rule the classifier holds for
 *    permissions. A shape nobody anticipated is the finding, not a rounding error.
 */

/** The key shapes the current system actually produces.
 *
 * Taken from the `dedupeKey:` literals in the codebase rather than from the keys found in
 * data — a list derived from production rows would describe what happens to be there and
 * would silently omit any shape that has not fired yet. */
export type KeyShape =
  /** `security:directory-audit:{microsoftAuditId}` — the 301. Carries an event id, so it
   * deduplicates perfectly and groups not at all. */
  | 'DIRECTORY_AUDIT'
  /** `tenant:{id}:sync:{resourceType}` — the 334 occurrences collapsed into 15. No event
   * id, so it groups everything and deduplicates nothing. */
  | 'TENANT_SYNC'
  | 'TENANT_CONNECTION'
  | 'TENANT_INITIAL_SYNC'
  | 'TENANT_ONBOARDING'
  /** `{anyKey}:recovered:{occurrenceCount}` — a recovery derived from another key.
   *
   * THE OCCURRENCE COUNT IS IN THE KEY, which means the same logical recovery produces a
   * different key every time the count moves. That is the 301 defect one layer over: a
   * counter embedded in an identity makes the identity non-repeating. Worth reporting
   * separately rather than folding into its parent, because the count is how many of these
   * exist for one underlying incident. */
  | 'RECOVERY'
  | 'UNRECOGNISED'

export interface ParsedKey {
  readonly shape: KeyShape
  /** The tenant id the key names, where the shape carries one. */
  readonly tenantIdInKey: string | null
  /** The source's own event id, where the shape carries one. */
  readonly eventIdInKey: string | null
  /** For RECOVERY, the key it was derived from. */
  readonly recoveryOf: string | null
  /** For TENANT_SYNC, the resource type. */
  readonly resourceType: string | null
  /** For DIRECTORY_AUDIT, the category Microsoft prefixes onto the audit id.
   *
   * FOUND IN PRODUCTION, NOT IN THE CODE. The key is built as
   * `security:directory-audit:${record.microsoftAuditId}`, and the audit ids Microsoft
   * issues carry a category prefix: Directory_, SSPR_, PIM_, "Authentication Methods_".
   * Measured across the 364: 268 Directory, 45 SSPR, 3 PIM, 1 Authentication Methods.
   *
   * Worth extracting because it is the only signal in the key about WHAT the change was,
   * and the type a directory-audit row becomes is exactly the question the key shape could
   * not answer. PIM is Privileged Identity Management, which is a strong candidate for the
   * privileged type. It is reported rather than mapped: a category is a hint about the
   * subject area, not a classification, and guessing from it here would be the same
   * shortcut as defaulting the type. */
  readonly auditCategory: string | null
}

const unparsed = (shape: KeyShape): ParsedKey =>
  ({ shape, tenantIdInKey: null, eventIdInKey: null, recoveryOf: null, resourceType: null, auditCategory: null })

/** Parses a dedupe key into its shape, without guessing.
 *
 * RECOVERY IS CHECKED FIRST because its shape is a SUFFIX on another key — and a recovery
 * of a sync alert matches the sync pattern too. Checking in the other order would classify
 * every recovery as whatever it recovered, and the count of recoveries is precisely what
 * this step needs to see. */
export function parseDedupeKey(dedupeKey: string): ParsedKey {
  const recovery = /^(.*):recovered:(\d+)$/.exec(dedupeKey)
  if (recovery) {
    return { ...unparsed('RECOVERY'), recoveryOf: recovery[1] ?? null }
  }

  const audit = /^security:directory-audit:(.+)$/.exec(dedupeKey)
  if (audit) {
    const eventId = audit[1] ?? null
    // The WHOLE remainder stays the event id, because that is what joins to
    // microsoftAuditId — all 317 production rows joined, so the parse is right. The
    // category is additionally extracted, not substituted.
    const category = /^([A-Za-z][A-Za-z ]*)_/.exec(eventId ?? '')
    return { ...unparsed('DIRECTORY_AUDIT'), eventIdInKey: eventId, auditCategory: category?.[1] ?? null }
  }

  const sync = /^tenant:([^:]+):sync:(.+)$/.exec(dedupeKey)
  if (sync) {
    return { ...unparsed('TENANT_SYNC'), tenantIdInKey: sync[1] ?? null, resourceType: sync[2] ?? null }
  }

  const connection = /^tenant:([^:]+):connection$/.exec(dedupeKey)
  if (connection) return { ...unparsed('TENANT_CONNECTION'), tenantIdInKey: connection[1] ?? null }

  const initial = /^tenant:([^:]+):initial-sync$/.exec(dedupeKey)
  if (initial) return { ...unparsed('TENANT_INITIAL_SYNC'), tenantIdInKey: initial[1] ?? null }

  const onboarding = /^tenant:([^:]+):onboarding-authorized$/.exec(dedupeKey)
  if (onboarding) return { ...unparsed('TENANT_ONBOARDING'), tenantIdInKey: onboarding[1] ?? null }

  return unparsed('UNRECOGNISED')
}

/** Which declared alert type a shape becomes.
 *
 * `null` where the shape alone does not determine it. A directory-audit row becomes the
 * privileged or the routine type depending on what the change WAS, which needs the audit
 * record — so it is reported as needing classification rather than assigned a default.
 * Defaulting would put real privileged changes into the routine type, which is the
 * 301-alerts problem arriving from the migration instead of from the collector. */
export const TYPE_FOR_SHAPE: Readonly<Record<KeyShape, string | null>> = {
  DIRECTORY_AUDIT: null,
  TENANT_SYNC: 'monitoring.collector_failing',
  TENANT_CONNECTION: 'monitoring.tenant_disconnected',
  TENANT_INITIAL_SYNC: 'monitoring.collector_failing',
  TENANT_ONBOARDING: null,
  RECOVERY: 'monitoring.recovered',
  UNRECOGNISED: null,
}

/** One existing notification, plus what a read-only join can add.
 *
 * `audit` is null when the key names an audit record the join did not find — reported, not
 * guessed. A missing join is a fact about our data and belongs in the report. */
export interface ExistingAlertRow {
  readonly id: string
  readonly organizationId: string
  readonly customerTenantId: string | null
  readonly dedupeKey: string
  readonly occurrenceCount: number
  readonly resolvedAt: Date | null
  /** The event's OWN time, where it is recoverable.
   *
   * Present for directory-audit rows, which are one-to-one with an audit record carrying
   * `event_date_time`. Absent for the aggregate shapes: a sync alert with
   * `occurrenceCount: 42` represents forty-two events at unknown individual times —
   * `first_occurred_at` and `last_occurred_at` give the span and nothing inside it.
   *
   * OPTIONAL, AND ITS ABSENCE IS REPORTED RATHER THAN DEFAULTED. Episodes are genuinely
   * unreconstructable without it, and inventing a time would be fabrication. An incident
   * whose episodes cannot be recovered is reported as an unknown number of episodes, never
   * as one — the same refusal to collapse NOT_AVAILABLE into a value that this product
   * makes everywhere else. */
  readonly occurredAt?: Date | null
  readonly audit: Readonly<{
    initiatedBy: string | null
    targetResources: readonly string[]
    privileged: boolean | null
  }> | null
}

export interface MappingEntry {
  readonly notificationId: string
  readonly dedupeKey: string
  /** The occurrences this row represents, carried into the mapping.
   *
   * Needed by the apply phase — consolidating must preserve the events, and an entry that
   * does not say how many it carries cannot be applied without going back to the source.
   * It is also what makes `occurrencesPreserved` a real check rather than a tautology:
   * with it, the two sides of that comparison are built by different code paths. */
  readonly occurrenceCount: number
  readonly shape: KeyShape
  readonly alertTypeId: string | null
  /** The incident this row joins, or null when it cannot be grouped. */
  readonly incidentKey: string | null
  /** Why, in a sentence, for every row including the grouped ones. A mapping a person
   * cannot audit row by row is not reversible in the sense that matters. */
  readonly because: string
}

export interface ReconciliationReport {
  readonly total: number
  readonly byShape: Readonly<Record<KeyShape, number>>
  /** Distinct unrecognised keys, with one example each. Reported rather than counted
   * alone, because the shape is the finding. */
  readonly unrecognisedExamples: readonly string[]
  /** Audit categories found in the directory-audit keys, with counts. The only signal in
   * the key about what the change was, and therefore the first place to look when deciding
   * the types those rows should become. Reported, never mapped. */
  readonly auditCategories: Readonly<Record<string, number>>
  /** Occurrences behind the rows — the events the 301 and the 334 actually represent.
   * Consolidating must preserve these, so the report states them. */
  readonly occurrencesRepresented: number
  readonly incidents: Readonly<{
    /** Under the subject role each type declares, counting only rows whose type the key
     * shape determines. Rows needing classification are NOT grouped here. */
    declared: number
    /** The same rows keyed on the target instead, for comparison only. */
    ifKeyedOnTarget: number
    /** THE NUMBER TO PUT IN FRONT OF A PERSON, and it is a FLOOR rather than an answer.
     *
     * The 317 directory-audit rows cannot be grouped without knowing which type each
     * became, because the incident key contains the type id — one actor's privileged change
     * and their routine change are correctly different incidents. So `declared` above
     * excludes them entirely, which is honest and unhelpful.
     *
     * These two count the same rows with every undetermined row treated as ONE nominated
     * type. That makes them computable, and it makes them a LOWER BOUND: classification can
     * only split an actor's events across two types, never merge them. The real number is
     * this or higher, never lower, and saying "68 incidents" without that is an
     * understatement presented as a measurement. */
    assumingSingleType: number
    assumingSingleTypeKeyedOnTarget: number
    /** THE SAME BOUND, RESTRICTED TO DIRECTORY-AUDIT ROWS.
     *
     * Exists so two instruments can be compared. The production figures were computed with
     * SQL directly, filtering on `dedupe_key like 'security:directory-audit:%'` before
     * grouping — so they cover only that shape, while `assumingSingleType` above covers
     * EVERY row. Comparing those two would be comparing different subsets and finding a
     * disagreement that was never there.
     *
     * These two are the like-for-like pair. If they disagree with the SQL, one instrument is
     * wrong and that is worth finding before either number reaches a decision. */
    assumingSingleTypeDirectoryAuditOnly: number
    assumingSingleTypeDirectoryAuditOnlyKeyedOnTarget: number
    /** Rows whose declared subject did not resolve, AMONG ROWS WHOSE TYPE IS DETERMINED.
     *
     * THE RESTRICTION IS IN THE NAME BECAUSE IT WAS INVISIBLE AND LOAD-BEARING. This was
     * `unattributed`, which reads as "rows we could not attribute" — and it is
     * STRUCTURALLY ZERO for every directory-audit row, because the increment sits after
     * the `declaration === null` branch returns and every such row takes that branch. So
     * the figure most likely to be quoted as "how many could we not attribute" was the
     * one figure guaranteed not to answer it, and its correct value (0) is
     * indistinguishable from a broken one.
     *
     * AN UNCONSTRAINED FIGURE THAT IS ALSO ALWAYS ZERO IS THE QUIETEST PLACE A WRONG
     * NUMBER CAN SIT. For the question this name used to imply, read
     * `episodes.rowsStandingAloneBecauseSubjectUnresolved`, which covers every row. */
    declaredSubjectUnresolvedAmongTypedRows: number
    /** Its complement, and `withDeterminedType` above them both, so the three reconcile
     * rather than standing alone — see `invariants.rowCountsAddUp`. */
    declaredSubjectResolvedAmongTypedRows: number
    /** Rows whose alert type the key shape determines. */
    withDeterminedType: number
    /** Rows whose alert type the shape alone does not determine. */
    needingClassification: number
  }>
  /** EPISODES, WHICH THE INCIDENT KEY DOES NOT CARRY.
   *
   * The key identifies a stream — type, organization, tenant, subject — and deliberately
   * contains no episode component. So an incident count answers "how many distinct subjects
   * are involved", not "how many separate bursts of activity happened", and across a
   * two-month window those are very different numbers. Reporting the first as though it
   * were the second would produce exactly the incidents episodes exist to prevent: every
   * change by one actor over two months collapsed into one, so an attack next month joins
   * last month's closed incident and nobody is told.
   *
   * Counted with step 02's `episodesOf` rather than a second implementation, at the quiet
   * interval the nominated type declares, which is reported alongside so the number is
   * auditable. */
  readonly episodes: Readonly<{
    /** Episodes across incidents where EVERY row carries its own event time. */
    counted: number
    /** The two halves of `counted`, so the identity that validates it is PRINTED.
     *
     * 71 = 62 + 9 was reconciled by hand, in a message, using an attributed-episode count
     * the report did not expose — so the identity that made the headline figure credible
     * could not be reproduced by anyone reading the output. That is the difference between
     * a number having been verified once and a number staying verified.
     *
     * See `invariants.episodeCountsAddUp`. */
    fromAttributedRows: number
    fromStandingAloneRows: number
    /** THE SAME SPLIT ON THE DIRECTORY-ONLY FIGURE, which is the one a person quotes.
     *
     * The first attempt at this decomposed `counted` (all shapes) and left
     * `countedDirectoryAuditOnly` — the figure the audit named — still standing alone. The
     * two sit adjacent and differ only in scope, which is exactly why the fix landed on the
     * wrong one: ADJACENCY IS WHERE A FIX GOES WRONG, because the neighbour looks
     * interchangeable with the thing that was asked for.
     *
     * With these, `71 = 62 + 9` is reproducible from the output. See
     * `invariants.episodeCountsAddUp`. */
    fromAttributedRowsDirectoryAuditOnly: number
    fromStandingAloneRowsDirectoryAuditOnly: number
    /** Standing-alone rows whose single episode could NOT be placed, and its attributed
     * counterpart.
     *
     * Why 34 standing-alone rows yield 30 episodes rather than 34: a standing-alone bucket
     * holds exactly one row, so it contributes exactly one episode or none, and none
     * happens when the row carries several events at unknown times — many events with no
     * times is the case that genuinely cannot be computed. A SINGLE timeless event still
     * counts as one, so "no event time" is NOT the dividing line; "several events, no
     * times" is. That distinction is not guessable from the other figures, which is why
     * this one is printed rather than left to be inferred. */
    standingAloneRowsWithUnrecoverableEpisodes: number
    attributedIncidentsWithUnrecoverableEpisodes: number
    /** Same, restricted to directory-audit rows — the like-for-like comparison. */
    countedDirectoryAuditOnly: number
    /** Incidents whose episode count cannot be recovered because at least one row carries
     * no event time. NOT counted as one episode each: unknown is not one. */
    incidentsWithUnrecoverableEpisodes: number
    /** Rows carrying no event time at all.
     *
     * THIS FIELD ONCE LIED, AND THE NAME WAS NEVER THE PROBLEM. It was summed as
     * `rowsWithoutTime += bucket.missing` over the incident buckets, and ungrouped rows were
     * never bucketed — so the figure silently excluded exactly the rows the bucketing bug had
     * dropped. It read 22 where the answer was 47, on an input where 364 - 317 = 47 is
     * checkable by hand, and nothing announced the correction when the bucketing was fixed:
     * the number simply got better, which is the worst way for a number to change.
     *
     * It is now counted PER ROW, where the fact is known, with `rowsWithEventTime` beside it
     * so the two must add to `total` — see `invariants.eventTimeCountsAddUp`. A COUNTER
     * DERIVED FROM A STRUCTURE INHERITS THAT STRUCTURE’S OMISSIONS, and the cheapest defence
     * is an arithmetic identity the report checks on itself. */
    rowsWithoutEventTime: number
    /** Rows carrying one. Reported only so the pair has something to disagree with: a lone
     * count cannot be wrong, while a pair that must sum to a known total can. */
    rowsWithEventTime: number
    /** Rows whose declared subject did not resolve, so each STANDS ALONE as its own
     * single-event incident rather than merging with the other unresolved ones.
     *
     * NAMED BECAUSE IT WAS INFERABLE ONLY BY SUBTRACTION. These rows are counted in
     * `total`, in `byShape` and in `needingClassification`, and until this field existed
     * they then vanished from the episode accounting with no number saying how many or
     * why — absence resolving to silence, in the report whose whole purpose is to make
     * absences countable. They were in fact being DROPPED, and the missing count is what
     * let that sit unnoticed through two readings.
     *
     * It is also the number two instruments will most often disagree about, because
     * coalescing them onto one literal 'UNATTRIBUTED' actor is the obvious thing to do in
     * SQL and it asserts a relationship nothing evidences. Reported separately so the
     * disagreement is visible in the output rather than recoverable only by arithmetic. */
    rowsStandingAloneBecauseSubjectUnresolved: number
    /** The same rows broken down by key shape, so the total is DERIVABLE FROM THE OTHER SIDE.
     *
     * A bare 34 is a number nobody can check. The breakdown says which shapes contribute and
     * therefore why, and each reason is a property of the key rather than of the data: a
     * directory row stands alone when the audit record names no initiator; initial-sync and
     * recovery keys name no resource type, so the COLLECTOR subject cannot resolve; onboarding
     * and unrecognised shapes determine no alert type, so they reach the nominated type’s
     * ACTOR subject with no audit record to resolve it. Anyone can count those shapes in SQL
     * and compare, which is the whole point — an unverifiable figure in a reconciliation
     * report is not evidence, it is a claim. */
    standingAloneByShape: Partial<Record<KeyShape, number>>
    /** The interval the count used, from the nominated type's declaration. */
    quietIntervalHours: number
  }>
  readonly mapping: readonly MappingEntry[]
  /** The generator's checks on its own output — as LISTS, not booleans.
   *
   * They were booleans, and a mutation hardcoding `everyRowMappedExactlyOnce: true`
   * survived every test: no input can make the generator drop a row, so a computed `true`
   * and a hardcoded one are indistinguishable. The most important invariant was the one
   * nothing guarded.
   *
   * Naming the offending ids fixes that the same way removing the coverage boolean did. A
   * hardcoded empty array is still writable, but the lists come from set arithmetic over
   * the input and the mapping, and `duplicatedNotificationIds` IS reachable — a query with
   * a bad join returns the same notification twice, which is a realistic failure and now a
   * tested one. The arithmetic that finds it is the same arithmetic behind the other list.
   *
   * They live in the report rather than in a test so that a run against different data
   * carries its own verification. */
  readonly invariants: Readonly<{
    /** Input ids absent from the mapping. Empty is healthy; anything here means rows were
     * lost, and "364 became 51" hides that perfectly without it.
     *
     * A TRIPWIRE, NOT A TESTED PROPERTY, and said so rather than implied. No input can make
     * this generator drop a row — both branches push — so a hardcoded empty array passes
     * every test and a mutation doing exactly that survives. It earns its place as a guard
     * on a FUTURE change that adds a skipping branch, which is a real risk in a migration
     * that will grow cases. Do not read an empty list here as evidence the mapping is
     * complete; read it as the alarm not having gone off.
     *
     * What is genuinely tested is the arithmetic it shares with the list below, where a
     * duplicated input id is reachable and caught. */
    rowsMissingFromMapping: readonly string[]
    /** Ids appearing more than once across the input. A duplicate means the report's counts
     * are inflated and the mapping is not a function of the notification. */
    duplicatedNotificationIds: readonly string[]
    /** Occurrences counted in the MAPPING against occurrences counted in the INPUT.
     *
     * IT WAS VACUOUS. It compared a loop accumulator against a reduce over the same array
     * with the same addition — both sides equally wrong and therefore always agreeing.
     * Searched for a falsifying input: ordinary, zero, negative, MAX_SAFE_INTEGER,
     * fractional values where addition is not associative, 200,000 random sets. Nothing,
     * except `Infinity + -Infinity` giving NaN, which is an artefact rather than a guard.
     *
     * And its comment was worse than the code — it said the events are preserved "so that
     * applying the mapping can be checked against it", which reads as a check on
     * consolidation when the mapping was not involved in the computation at all. Its
     * sibling honestly calls itself a tripwire; this one did not, so a reader comparing
     * them would take the unlabelled one for the stronger and it was the weaker.
     *
     * Now the two sides come from different places: the mapping's own entries against the
     * input rows. A future change that drops an entry, duplicates one, or loses a count in
     * transit makes them disagree — verified by corrupting a mapping entry's count, which
     * fails a test where the old form could not have.
     *
     * WHAT IS STILL TRUE OF IT, stated so it is not read as more than it is: no INPUT can
     * make it false, so hardcoding the field true still passes. That is the same
     * reporting-surface weakness rowsMissingFromMapping carries, and the same honest label
     * applies. The difference from before is not cosmetic though — the old version was
     * tautological as a COMPUTATION and would have reported true over a broken generator;
     * this one catches exactly that. A real check whose reported value is a tripwire,
     * rather than a tripwire wearing the words of a real check. */
    /** The REPORTED occurrence figure against both sums it should equal. Empty means they
     * agree; otherwise it names the discrepancy.
     *
     * THE BOOLEAN IT REPLACES COMPARED TWO INTERNAL SUMS AND TOUCHED NEITHER REPORTED
     * FIGURE. Perturbing `occurrencesRepresented` left it reading true, so a reader saw
     * 699 with the word "preserved" beside it and concluded the number was checked. A
     * misleading neighbour is worse than no neighbour: an unchecked figure standing alone
     * is merely unverified, while one standing beside a boolean that looks like a
     * guarantee is actively miscredited. It now reads the field it vouches for. */
    occurrenceCountsAddUp: readonly string[]
    /** Whether the event-time counts add up: withTime + withoutTime === total.
     *
     * ADDED BECAUSE A METRIC CORRECTED ITSELF IN SILENCE. `rowsWithoutEventTime` was
     * derived by summing over the incident buckets, which excluded ungrouped rows, so it
     * read 22 against a true 47 — and the only reason anyone noticed is that a reader
     * happened to have the arithmetic to check it against. That reader should not have to
     * be the check.
     *
     * A LIST, NOT A BARE BOOLEAN, so it names the discrepancy rather than only its
     * existence. Empty means it adds up.
     *
     * AND IT IS A TRIPWIRE, NOT AN INPUT-FALSIFIABLE CHECK — the same honest label
     * `occurrencesPreserved` carries, and I first wrote the opposite here. NO INPUT can make
     * this fail: both counters are incremented in one pass over the same rows, exactly once
     * each, so the identity holds by construction. A mutation hardcoding it empty survived
     * every test, which is the proof. What it defends against is a FUTURE derivation moving
     * off the row — which is exactly what went wrong before, when the count was summed over
     * the incident buckets and inherited their exclusions. That is worth having, and it is
     * not the same thing as a check, so it does not get to be described as one. */
    eventTimeCountsAddUp: readonly string[]
    /** `episodes.counted` against its two halves, so the identity that validated the
     * headline figure is printed rather than performed once in a message. */
    episodeCountsAddUp: readonly string[]
    /** `total` against typed + needing-classification, and typed against its own two
     * halves. Three figures that used to stand alone now have to agree with each other. */
    rowCountsAddUp: readonly string[]
  }>
}

/** Whether some parts add to a whole, naming the discrepancy when they do not.
 *
 * A LIST RATHER THAN A BOOLEAN, and it names the SIZE of the gap, because a person reads
 * this report to decide whether to trust a number. "false" tells them to distrust
 * everything; "317 with a time + 22 without = 339, but rows read is 364" tells them which
 * figure to go and look at. Empty means it adds up. */
export const adds = (
  parts: readonly (readonly [string, number])[],
  whole: number,
  wholeLabel: string,
): readonly string[] => {
  const sum = parts.reduce((total, [, value]) => total + value, 0)
  if (sum === whole) return []
  const shown = parts.map(([label, value]) => value + ' ' + label).join(' + ')
  return [shown + ' = ' + sum + ', but ' + wholeLabel + ' is ' + whole]
}

const declarationFor = (id: string): AlertTypeDeclaration | null =>
  ALERT_CATALOG.find((entry) => entry.id === id) ?? null

/** The subject a row offers for a given role, or why it cannot. */
function subjectFor(row: ExistingAlertRow, role: SubjectRole): ResolvedSubject {
  switch (role) {
    case 'ACTOR':
      return row.audit?.initiatedBy
        ? { resolved: true, id: row.audit.initiatedBy }
        : { resolved: false, why: row.audit === null ? 'no audit record joined' : 'initiatedBy absent' }
    case 'TARGET': {
      const first = row.audit?.targetResources[0]
      return first !== undefined
        ? { resolved: true, id: first }
        : { resolved: false, why: row.audit === null ? 'no audit record joined' : 'no target resources' }
    }
    case 'TENANT':
      return row.customerTenantId !== null
        ? { resolved: true, id: row.customerTenantId }
        : { resolved: false, why: 'notification has no customer tenant' }
    case 'COLLECTOR': {
      const resource = parseDedupeKey(row.dedupeKey).resourceType
      return resource !== null
        ? { resolved: true, id: resource }
        : { resolved: false, why: 'the key names no resource type' }
    }
  }
}

const groupingFor = (
  row: ExistingAlertRow,
  declaration: AlertTypeDeclaration,
  role: SubjectRole,
): Grouping =>
  incidentGrouping(
    role === declaration.subject ? declaration : { ...declaration, subject: role },
    { organizationId: row.organizationId, customerTenantId: row.customerTenantId ?? '' },
    subjectFor(row, role))

/** The dry run. Pure, and it checks its own output. */
export function reconcile(rows: readonly ExistingAlertRow[]): ReconciliationReport {
  const byShape: Record<KeyShape, number> = {
    DIRECTORY_AUDIT: 0, TENANT_SYNC: 0, TENANT_CONNECTION: 0, TENANT_INITIAL_SYNC: 0,
    TENANT_ONBOARDING: 0, RECOVERY: 0, UNRECOGNISED: 0,
  }
  const unrecognised = new Set<string>()
  const auditCategories: Record<string, number> = {}
  const declaredKeys = new Set<string>()
  const targetKeys = new Set<string>()
  // The bound: every row grouped under one nominated declaration, including the ones whose
  // real type is undetermined. Nominated rather than guessed — it is used only to count,
  // never to assign, and the mapping still records no type for those rows.
  const boundKeys = new Set<string>()
  const boundTargetKeys = new Set<string>()
  const auditBoundKeys = new Set<string>()
  const auditBoundTargetKeys = new Set<string>()
  // Rows per incident, so episodes can be counted within each stream rather than across
  // all of them — two actors' bursts on the same day are two incidents, not one episode.
  // Counted at the point of the decision rather than derived from the bucket map, so it
  // cannot silently agree with a bucketing bug: if these rows were dropped again this number
  // would still report them. See the coupling test.
  let standingAlone = 0
  const standingAloneByShape: Partial<Record<KeyShape, number>> = {}
  // COUNTED PER ROW, NOT SUMMED OVER THE BUCKET MAP. It was `rowsWithoutTime +=
  // bucket.missing` over `rowsByIncident`, and ungrouped rows were never in that map — so
  // the field inherited the bucketing exclusion and read 22 where the answer was 47, on an
  // input where 364 - 317 = 47 is checkable by hand. A COUNTER DERIVED FROM A STRUCTURE
  // INHERITS THAT STRUCTURE’S OMISSIONS. This one is taken where the fact is known.
  let rowsWithTime = 0
  let rowsWithoutTimeByRow = 0
  const rowsByIncident = new Map<string, {
    times: Date[]; missing: number; events: number; auditOnly: boolean
    /** Whether this bucket is a single standing-alone row rather than a resolved stream.
     * Carried so the episode total can be SPLIT and the split printed: the identity
     * `counted = attributed + standingAlone` was reconciled by hand once, in a message,
     * using a figure the report did not expose. A hand-check that cannot be reproduced
     * from the output is a claim about the past, not a property of the report. */
    standingAlone: boolean
  }>()
  const nominated = declarationFor('security.routine_directory_change')
  const mapping: MappingEntry[] = []
  let unattributed = 0
  let declaredResolved = 0
  let withDeterminedType = 0
  let needingClassification = 0
  let occurrences = 0

  for (const row of rows) {
    const parsed = parseDedupeKey(row.dedupeKey)
    byShape[parsed.shape] += 1
    occurrences += row.occurrenceCount
    if (row.occurredAt instanceof Date) rowsWithTime += 1
    else rowsWithoutTimeByRow += 1
    if (parsed.shape === 'UNRECOGNISED') unrecognised.add(row.dedupeKey)
    if (parsed.auditCategory !== null) {
      auditCategories[parsed.auditCategory] = (auditCategories[parsed.auditCategory] ?? 0) + 1
    }

    const alertTypeId = TYPE_FOR_SHAPE[parsed.shape]
    const declaration = alertTypeId === null ? null : declarationFor(alertTypeId)

    // Counted for the bound whatever happens below, so the bound covers every row rather
    // than only the ones that reached a verdict.
    const forBound = declaration ?? nominated
    if (forBound !== null) {
      const boundGrouping = groupingFor(row, forBound, forBound.subject)
      if (boundGrouping.groups) boundKeys.add(boundGrouping.key)
      const boundTarget = groupingFor(row, forBound, 'TARGET')
      if (boundTarget.groups) boundTargetKeys.add(boundTarget.key)
      if (parsed.shape === 'DIRECTORY_AUDIT') {
        if (boundGrouping.groups) auditBoundKeys.add(boundGrouping.key)
        if (boundTarget.groups) auditBoundTargetKeys.add(boundTarget.key)
      }
      // AN UNGROUPED ROW IS STILL AN INCIDENT, and it was contributing ZERO episodes.
      //
      // This was the cause of a six-episode disagreement with a SQL count over the same
      // rows. The guard was `if (boundGrouping.groups)`, so every unattributable row was
      // dropped from the episode accounting entirely — while the rival instrument coalesced
      // them onto one literal actor and got at least one episode from them. The other side
      // reasoned that their merging should make THEIR count lower and therefore could not
      // explain the gap; what they could not see is that mine was discarding the rows
      // outright, which is the stronger effect and points the other way.
      //
      // Each ungrouped row is its own incident of one event, so it keys on the notification
      // id. Two unattributed events are two incidents of one event each — exactly what
      // `wouldGroupTogether` already refuses to merge, now honoured in the episode count too.
      const episodeKey = boundGrouping.groups ? boundGrouping.key : `ungrouped:${row.id}`
      if (!boundGrouping.groups) {
        standingAlone += 1
        standingAloneByShape[parsed.shape] = (standingAloneByShape[parsed.shape] ?? 0) + 1
      }
      {
        const bucket = rowsByIncident.get(episodeKey)
          ?? { times: [], missing: 0, events: 0, auditOnly: true, standingAlone: !boundGrouping.groups }
        bucket.events += row.occurrenceCount
        if (row.occurredAt instanceof Date) bucket.times.push(row.occurredAt)
        else bucket.missing += 1
        if (parsed.shape !== 'DIRECTORY_AUDIT') bucket.auditOnly = false
        rowsByIncident.set(episodeKey, bucket)
      }
    }

    if (declaration === null) {
      needingClassification += 1
      mapping.push({
        notificationId: row.id,
        dedupeKey: row.dedupeKey,
        occurrenceCount: row.occurrenceCount,
        shape: parsed.shape,
        alertTypeId,
        incidentKey: null,
        because: parsed.shape === 'UNRECOGNISED'
          ? 'This key shape is not one the current system is known to produce, so it is reported rather ' +
            'than mapped. Unlisted is not harmless.'
          : 'The key shape does not determine the alert type on its own — the underlying change has to be ' +
            'classified first. Assigning a default here would file real privileged changes as routine.',
      })
      continue
    }

    withDeterminedType += 1
    const declaredGrouping = groupingFor(row, declaration, declaration.subject)
    if (declaredGrouping.groups) declaredKeys.add(declaredGrouping.key)
    else unattributed += 1
    if (declaredGrouping.groups) declaredResolved += 1

    // The comparison count only. Keyed on the target regardless of what the type declares,
    // so the two numbers come from the same rows and differ only in the subject.
    const targetGrouping = groupingFor(row, declaration, 'TARGET')
    if (targetGrouping.groups) targetKeys.add(targetGrouping.key)

    mapping.push({
      notificationId: row.id,
      dedupeKey: row.dedupeKey,
      occurrenceCount: row.occurrenceCount,
      shape: parsed.shape,
      alertTypeId: declaration.id,
      incidentKey: declaredGrouping.groups ? declaredGrouping.key : null,
      because: declaredGrouping.groups
        ? `Groups as ${declaration.id} on its declared ${declaration.subject.toLowerCase()}.`
        : declaredGrouping.because,
    })
  }

  // Episodes, at the interval the nominated type declares.
  const quietMs = nominated === null ? 24 * 60 * 60 * 1000 : quietIntervalMsOf(nominated)
  let episodesCounted = 0
  let episodesCountedAudit = 0
  let episodesAttributed = 0
  let episodesStandingAlone = 0
  let episodesAttributedAudit = 0
  let episodesStandingAloneAudit = 0
  let unrecoverable = 0
  let unrecoverableAttributed = 0
  let unrecoverableStandingAlone = 0
  for (const bucket of rowsByIncident.values()) {

    // ONE EVENT IS ONE EPISODE, AND THAT IS KNOWABLE WITHOUT ITS TIME. The time is only
    // needed to SPLIT several events; a single event forms exactly one burst whenever it
    // happened. Treating a timeless single-event incident as unknown was over-refusing —
    // the opposite error to counting a genuinely unknowable one as one, and both are failures
    // to distinguish "cannot be computed" from "computed".
    // HOW MANY EPISODES THIS BUCKET CONTRIBUTES IS DECIDED ONCE, and every total below
    // derives from that one number. It was decided in two places and each place repeated
    // the tagging, which is how a split ended up on the wrong axis: `counted` gained its
    // attributed/standing-alone halves and `countedDirectoryAuditOnly` — the figure a
    // person actually quotes — did not, because the audit-only line was written beside the
    // others rather than derived with them.
    let gained: number
    if (bucket.events === 1) {
      gained = 1
    } else if (bucket.missing > 0) {
      // UNKNOWN, NOT ONE. An incident holding a row whose event time is gone has an episode
      // count nobody can recover, and counting it as a single episode would understate the
      // migration by exactly the thing episodes were built to catch.
      unrecoverable += 1
      if (bucket.standingAlone) unrecoverableStandingAlone += 1
      else unrecoverableAttributed += 1
      continue
    } else {
      gained = episodesOf(
        bucket.times.map((at) => eventInstant({ occurredAt: at, receivedAt: at })), quietMs).length
    }

    episodesCounted += gained
    if (bucket.auditOnly) episodesCountedAudit += gained
    if (bucket.standingAlone) {
      episodesStandingAlone += gained
      if (bucket.auditOnly) episodesStandingAloneAudit += gained
    } else {
      episodesAttributed += gained
      if (bucket.auditOnly) episodesAttributedAudit += gained
    }
  }

  const mappingOccurrences = mapping.reduce((sum, entry) => sum + entry.occurrenceCount, 0)
  const inputOccurrences = rows.reduce((sum, row) => sum + row.occurrenceCount, 0)
  const mapped = new Set(mapping.map((entry) => entry.notificationId))
  const seen = new Set<string>()
  const duplicated = new Set<string>()
  for (const row of rows) {
    if (seen.has(row.id)) duplicated.add(row.id)
    seen.add(row.id)
  }
  return {
    total: rows.length,
    byShape,
    unrecognisedExamples: [...unrecognised].sort(),
    auditCategories,
    occurrencesRepresented: occurrences,
    incidents: {
      declared: declaredKeys.size,
      ifKeyedOnTarget: targetKeys.size,
      assumingSingleType: boundKeys.size,
      assumingSingleTypeKeyedOnTarget: boundTargetKeys.size,
      assumingSingleTypeDirectoryAuditOnly: auditBoundKeys.size,
      assumingSingleTypeDirectoryAuditOnlyKeyedOnTarget: auditBoundTargetKeys.size,
      declaredSubjectUnresolvedAmongTypedRows: unattributed,
      declaredSubjectResolvedAmongTypedRows: declaredResolved,
      withDeterminedType,
      needingClassification,
    },
    episodes: {
      counted: episodesCounted,
      fromAttributedRows: episodesAttributed,
      fromStandingAloneRows: episodesStandingAlone,
      fromAttributedRowsDirectoryAuditOnly: episodesAttributedAudit,
      fromStandingAloneRowsDirectoryAuditOnly: episodesStandingAloneAudit,
      standingAloneRowsWithUnrecoverableEpisodes: unrecoverableStandingAlone,
      attributedIncidentsWithUnrecoverableEpisodes: unrecoverableAttributed,
      countedDirectoryAuditOnly: episodesCountedAudit,
      incidentsWithUnrecoverableEpisodes: unrecoverable,
      rowsWithoutEventTime: rowsWithoutTimeByRow,
      rowsWithEventTime: rowsWithTime,
      rowsStandingAloneBecauseSubjectUnresolved: standingAlone,
      standingAloneByShape,
      quietIntervalHours: quietMs / (60 * 60 * 1000),
    },
    mapping,
    invariants: {
      rowsMissingFromMapping: rows.map((row) => row.id).filter((id) => !mapped.has(id)).sort(),
      duplicatedNotificationIds: [...duplicated].sort(),
      // ALL FOUR OF THESE ARE TRIPWIRES, NOT INPUT-FALSIFIABLE CHECKS, and that is worth
      // saying once here rather than discovering per field. Each identity has both sides
      // computed in ONE pass over the same rows, so no input can separate them: a mutation
      // making `adds` always report agreement survived every test. What they catch is a
      // FUTURE derivation drifting off the rows — which is exactly what happened to
      // rowsWithoutEventTime — and that is genuinely worth having. It is not the same thing
      // as verifying the computation, and only an INDEPENDENTLY DERIVED reference can do
      // that: for this report, the SQL count. Self-reconciliation catches drift; a second
      // instrument catches error.
      //
      // READS THE REPORTED FIGURE, which the boolean it replaces never did: that compared
      // two internal sums, so perturbing `occurrencesRepresented` left it saying "preserved".
      occurrenceCountsAddUp: [
        ...adds([['in the mapping', mappingOccurrences]], occurrences,
          'the reported occurrencesRepresented'),
        ...adds([['in the input', inputOccurrences]], occurrences,
          'the reported occurrencesRepresented'),
      ],
      eventTimeCountsAddUp: adds([
        ['with a time', rowsWithTime], ['without', rowsWithoutTimeByRow],
      ], rows.length, 'rows read'),
      episodeCountsAddUp: [
        ...adds([
          ['from attributed rows', episodesAttributed],
          ['from standing-alone rows', episodesStandingAlone],
        ], episodesCounted, 'episodes.counted'),
        // THE ONE THE HEADLINE NEEDS: directory-only, decomposed on the same axis.
        ...adds([
          ['from attributed directory rows', episodesAttributedAudit],
          ['from standing-alone directory rows', episodesStandingAloneAudit],
        ], episodesCountedAudit, 'episodes.countedDirectoryAuditOnly'),
        // Every standing-alone ROW accounted for as either an episode or an unplaceable one.
        ...adds([
          ['standing-alone rows counted as an episode', episodesStandingAlone],
          ['unplaceable', unrecoverableStandingAlone],
        ], standingAlone, 'rowsStandingAloneBecauseSubjectUnresolved'),
        ...adds([
          ['attributed', unrecoverableAttributed],
          ['standing-alone', unrecoverableStandingAlone],
        ], unrecoverable, 'incidentsWithUnrecoverableEpisodes'),
      ],
      rowCountsAddUp: [
        ...adds([
          ['with a determined type', withDeterminedType],
          ['needing classification', needingClassification],
        ], rows.length, 'rows read'),
        ...adds([
          ['declared subject resolved', declaredResolved],
          ['unresolved', unattributed],
        ], withDeterminedType, 'rows with a determined type'),
      ],
    },
  }
}
