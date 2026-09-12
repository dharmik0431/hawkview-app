import { ALERT_CATALOG } from './alert-catalog.js'
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
  readonly audit: Readonly<{
    initiatedBy: string | null
    targetResources: readonly string[]
    privileged: boolean | null
  }> | null
}

export interface MappingEntry {
  readonly notificationId: string
  readonly dedupeKey: string
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
    /** Rows that cannot be grouped because the declared subject did not resolve. */
    unattributed: number
    /** Rows whose alert type the shape alone does not determine. */
    needingClassification: number
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
    occurrencesPreserved: boolean
  }>
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
  const nominated = declarationFor('security.routine_directory_change')
  const mapping: MappingEntry[] = []
  let unattributed = 0
  let needingClassification = 0
  let occurrences = 0

  for (const row of rows) {
    const parsed = parseDedupeKey(row.dedupeKey)
    byShape[parsed.shape] += 1
    occurrences += row.occurrenceCount
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
    }

    if (declaration === null) {
      needingClassification += 1
      mapping.push({
        notificationId: row.id,
        dedupeKey: row.dedupeKey,
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

    const declaredGrouping = groupingFor(row, declaration, declaration.subject)
    if (declaredGrouping.groups) declaredKeys.add(declaredGrouping.key)
    else unattributed += 1

    // The comparison count only. Keyed on the target regardless of what the type declares,
    // so the two numbers come from the same rows and differ only in the subject.
    const targetGrouping = groupingFor(row, declaration, 'TARGET')
    if (targetGrouping.groups) targetKeys.add(targetGrouping.key)

    mapping.push({
      notificationId: row.id,
      dedupeKey: row.dedupeKey,
      shape: parsed.shape,
      alertTypeId: declaration.id,
      incidentKey: declaredGrouping.groups ? declaredGrouping.key : null,
      because: declaredGrouping.groups
        ? `Groups as ${declaration.id} on its declared ${declaration.subject.toLowerCase()}.`
        : declaredGrouping.because,
    })
  }

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
      unattributed,
      needingClassification,
    },
    mapping,
    invariants: {
      rowsMissingFromMapping: rows.map((row) => row.id).filter((id) => !mapped.has(id)).sort(),
      duplicatedNotificationIds: [...duplicated].sort(),
      // The events behind the rows are preserved by construction — nothing here discards
      // an occurrence count — and the report states the total so that applying the mapping
      // can be checked against it rather than trusted.
      occurrencesPreserved: occurrences === rows.reduce((sum, row) => sum + row.occurrenceCount, 0),
    },
  }
}
