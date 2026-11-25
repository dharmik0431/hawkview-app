/**
 * Declared consumer contract for the two staged-source entry points that the
 * HAW-70 scripts actually import. It is a REVIEWED CONTRACT, not proof that the
 * JavaScript implements it: the shapes below were read off the real return
 * constructors -- `buildReceipt`, `materializeAcquired`'s result and
 * `validateAcquired`'s result -- in `haw70-upgrade-materializer.mjs`, and the
 * runtime shape checks there remain the authority.
 *
 * Only the consumed surface is declared. The module's wider exports stay
 * deliberately outside this typed surface rather than being approximated here.
 *
 * Nothing in these types establishes hosting, source freshness, database state
 * or permission to execute anything. `executionAllowed` is the literal `false`
 * because the implementation always returns exactly that; it is a description
 * of the data, not an authorization mechanism.
 */

/** The two stages the receipt always carries. No other key is produced. */
export type Haw70StageName = 'baseline' | 'candidate'

export interface Haw70ReceiptStageFile {
  readonly path: string
  readonly bytes: number
  readonly sha256: string
}

export interface Haw70ReceiptStage {
  readonly schema: string
  readonly migrationLock: string
  readonly migrationCount: number
  readonly fileCount: number
  readonly bytes: number
  readonly files: readonly Haw70ReceiptStageFile[]
}

export interface Haw70StageReceipt {
  readonly kind: 'haw70-migration-stage-receipt-v1'
  readonly executionAllowed: false
  readonly candidateCommit: string
  readonly candidateTree: string
  readonly baselineCommit: string
  readonly reviewedCandidateCommit: string
  readonly baselineDigest: string
  readonly candidateDigest: string
  /** Exactly the two stages, not an open index. */
  readonly stages: { readonly [Stage in Haw70StageName]: Haw70ReceiptStage }
}

export interface Haw70MaterializeInput {
  readonly repositoryRoot: string
  readonly expectedCandidateCommit: string
  readonly scratchParent: string
}

export interface Haw70MaterializeResult {
  readonly kind: 'haw70-migration-stage-result-v1'
  readonly executionAllowed: false
  readonly outputRoot: string
  readonly receiptPath: string
  readonly receipt: Haw70StageReceipt
}

export interface Haw70ValidateStagedInput {
  readonly repositoryRoot: string
  readonly expectedCandidateCommit: string
  readonly outputRoot: string
}

/** The validation result carries no `receiptPath`; the implementation returns none. */
export interface Haw70ValidateStagedResult {
  readonly kind: 'haw70-migration-stage-validation-v1'
  readonly executionAllowed: false
  readonly outputRoot: string
  readonly receipt: Haw70StageReceipt
}

/**
 * Synchronous. Throws on any refusal rather than returning a null or an error
 * value, so the declared result describes the successful case only.
 */
export function materializeHaw70UpgradeSource(
  input: Haw70MaterializeInput): Haw70MaterializeResult

/** Synchronous, and likewise throws on refusal. */
export function validateHaw70UpgradeStagedSource(
  input: Haw70ValidateStagedInput): Haw70ValidateStagedResult
