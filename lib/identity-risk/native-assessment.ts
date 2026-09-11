/**
 * The rebuilt engine's own response, read in its own vocabulary.
 *
 * A second adapter rather than a translation into the old envelope. Filling
 * `capability`, `reasonCode`, `freshness` and `selectedSource` from this shape
 * would mean mapping a richer vocabulary into a coarser one and inventing the
 * boundaries -- which withheld reasons are PARTIAL, which are UNAVAILABLE --
 * for a word a technician reads before they read the reasons. That lossy step
 * is what the separate endpoint exists to remove, so nothing here performs it.
 *
 * TOLERANCE POSTURE, which is not uniform and should not be.
 *
 * A field that is ABSENT is tolerated and rendered as unreported. The backend
 * auto-deploys and the frontend publishes separately, so the backend in front
 * of this code is routinely newer than it; rejecting a payload for a key this
 * build has not heard of would break the surface on an ordinary rollout.
 *
 * A field that is PRESENT and SELF-CONTRADICTING is rejected. A null count on
 * an EXACT accuracy, a finding with no signals, two entries for one signal:
 * these do not degrade gracefully, they render something false. Missing is a
 * state; contradictory is a defect.
 */
import type { FindingSignal, SignalInstant } from './types'

export const NATIVE_RISKY_USERS_VERSION = 'hawkview-risky-users/v1'

/** One collector's own account of itself, with no verdict attached. */
export type NativeCollector = {
  source: string
  /** The collector's raw state. Never rendered as a freshness verdict. */
  status: string
  /**
   * Null means NEVER succeeded, not "succeeded long ago".
   *
   * The distinction one tenant on the fleet turns on: "we have not collected
   * since August" and "we have never successfully collected" are different
   * sentences, and only one of them is fixed by waiting. Null must never reach
   * a date formatter, where it would render as an epoch or a dash and read as
   * a very old success.
   */
  lastSuccessfulCollectionAt: string | null
}

export type NativeSubject = {
  kind: 'DIRECTORY_USER' | 'MAILBOX'
  /** The opaque handle, always present. */
  ref: string
  /**
   * Present only for callers past the role gate. Absent is a technician seeing
   * less, never an error, and never a reason to hide the finding.
   */
  displayName: string | null
  userPrincipalName: string | null
}

export type NativeFinding = {
  detectorId: string
  subject: NativeSubject
  signals: FindingSignal[]
}

export type NativeCount = {
  accuracy: 'EXACT' | 'AT_LEAST' | 'NOT_AVAILABLE'
  value: number | null
  /** Detector ids that ran, and the ones that did not with their own reason. */
  covered: string[]
  notCovered: { detectorId: string; because: string }[]
  evidenceRequested: string[]
}

/**
 * One stream's classifier split, with the two kinds of set-aside event kept
 * apart.
 *
 * They must never be summed. Uninterpreted events are ones we could not read
 * at all: wrong by an unbounded amount in an uncharacterised direction.
 * Not-yet-cited events are ones we read and identified and are holding because
 * our own basis for excluding them is not written down: bounded, named and
 * enumerable. A tenant with an interpretation failure and a tenant with a
 * paperwork gap would become indistinguishable, which is the collapse this
 * module exists to prevent.
 */
export type NativeStreamCoverage = {
  stream: string
  applies: number
  uninterpretedEvents: number
  notYetCitedEvents: number
}

export type NativeAssessment =
  | { available: false; because: string }
  | {
      available: true
      run: {
        windowStart: string | null
        windowEnd: string | null
        completedAt: string | null
      }
      collectors: NativeCollector[]
      coverage: NativeStreamCoverage[]
      /**
       * Whether this response names anyone.
       *
       * False is an answer rather than a failure: identity resolution is gated
       * on the caller's role. Said once, at the top, rather than as a gap on
       * every row -- a gap per row invites the reading that the person is
       * missing rather than the name.
       */
      subjectsNamed: boolean
      count: NativeCount
      /** Empty when the claim was permitted. */
      withheld: { stream: string | null; because: string }[]
      findings: NativeFinding[]
      /** False means the list is truncated, which is not an empty list. */
      complete: boolean
    }

const MAX_ITEMS = 500
const MAX_SIGNALS = 32
const MAX_STRING = 400
const MAX_COUNT = 1_000_000

function record(value: unknown): Record<string, unknown> | null {
  return value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
    ? (value as Record<string, unknown>)
    : null
}

