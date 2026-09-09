import { Logger } from '@nestjs/common'

/** Process-local diagnostic hints, never tenant evidence or durable telemetry.
 * No caller-owned objects, identifiers, messages or cardinalities enter the sink. */
export const READER_REASONS = ['NO_COMPLETED_RUN', 'MEMORY_LANE_BUSY', 'SCOPED_SOURCE_UNAVAILABLE',
  'STORED_ASSESSMENT_INVALID', 'KEY_UNAVAILABLE', 'READ_FAILED', 'SUCCESS'] as const
export type ReaderReason = typeof READER_REASONS[number]
export const CYCLE_REASONS = ['CONFIG_UNAVAILABLE', 'MAINTENANCE_DEFERRED', 'ADMISSION_BUDGET_EXHAUSTED',
  'DEPENDENCY_UNAVAILABLE', 'MEMORY_LANE_BUSY', 'LEASE_BUSY', 'NO_ELIGIBLE_WORK', 'ATTEMPT_FAILED',
  'RETURNED_UNCOMMITTED', 'COMMITTED', 'CANDIDATE_INELIGIBLE', 'CYCLE_CLAIM_FAILED',
  'SCOPE_SELECTION_FAILED', 'ATTEMPT_RECORD_FAILED', 'KEY_ENSURE_FAILED', 'EVALUATION_FAILED'] as const
export type CycleReason = typeof CYCLE_REASONS[number]
export type DiagnosticSink = (line: string) => void
export const READER_FLUSH_MS = 60_000
export const MAX_DIAGNOSTIC_COUNTER = 65_535
const readerReasons = new Set<string>(READER_REASONS)
const cycleReasons = new Set<string>(CYCLE_REASONS)
const logger = new Logger('RiskOperationalDiagnostics')
const defaultSink: DiagnosticSink = line => { logger.log(line) }

function emit(sink: DiagnosticSink, record: object) {
  try { sink(JSON.stringify(record)) } catch { /* Diagnostics cannot affect application work. */ }
}

// Priority preserves partial/failing cycle truth: one committed attempt cannot
// hide another failure, skipped budget, or noncommitted evaluator return.
const priority: Record<CycleReason, number> = {
  NO_ELIGIBLE_WORK: 0, CANDIDATE_INELIGIBLE: 0.5, COMMITTED: 1, RETURNED_UNCOMMITTED: 2, LEASE_BUSY: 3,
  MEMORY_LANE_BUSY: 4, DEPENDENCY_UNAVAILABLE: 5, ADMISSION_BUDGET_EXHAUSTED: 6,
  MAINTENANCE_DEFERRED: 7, CONFIG_UNAVAILABLE: 8, ATTEMPT_FAILED: 9,
  CYCLE_CLAIM_FAILED: 10, SCOPE_SELECTION_FAILED: 10, ATTEMPT_RECORD_FAILED: 10,
  KEY_ENSURE_FAILED: 10, EVALUATION_FAILED: 10,
}
export class RiskCycleDiagnostic {
  private reason: CycleReason | null = null
  private emitted = false
  constructor(private readonly sink: DiagnosticSink = defaultSink) {}
  record(value: unknown) {
    if (this.emitted) return
    const reason = typeof value === 'string' && value.length <= 32 && cycleReasons.has(value) ? value as CycleReason : 'ATTEMPT_FAILED'
    if (!this.reason || priority[reason] > priority[this.reason]) this.reason = reason
  }
  finish() {
    if (this.emitted) return
    this.emitted = true
    emit(this.sink, { version: 1, eventName: 'risk_cycle_diagnostic', reason: this.reason ?? 'RETURNED_UNCOMMITTED' })
  }
}

export function observeCycle(observe: ((reason: CycleReason) => void) | undefined, reason: CycleReason) {
  try { observe?.(reason) } catch { /* Optional observer must not alter locks or results. */ }
}

export class RiskReaderDiagnostics {
  private counters = Object.fromEntries(READER_REASONS.map(reason => [reason, 0])) as Record<ReaderReason, number>
  private nextFlush: number
  constructor(private readonly sink: DiagnosticSink = defaultSink, private readonly now = () => Date.now()) {
    this.nextFlush = now() + READER_FLUSH_MS
  }
  record(value: unknown) {
    const reason = typeof value === 'string' && value.length <= 32 && readerReasons.has(value) ? value as ReaderReason : 'READ_FAILED'
    this.counters[reason] = Math.min(MAX_DIAGNOSTIC_COUNTER, this.counters[reason] + 1)
  }
  flush() {
    const now = this.now()
    if (!Number.isFinite(now) || now < this.nextFlush) return
    this.nextFlush = now + READER_FLUSH_MS
    if (!READER_REASONS.some(reason => this.counters[reason] > 0)) return
    const counters = this.counters
    this.counters = Object.fromEntries(READER_REASONS.map(reason => [reason, 0])) as Record<ReaderReason, number>
    emit(this.sink, { version: 1, eventName: 'risk_reader_diagnostic', reason: 'AGGREGATED', counters })
  }
}
const readers = new RiskReaderDiagnostics()
let readerTimer: ReturnType<typeof setInterval> | undefined
export function recordRiskReader(reason: ReaderReason) {
  try {
    readers.record(reason)
    if (!readerTimer) {
      readerTimer = setInterval(() => { try { readers.flush() } catch { /* best effort */ } }, READER_FLUSH_MS)
      readerTimer.unref()
    }
  } catch { /* No diagnostic failure may change an HTTP result. */ }
}
