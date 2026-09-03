import { Logger } from '@nestjs/common'

const MAX_PHASE_LENGTH = 64

function phaseName(phase: string) {
  const normalized = phase.trim().replace(/[^a-z0-9_-]/gi, '_').slice(0, MAX_PHASE_LENGTH)
  return normalized || 'unknown'
}

/**
 * Emits only bounded process counters.  It intentionally accepts no request,
 * tenant, error, or upstream-response data so operational telemetry cannot
 * become a route for customer metadata or credentials.
 */
export function logProcessMemoryPhase(
  logger: Pick<Logger, 'log'>,
  phase: string,
  outcome: 'STARTED' | 'COMPLETED' | 'FAILED',
  startedAt = Date.now(),
) {
  const memory = process.memoryUsage()
  const elapsedMs = Math.max(0, Math.min(24 * 60 * 60 * 1_000, Date.now() - startedAt))
  logger.log(JSON.stringify({
    event: 'runtime_memory_phase',
    phase: phaseName(phase),
    outcome,
    elapsedMs,
    rssBytes: Math.max(0, Math.floor(memory.rss)),
    heapUsedBytes: Math.max(0, Math.floor(memory.heapUsed)),
    heapTotalBytes: Math.max(0, Math.floor(memory.heapTotal)),
    externalBytes: Math.max(0, Math.floor(memory.external)),
  }))
}
