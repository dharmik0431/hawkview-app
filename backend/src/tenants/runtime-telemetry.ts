import { Logger } from '@nestjs/common'

const PHASES = new Set([
  'scheduled_sync',
  'scheduled_sync_maintenance',
  'exchange_configuration_collection',
] as const)
const OUTCOMES = new Set(['STARTED', 'COMPLETED', 'FAILED'] as const)
export type RuntimeMemoryPhase = typeof PHASES extends Set<infer T> ? T : never
export type RuntimeMemoryOutcome = typeof OUTCOMES extends Set<infer T> ? T : never

function knownPhase(value: unknown): RuntimeMemoryPhase | 'UNKNOWN' {
  return typeof value === 'string' && PHASES.has(value as RuntimeMemoryPhase)
    ? value as RuntimeMemoryPhase
    : 'UNKNOWN'
}

function knownOutcome(value: unknown): RuntimeMemoryOutcome | 'UNKNOWN' {
  return typeof value === 'string' && OUTCOMES.has(value as RuntimeMemoryOutcome)
    ? value as RuntimeMemoryOutcome
    : 'UNKNOWN'
}

/**
 * Emits only bounded process counters.  It intentionally accepts no request,
 * tenant, error, or upstream-response data so operational telemetry cannot
 * become a route for customer metadata or credentials.
 */
export function logProcessMemoryPhase(
  logger: Pick<Logger, 'log'>,
  phase: unknown,
  outcome: unknown,
  startedAt = Date.now(),
) {
  const memory = process.memoryUsage()
  const elapsedMs = Math.max(0, Math.min(24 * 60 * 60 * 1_000, Date.now() - startedAt))
  logger.log(JSON.stringify({
    event: 'runtime_memory_phase',
    phase: knownPhase(phase),
    outcome: knownOutcome(outcome),
    elapsedMs,
    rssBytes: Math.max(0, Math.floor(memory.rss)),
    heapUsedBytes: Math.max(0, Math.floor(memory.heapUsed)),
    heapTotalBytes: Math.max(0, Math.floor(memory.heapTotal)),
    externalBytes: Math.max(0, Math.floor(memory.external)),
  }))
}
