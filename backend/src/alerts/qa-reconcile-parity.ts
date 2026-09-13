// QA — is the mapping move behaviour-preserving, in RESULTS rather than in compilation?
//
// 6017f23 moved `TYPE_FOR_SHAPE` from a literal table in reconciliation.ts to a table derived from
// `covers:` on the catalogue. Reconciliation is the step-03 work whose production figures were
// approved — 366 total, 319 awaiting the classifier, 3 permanently unwritable, 44 writable. If the
// move changed any classification that approval is void, and nobody would see it: the apply
// refuses on drift, and a refusal reads as the data having moved rather than as the code having.
//
// THIS FILE IS IDENTICAL AT BOTH COMMITS, byte for byte, and is run at each. The outputs are
// compared outside. It uses only exports that exist on both sides, so neither run is compiling
// something the other could not.
//
// WHY A GENERATED CORPUS. A hand-picked set of rows tests the rows I thought of. This takes the
// cartesian product of every dimension reconciliation branches on, and then ASSERTS COVERAGE —
// every one of the seven shapes must appear, or the parity result is reported as unsound rather
// than as a pass. A parity check over a corpus missing a shape is a green on an empty input.
import {
  reconcile, parseDedupeKey, exclusionKindFor, permanentlyUnresolvable, resourceTypeFor,
  TYPE_FOR_SHAPE, type ExistingAlertRow,
} from './reconciliation.js'

const T0 = new Date('2026-01-05T09:00:00Z')
const T1 = new Date('2026-02-11T17:30:00Z')

// ── THE KEYS, one per shape, built from the patterns the parser matches ─────────────────────
const TENANTS = ['ten-a', 'ten-b']
const RESOURCES = ['SIGN_INS', 'AUDIT_LOGS', 'MAILBOX_SETTINGS']
// Three with a category prefix and one without, because the category is extracted separately.
const AUDIT_IDS = ['UserManagement_evt1', 'RoleManagement_evt2', 'ApplicationManagement_evt3', 'evt4-no-category']

const baseKeys: string[] = []
for (const t of TENANTS) {
  for (const r of RESOURCES) baseKeys.push('tenant:' + t + ':sync:' + r)
  baseKeys.push('tenant:' + t + ':connection')
  baseKeys.push('tenant:' + t + ':initial-sync')
  baseKeys.push('tenant:' + t + ':onboarding-authorized')
}
for (const a of AUDIT_IDS) baseKeys.push('security:directory-audit:' + a)
baseKeys.push('something:nobody:declared')          // UNRECOGNISED
baseKeys.push('')                                    // the degenerate key

// RECOVERIES OF EVERY BASE KEY, plus a recovery of a recovery. The recovery shape is the one
// whose type the move touches most directly, and the walk that finds its subject is bounded.
const keys: string[] = [...baseKeys]
for (const k of baseKeys) keys.push(k + ':recovered:3')
keys.push('tenant:ten-a:sync:SIGN_INS:recovered:3:recovered:8')

// ── THE ROWS: the product of the other dimensions ───────────────────────────────────────────
const COUNTS = [1, 7, 42]
const RESOLVED = [null, T1]
const AUDITS: ExistingAlertRow['audit'][] = [
  null,
  { initiatedBy: 'admin@customer.example', targetResources: ['user-1'], privileged: true },
  { initiatedBy: 'admin@customer.example', targetResources: ['user-1', 'user-2'], privileged: false },
  { initiatedBy: null, targetResources: [], privileged: null },
]

const rows: ExistingAlertRow[] = []
let n = 0
for (const dedupeKey of keys) {
  for (const occurrenceCount of COUNTS) {
    for (const resolvedAt of RESOLVED) {
      for (const audit of AUDITS) {
        n += 1
        // `occurredAt` cycles through absent / null / a date, because its ABSENCE is reported
        // rather than defaulted and the three are genuinely different inputs.
        const which = n % 3
        const base = {
          id: 'row-' + n,
          organizationId: n % 2 === 0 ? 'org-1' : 'org-2',
          customerTenantId: n % 5 === 0 ? null : 'ten-' + (n % 3),
          dedupeKey, occurrenceCount, resolvedAt, audit,
        }
        rows.push(which === 0 ? base : { ...base, occurredAt: which === 1 ? null : T0 })
      }
    }
  }
}

const report = reconcile(rows)

// ── PER-ROW, THE THREE ANSWERS THAT DECIDE A ROW'S FATE ─────────────────────────────────────
// The report carries `mapping`, but these are the functions the apply and the script call
// directly, so they are compared directly too rather than only through the aggregate.
const perKey = keys.map((k) => {
  const parsed = parseDedupeKey(k)
  const typeId = TYPE_FOR_SHAPE[parsed.shape]
  return {
    key: k,
    shape: parsed.shape,
    typeForShape: typeId,
    exclusionWithType: exclusionKindFor(typeId, k),
    exclusionWithNoType: exclusionKindFor(null, k),
    resourceType: resourceTypeFor(k),
    unresolvableAsTenant: permanentlyUnresolvable(k, 'TENANT'),
    unresolvableAsActor: permanentlyUnresolvable(k, 'ACTOR'),
    unresolvableAsTarget: permanentlyUnresolvable(k, 'TARGET'),
  }
})

// ── COVERAGE, ASSERTED RATHER THAN HOPED ────────────────────────────────────────────────────
const SHAPES = ['DIRECTORY_AUDIT', 'TENANT_SYNC', 'TENANT_CONNECTION', 'TENANT_INITIAL_SYNC',
  'TENANT_ONBOARDING', 'RECOVERY', 'UNRECOGNISED'] as const
const byShape = report.byShape as Readonly<Record<string, number>>
const missing = SHAPES.filter((s) => (byShape[s] ?? 0) === 0)

console.log(JSON.stringify({
  QA_RECONCILE_PARITY: {
    corpus: { keys: keys.length, rows: rows.length },
    coverage: {
      byShape,
      EVERY_SHAPE_EXERCISED: missing.length === 0,
      missing,
    },
    // The changed object itself, printed in full so the two sides can be diffed directly.
    TYPE_FOR_SHAPE,
    perKey,
    report,
  },
}, null, 2))
