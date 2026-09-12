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
  /** Why this fidelity — and for a LOSSY path, what the projection discards.
   * Required reading for anyone deciding whether to make it lossless. */
  readonly because: string
  /** TWO POLICIES DIFFERING ONLY AT THIS PATH, which turns the fidelity claim into
   * something checkable instead of a label somebody wrote.
   *
   * A LOSSLESS path must produce a state that DIFFERS across the pair — if it does
   * not, the projection lost something and excluding the path from the digest hides
   * it. A LOSSY path must produce a state that is IDENTICAL across the pair (proving
   * the loss is real) while the digest MOVES (proving the lost part is still visible
   * somewhere). Mislabelling an EXISTING path in either direction fails a test.
   *
   * WHAT THIS DOES NOT DO. An earlier version of this comment said a lossy-and-excluded
   * path "cannot be written again by accident". THAT WAS FALSE, and it is corrected here
   * rather than softened because a reader deciding whether excluding a path is safe will
   * rely on exactly these words.
   *
   * A witness is ONE PAIR, chosen by the same hand and on the same row as the label it
   * checks. LOSSLESS is a claim about EVERY pair. An existential cannot establish a
   * universal, so an author who picks the pair can satisfy both predictions while the
   * label is wrong. QA demonstrated it: add a path, project a structured subtree onto a
   * boolean, label it LOSSLESS, and choose absent-versus-present as the witness. The
   * boolean moves, so the pair passes and the path is excluded from the digest — and a
   * later change INSIDE that subtree then moves neither the state nor the digest and
   * reads routine, with a `because` true as written and false in effect. The suite
   * stayed green throughout. That is the grant-operator defect one dimension across,
   * reached with nothing red.
   *
   * So what a witness is actually worth: it forces an author to exhibit a concrete pair
   * instead of asserting a label, and it kills a careless relabel of a path that was
   * already correctly witnessed. Both are real. Neither is the universal, and no
   * stronger witness can be — the defect is in the quantifier, not the example. What
   * closes QA's escape is the constraint on `reads`, which an author cannot satisfy by
   * choosing a convenient example.
   *
   * Self-contained rather than a perturbation of whatever base a caller supplies: a
   * witness that only sets the "after" side depends on what the base happened to
   * contain, and for a lossy path that is the difference between demonstrating the
   * loss and accidentally demonstrating a change. */
  readonly witness: (base: Collected) => Readonly<{ before: Collected; after: Collected }>
}

type Collected = Readonly<Record<string, unknown>>

/** Replaces one path in a copy of the base. Only used to build witnesses. */
const withPath = (base: Collected, target: readonly string[], value: unknown): Collected => {
  if (target.length === 0) return base
  const [head, ...rest] = target
  if (head === undefined) return base
  const current = (base as Record<string, unknown>)[head]
  const nested = typeof current === 'object' && current !== null && !Array.isArray(current)
    ? current as Collected
    : {}
  return { ...base, [head]: rest.length === 0 ? value : withPath(nested, rest, value) }
}

const pairAt = (target: readonly string[], before: unknown, after: unknown) =>
  (base: Collected) => ({ before: withPath(base, target, before), after: withPath(base, target, after) })