function has(value: Record<string, unknown>, keys: readonly string[]) {
  return keys.every((key) => Object.prototype.hasOwnProperty.call(value, key))
}

function text(value: unknown, max = MAX_STRING): string | null {
  return typeof value === 'string' && value.length > 0 && value.length <= max
    ? value
    : null
}

/** Optional strings: absent and null both mean the server did not say. */
function optionalText(value: unknown, max = MAX_STRING): string | null {
  return value === undefined || value === null ? null : text(value, max)
}

function isoOrNull(value: unknown): string | null {
  const raw = text(value, 40)
  return raw && Number.isFinite(Date.parse(raw)) ? raw : null
}

function list(value: unknown): unknown[] | null {
  return Array.isArray(value) && value.length <= MAX_ITEMS ? value : null
}

/**
 * A finding's signals, or null when the array contradicts itself.
 *
 * Empty is refused rather than tolerated. Under the contract a signal missing
 * from the array was never evaluated, so an empty array says every signal was
 * never evaluated -- a finding resting on nothing. Accepting it as a sentinel
 * for an older server would drop every finding in the tenant for the length of
 * a deploy, which fails silently and reads exactly like a clean tenant.
 */
function adaptSignals(value: unknown): FindingSignal[] | null {
  if (!Array.isArray(value)) return null
  if (value.length === 0 || value.length > MAX_SIGNALS) return null

  const signals: FindingSignal[] = []
  for (const entry of value) {
    const source = record(entry)
    if (!source || !has(source, ['signal', 'count', 'capped'])) return null
    const signal = text(source.signal, 120)
    const count = source.count
    const capped = source.capped
    if (
      !signal ||
      !Number.isSafeInteger(count) ||
      (count as number) < 0 ||
      (count as number) > MAX_COUNT ||
      typeof capped !== 'boolean'
    ) {
      return null
    }

    let latest: SignalInstant | null = null
    if (source.latest !== null && source.latest !== undefined) {
      const instant = record(source.latest)
      if (!instant) return null
      const at = isoOrNull(instant.at)
      const kind = instant.kind
      if (!at || (kind !== 'EVENT_OCCURRED' && kind !== 'STATE_OBSERVED')) {
        return null
      }
      latest = { at, kind }
    }
    // Nothing occurred for a zero's timestamp to mark.
    if (count === 0 && latest !== null) return null

    signals.push({ signal, count: count as number, latest, capped })
  }

  // Two entries for one signal make every per-signal count ambiguous, and the
  // surface would render one of them as though it were the whole.
  if (new Set(signals.map((item) => item.signal)).size !== signals.length) {
    return null
  }
  return signals
}

function adaptSubject(value: unknown): NativeSubject | null {
  const source = record(value)
  if (!source) return null
  const kind =
    source.kind === 'DIRECTORY_USER' || source.kind === 'MAILBOX'
      ? source.kind
      : null
  if (!kind) return null
  const ref =
    kind === 'DIRECTORY_USER'
      ? text(source.userRef, 200)
      : text(source.mailboxRef, 200)
  if (!ref) return null
  return {
    kind,
    ref,
    // Identity resolution is gated on the caller's role. A missing name is
    // expected for some readers and must not look like a failure.
    displayName: optionalText(source.displayName, 200),
    userPrincipalName: optionalText(source.userPrincipalName, 320),
  }
}

function adaptCount(value: unknown): NativeCount | null {
  const source = record(value)
  if (!source || !has(source, ['accuracy', 'value'])) return null
  const accuracy = source.accuracy
  if (
    accuracy !== 'EXACT' &&
    accuracy !== 'AT_LEAST' &&
    accuracy !== 'NOT_AVAILABLE'
  ) {
    return null
  }
  const raw = source.value
  // The contract guarantees null exactly on NOT_AVAILABLE. A payload breaking
  // that is contradicting itself rather than omitting something, so it is
  // refused rather than repaired -- repairing it would mean choosing which
  // half to believe, and either choice invents a fact.
  if (accuracy === 'NOT_AVAILABLE') {
    if (raw !== null) return null
  } else if (
    !Number.isSafeInteger(raw) ||
    (raw as number) < 0 ||
    (raw as number) > MAX_COUNT
  ) {
    return null
  }

  const scope = record(source.scope) ?? {}
  const covered = (list(scope.covered) ?? [])
    .map((entry) => text(entry, 120))
    .filter((entry): entry is string => entry !== null)
  const evidenceRequested = (list(scope.evidenceRequested) ?? [])
    .map((entry) => text(entry, 120))
    .filter((entry): entry is string => entry !== null)

  const notCovered: NativeCount['notCovered'] = []
  for (const entry of list(scope.notCovered) ?? []) {
    const item = record(entry)
    const detectorId = item ? text(item.detectorId, 120) : null
    const because = item ? text(item.because, 120) : null
    if (detectorId && because) notCovered.push({ detectorId, because })
  }

  return {
    accuracy,
    value: accuracy === 'NOT_AVAILABLE' ? null : (raw as number),
    covered,
    notCovered,
    evidenceRequested,
  }
}

