import type { ConditionalAccessState } from './privileged-change.js'

/** Mapping a COLLECTED conditional access policy into the state the classifier
 * compares, and digesting everything the mapping did not look at.
 *
 * ONE DECLARATION OF WHAT IS MODELLED, TWO CONSUMERS. The mapper reads the state from
 * the declared paths; the fingerprint digests what is left. A second list of paths
 * beside the first is the coupling that produced three defects here in a week, and
 * splitting these two across a module boundary would separate the list from one of
 * its consumers — which is the same defect with more distance in it.
 *
 * THIS LIVES IN THE ALERTS FOLDER RATHER THAN THE COLLECTION LAYER, and the deciding
 * argument is what happens when Microsoft adds a policy dimension. A mapper in the
 * collection layer would absorb the new shape and hand alerts a stable type — which
 * sounds clean and would silently defeat `unmodelledFingerprint`, the thing that
 * exists so a new Graph dimension cannot pass unnoticed. A collector that quietly
 * normalises Graph changes away is the safety net removing its own reason to exist.
 * The cost is that a Graph shape change now touches this folder, which is correct:
 * whether we model a new policy dimension is an alerts decision and should cost
 * somebody a deliberate edit.
 */

/** Every field the collector actually stores for a policy.
 *
 * Taken from `CONDITIONAL_ACCESS` in `tenant-sync.service.ts`, which is the other side
 * of the boundary — a list written here from memory would agree with my reading of the
 * collector and with nothing else. If the collector starts storing a new field, the
 * digest picks it up automatically; this constant exists so a READER can see what the
 * digest is drawn from, and so the test below can assert the modelled paths are a
 * subset of what is actually collected rather than of what I imagined. */
export const COLLECTED_POLICY_FIELDS = [
  'id', 'displayName', 'state', 'createdDateTime', 'modifiedDateTime',
  'conditions', 'grantControls', 'sessionControls',
] as const

/** How completely a modelled path is captured by the state it feeds.
 *
 * THE DISTINCTION IS LOAD-BEARING AND IT IS WHERE A SILENT GAP WOULD LIVE. A path may
 * only be excluded from the digest if the state captures it LOSSLESSLY — otherwise the
 * part the projection threw away is invisible to both layers at once: the classifier
 * cannot see it because it was never mapped, and the fingerprint cannot see it because
 * it was excluded as "modelled". That is the exact shape of the operator defect, one
 * level down.
 *
 * So a lossy projection keeps its path IN the digest. The cost is noise — a change
 * there can report as unclassified when a modelled verdict already covers it — and
 * noise is the safe direction. The fix is to make the projection lossless rather than
 * to exclude a path we only partly understand; see the test that names each one. */
export type Fidelity =
  /** The state captures this path completely. Safe to exclude from the digest. */
  | 'LOSSLESS'
  /** The state captures only part of it. MUST stay in the digest. */
  | 'LOSSY'

export interface ModelledPath {
  readonly path: readonly string[]
  readonly fidelity: Fidelity
  /** Which field of `ConditionalAccessState` reads it. */
  readonly reads: keyof ConditionalAccessState
  /** For a LOSSY path, what the projection discards. Required reading for anyone
   * deciding whether to make it lossless. */
  readonly because: string
}

export const MODELLED_PATHS: readonly ModelledPath[] = [
  {
    path: ['state'],
    fidelity: 'LOSSY',
    reads: 'enabled',
    because:
      'Microsoft\'s state is three-valued — enabled, enabledForReportingButNotEnforced, disabled — ' +
      'and `enabled` is a boolean, so report-only and disabled both map to false. A policy moving ' +
      'between those two is invisible to the comparison. Neither is enforcing, so it is not a ' +
      'weakening, but the projection is lossy and the path therefore stays in the digest. Making it ' +
      'lossless is cheap: effective-mfa-enforcement.ts already maps this field to ON / REPORT_ONLY / ' +
      'OFF, so the vocabulary exists in the product.',
  },
  {
    path: ['grantControls', 'operator'],
    fidelity: 'LOSSLESS',
    reads: 'grantOperator',
    because: 'Microsoft\'s operator is OR or AND, and `grantOperator` carries both plus null for absent.',
  },
  {
    path: ['grantControls', 'builtInControls'],
    fidelity: 'LOSSLESS',
    reads: 'grantControls',
    because: 'The array is carried across as-is.',
  },
  {
    path: ['conditions', 'users', 'excludeUsers'],
    fidelity: 'LOSSY',
    reads: 'excludedPrincipals',
    because:
      'Three exclude lists — users, groups and roles — are merged into one array, so which KIND of ' +
      'principal was excluded is discarded. An identifier moving between the lists reads as no change. ' +
      'Unlikely to matter and still a loss, so the paths stay in the digest.',
  },
  {
    path: ['conditions', 'users', 'excludeGroups'],
    fidelity: 'LOSSY',
    reads: 'excludedPrincipals',
    because:
      'Flattened into the same array as excluded users and roles, so "this GROUP no longer has the ' +
      'policy applied to it" becomes indistinguishable from a user exclusion. Group exclusions are the ' +
      'broader of the two — one edit can remove a policy from everybody in it — so losing the kind ' +
      'loses the blast radius, not just a label.',
  },
  {
    path: ['conditions', 'users', 'excludeRoles'],
    fidelity: 'LOSSY',
    reads: 'excludedPrincipals',
    because:
      'Flattened into the same array as excluded users and groups. A ROLE exclusion removes the policy ' +
      'from whoever currently holds that role, so the set it covers changes without the policy being ' +
      'edited at all — which is a materially different fact from excluding one named account, and the ' +
      'merged array cannot express it.',
  },
  {
    path: ['sessionControls'],
    fidelity: 'LOSSY',
    reads: 'sessionControls',
    because:
      'Only the NAMES of present session controls are modelled, deliberately — their direction ' +
      'depends on values the state does not capture, since persistentBrowser `always` weakens a policy ' +
      'and `never` strengthens it. So the values are unmodelled and must stay in the digest. Excluding ' +
      'this subtree would make an always-to-never change invisible to the presence check (the key set ' +
      'is unchanged) AND to the fingerprint (excluded as modelled), which is the silent gap this ' +
      'distinction exists to prevent.',
  },
]