export const MODELLED_PATHS: readonly ModelledPath[] = [
  {
    path: ['state'],
    fidelity: 'LOSSLESS',
    reads: 'state',
    because:
      'Microsoft sends enabled | enabledForReportingButNotEnforced | disabled, and the state carries all ' +
      'three as ON / REPORT_ONLY / OFF plus UNRECOGNISED for anything else. It was a boolean, which was ' +
      'not merely lossy: enabled-to-report-only read as "the policy was disabled" when it still evaluates ' +
      'and still logs, and report-only-to-disabled read as no change at all. The one residue is that two ' +
      'different unrecognised values both map to UNRECOGNISED, and since every transition touching ' +
      'UNRECOGNISED returns "impact unknown", no verdict can depend on telling them apart.',
    witness: pairAt(['state'], 'enabled', 'disabled'),
  },
  {
    path: ['grantControls', 'operator'],
    fidelity: 'LOSSLESS',
    reads: 'grantOperator',
    because: 'Microsoft sends OR or AND, and grantOperator carries both plus null for absent or unreadable.',
    witness: pairAt(['grantControls', 'operator'], 'AND', 'OR'),
  },
  {
    path: ['grantControls', 'builtInControls'],
    fidelity: 'LOSSLESS',
    reads: 'grantControls',
    because: 'The array is carried across as-is.',
    witness: pairAt(['grantControls', 'builtInControls'], ['mfa', 'compliantDevice'], ['mfa']),
  },
  {
    path: ['conditions', 'users', 'excludeUsers'],
    fidelity: 'LOSSLESS',
    reads: 'excludedUsers',
    because: 'Carried as its own array rather than merged, so the kind of principal survives.',
    witness: pairAt(['conditions', 'users', 'excludeUsers'], [], ['user-1']),
  },
  {
    path: ['conditions', 'users', 'excludeGroups'],
    fidelity: 'LOSSLESS',
    reads: 'excludedGroups',
    because:
      'Its own array. Merging it with excluded users lost the blast radius rather than a label: one group ' +
      'exclusion can remove a policy from everybody in it, and the count is not visible from the policy.',
    witness: pairAt(['conditions', 'users', 'excludeGroups'], [], ['group-1']),
  },
  {
    path: ['conditions', 'users', 'excludeRoles'],
    fidelity: 'LOSSLESS',
    reads: 'excludedRoles',
    because:
      'Its own array. A role exclusion covers whoever currently holds the role, so the set it applies to ' +
      'changes with no policy edit at all — which HawkView cannot see, and which is recorded as a product ' +
      'blind spot rather than something this mapping can fix.',
    witness: pairAt(['conditions', 'users', 'excludeRoles'], [], ['role-1']),
  },
  {
    path: ['sessionControls'],
    fidelity: 'LOSSY',
    reads: 'sessionControls',
    because:
      'Only the NAMES of configured session controls are modelled, deliberately — direction depends on ' +
      'values the state does not capture, since persistentBrowser set to always weakens a policy and set ' +
      'to never strengthens it, and inferring a direction from presence would be the OR/AND error one ' +
      'dimension across. So the values stay in the digest. Excluding this subtree would make an ' +
      'always-to-never change invisible to the presence check, whose key set is unchanged, AND to the ' +
      'fingerprint, which excluded it as modelled — the silent gap this distinction exists to prevent.',
    witness: pairAt(
      ['sessionControls'],
      { persistentBrowser: { isEnabled: true, mode: 'always' } },
      { persistentBrowser: { isEnabled: true, mode: 'never' } }),
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

/** UNRECOGNISED rather than OFF for a state Microsoft has not sent before.
 *
 * Mapping an unknown state to OFF would assert "not enforcing" about something we do
 * not understand — and because this path is LOSSLESS and therefore excluded from the
 * digest, that guess would be the only thing said about it, with the safety net
 * switched off for exactly that case. The fourth member is what keeps the exclusion
 * honest. */
const policyState = (raw: unknown): ConditionalAccessState['state'] =>
  raw === 'enabled' ? 'ON'
    : raw === 'enabledForReportingButNotEnforced' ? 'REPORT_ONLY'
      : raw === 'disabled' ? 'OFF'
        : 'UNRECOGNISED'

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
    state: policyState(at(collected, ['state'])),
    grantOperator: normalisedOperator === 'OR' || normalisedOperator === 'AND' ? normalisedOperator : null,
    grantControls: strings(at(collected, ['grantControls', 'builtInControls'])),
    excludedUsers: strings(at(collected, ['conditions', 'users', 'excludeUsers'])),
    excludedGroups: strings(at(collected, ['conditions', 'users', 'excludeGroups'])),
    excludedRoles: strings(at(collected, ['conditions', 'users', 'excludeRoles'])),
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
