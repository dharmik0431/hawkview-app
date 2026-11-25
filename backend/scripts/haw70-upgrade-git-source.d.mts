/**
 * Declared consumer contract for the one Git-source export the HAW-70 scripts
 * import. Read off the real return constructor in
 * `haw70-upgrade-git-source.mjs` (`inspectSelectedNamespaceAgainstBaseline`)
 * and the existing `LEGACY_ACQUISITION_CAPS` literal.
 *
 * A REVIEWED CONTRACT, not proof of the implementation. It adds no caller
 * manifest, observer, snapshot, raw-buffer or authority override to the typed
 * surface, and the launch builder keeps supplying only its own committed
 * anchor constant.
 */

/**
 * The existing optional second parameter. It is the resource profile only and
 * grants no new production input; the public launch path never passes it.
 */
export interface Haw70AcquisitionCaps {
  readonly file: number
  readonly snapshot: number
  readonly combined: number
  readonly checkout: number
  readonly boundedEnumeration: boolean
}

export interface Haw70AnchorInspectionInput {
  readonly repositoryRoot: string
  readonly expectedCandidateCommit: string
  readonly anchorCommit: string
}

export interface Haw70AnchorInspection {
  readonly kind: 'haw70-main-anchor-selection-only-v1'
  readonly executionAllowed: false
  readonly anchorCommit: string
  readonly anchorTree: string
  readonly candidateCommit: string
  /** Always present on a successful return; never optional. */
  readonly candidateTree: string
  /**
   * The literal `true`. The implementation throws instead of reporting a
   * non-ancestor, so a successful return can only carry this value. It is a
   * description of that control flow, not an authorization.
   */
  readonly rawAncestorOfCandidate: true
  readonly selectedFiles: number
  /**
   * A BOOLEAN, deliberately. A drifted ancestor returns successfully with
   * `false` and a populated `differing` list, so narrowing this to a literal
   * would misdescribe the implementation and hide the drift case.
   */
  readonly matchesHistoricalBaseline: boolean
  readonly differing: readonly string[]
}

/** Synchronous. Throws on any refusal, including a non-ancestor anchor. */
export function inspectSelectedNamespaceAgainstBaseline(
  input: Haw70AnchorInspectionInput,
  caps?: Haw70AcquisitionCaps): Haw70AnchorInspection