/** Canonicalises a value before it is digested — injected rather than imported.
 *
 * The collection layer already canonicalises conditional access policies, including
 * order-insensitivity for the arrays Microsoft returns in arbitrary order. That
 * function is module-private there and that file is being edited, so this states what
 * it needs and lets the wiring supply it. Same shape as `quietMs` and the seen-set:
 * the layer declares its dependency instead of reaching across a boundary.
 *
 * INJECTION MOVES A RISK RATHER THAN REMOVING IT. A compile-time import is at least
 * the right function; an injected one can be wired to an identity function or to the
 * wrong canonicaliser, and the fingerprint then degrades SILENTLY toward everything
 * reading routine — the unsafe direction. The obligation that comes with it is in the
 * step-05 handoff: the producer audit must run against the production-wired function,
 * not only against what a test supplies, or the audit shares an origin with what it
 * checks. */
export type Canonicaliser = (value: unknown) => unknown

type Collected = Readonly<Record<string, unknown>>

const isRecord = (value: unknown): value is Collected =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const at = (policy: Collected, path: readonly string[]): unknown => {
  let cursor: unknown = policy
  for (const segment of path) {
    if (!isRecord(cursor)) return undefined
    cursor = cursor[segment]
  }
  return cursor
}

const strings = (value: unknown): readonly string[] =>
  Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : []

/** The state the classifier compares, read only from the declared paths.
 *
 * Every field comes from a `MODELLED_PATHS` entry, which is what keeps the declaration
 * honest: a field read from somewhere undeclared would be excluded from the digest by
 * nothing and modelled by nobody. A test asserts every entry's `reads` covers the
 * state's fields. */
export function mapCollectedPolicy(
  collected: Collected,
  canonicalise: Canonicaliser,
): ConditionalAccessState {
  const operator = at(collected, ['grantControls', 'operator'])
  const normalisedOperator = typeof operator === 'string' ? operator.toUpperCase() : null
  const sessionControls = at(collected, ['sessionControls'])

  return {
    enabled: at(collected, ['state']) === 'enabled',
    grantOperator: normalisedOperator === 'OR' || normalisedOperator === 'AND' ? normalisedOperator : null,
    grantControls: strings(at(collected, ['grantControls', 'builtInControls'])),
    excludedPrincipals: [
      ...strings(at(collected, ['conditions', 'users', 'excludeUsers'])),
      ...strings(at(collected, ['conditions', 'users', 'excludeGroups'])),
      ...strings(at(collected, ['conditions', 'users', 'excludeRoles'])),
    ],
    // NAMES ONLY, which is why this path is LOSSY and stays in the digest. A control
    // present with a different value is a change the state cannot express.
    sessionControls: isRecord(sessionControls)
      ? Object.keys(sessionControls).filter((name) => sessionControls[name] !== null).sort()
      : [],
    unmodelledFingerprint: unmodelledFingerprintOf(collected, canonicalise),
  }
}

/** A digest of everything the mapping did not capture.
 *
 * Excludes only the LOSSLESS paths. A lossy one stays, because the part its projection
 * discarded is otherwise invisible to both layers — and "we did not look at that" must
 * never resolve to "it was fine", which is the whole reason this field exists.
 *
 * Drawn from the policy as collected rather than from an enumeration of Graph fields,
 * so a dimension Microsoft adds tomorrow moves the digest without anybody updating a
 * list. That is the property the whole mechanism rests on. */
export function unmodelledFingerprintOf(
  collected: Collected,
  canonicalise: Canonicaliser,
): string {
  const residue = structuredCloneOf(collected)
  for (const modelled of MODELLED_PATHS) {
    if (modelled.fidelity === 'LOSSLESS') deleteAt(residue, modelled.path)
  }
  return JSON.stringify(canonicalise(sortKeysDeep(residue)) ?? null)
}

function structuredCloneOf(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(structuredCloneOf)
  if (isRecord(value)) {
    const copy: Record<string, unknown> = {}
    for (const [key, entry] of Object.entries(value)) copy[key] = structuredCloneOf(entry)
    return copy
  }
  return value
}

function deleteAt(value: unknown, path: readonly string[]): void {
  if (path.length === 0 || !isRecord(value)) return
  const [head, ...rest] = path
  if (head === undefined) return
  if (rest.length === 0) {
    delete (value as Record<string, unknown>)[head]
    return
  }
  deleteAt(value[head], rest)
}

/** Key order is not information. Without this the digest would move when Microsoft
 * happens to serialise the same policy differently, which reads as a change nobody
 * made — and a fingerprint that cries wolf gets widened until it stops firing. */
function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep)
  if (!isRecord(value)) return value
  const sorted: Record<string, unknown> = {}
  for (const key of Object.keys(value).sort()) sorted[key] = sortKeysDeep(value[key])
  return sorted
}