/**
 * The response, or null when it cannot be read at all.
 *
 * Null is reserved for a payload this build cannot make sense of as a whole --
 * a different contract version, a missing discriminant, a finding resting on
 * nothing. It is not used for a missing optional field, which is the ordinary
 * state during a rollout rather than a fault.
 */
export function adaptNativeAssessment(value: unknown): NativeAssessment | null {
  const source = record(value)
  if (!source || !has(source, ['version', 'available'])) return null
  if (source.version !== NATIVE_RISKY_USERS_VERSION) return null

  if (source.available === false) {
    // An unrecognised reason is carried rather than rejected: the copy layer
    // has an honest fallback for it, and a reason this build has not heard of
    // is the expected consequence of the backend deploying first.
    const because = text(source.because, 120)
    return because ? { available: false, because } : null
  }
  if (source.available !== true) return null
  if (!has(source, ['run', 'count', 'findings'])) return null

  const run = record(source.run) ?? {}
  const count = adaptCount(source.count)
  if (!count) return null

  const collectors: NativeCollector[] = []
  for (const entry of list(source.collectors) ?? []) {
    const item = record(entry)
    if (!item) continue
    const collectorSource = text(item.source, 120)
    const status = text(item.status, 120)
    if (!collectorSource || !status) continue
    collectors.push({
      source: collectorSource,
      status,
      // Absent and null both mean never, and neither may become a date.
      lastSuccessfulCollectionAt: isoOrNull(item.lastSuccessfulCollectionAt),
    })
  }

  const coverage: NativeStreamCoverage[] = []
  for (const entry of list(source.coverage) ?? []) {
    const item = record(entry)
    if (!item) continue
    const stream = text(item.stream, 120)
    if (!stream) continue
    const split = record(item.coverage) ?? {}
    const whole = (value: unknown) =>
      Number.isSafeInteger(value) && (value as number) >= 0
        ? (value as number)
        : 0
    coverage.push({
      stream,
      applies: whole(split.applies),
      uninterpretedEvents: whole(split.uninterpretedEvents),
      notYetCitedEvents: whole(split.notYetCitedEvents),
    })
  }

  const claim = record(source.claim) ?? {}
  const withheld: { stream: string | null; because: string }[] = []
  if (claim.permitted === false) {
    for (const entry of list(claim.withheld) ?? []) {
      const item = record(entry)
      const because = item ? text(item.because, 120) : null
      if (!item || !because) continue
      // A null stream means the withholding is tenant-wide rather than
      // attributable to one stream, which is a different sentence.
      withheld.push({ stream: optionalText(item.stream, 120), because })
    }
  }

  const envelope = record(source.findings)
  if (!envelope || !has(envelope, ['complete', 'items'])) return null
  if (typeof envelope.complete !== 'boolean') return null
  const items = list(envelope.items)
  if (!items) return null

  const findings: NativeFinding[] = []
  for (const entry of items) {
    const item = record(entry)
    if (!item || !has(item, ['detectorId', 'subject', 'signals'])) return null
    const detectorId = text(item.detectorId, 120)
    const subject = adaptSubject(item.subject)
    const signals = adaptSignals(item.signals)
    // A finding without a subject or without signals rests on nothing. That is
    // self-contradicting rather than incomplete.
    if (!detectorId || !subject || !signals) return null
    findings.push({ detectorId, subject, signals })
  }

  return {
    available: true,
    run: {
      windowStart: isoOrNull(run.windowStart),
      windowEnd: isoOrNull(run.windowEnd),
      completedAt: isoOrNull(run.completedAt),
    },
    collectors,
    coverage,
    // Absent means this server does not speak the field, which during a
    // rollout is ordinary. Treated as "not named", because claiming a response
    // names people when it may not is the direction that misleads.
    subjectsNamed: source.subjectsNamed === true,
    count,
    withheld,
    findings,
    complete: envelope.complete,
  }
}
