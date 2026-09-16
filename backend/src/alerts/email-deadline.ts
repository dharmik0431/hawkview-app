/** One immutable deadline. A backward wall-clock jump cannot replenish its budget. */
export function emailDeadline(
  deadlineAt: number, clock: () => number = Date.now, monotonic: () => number = () => performance.now(),
) {
  const initial = deadlineAt - clock()
  const started = monotonic()
  const remaining = (): number => {
    const value = Math.floor(Math.min(deadlineAt - clock(), initial - (monotonic() - started)))
    if (!Number.isFinite(value) || value <= 0) throw new Error('EMAIL_DEADLINE_EXHAUSTED')
    return value
  }
  return {
    remaining,
    transactionLimits() {
      const available = remaining()
      if (available <= 200) throw new Error('EMAIL_DEADLINE_EXHAUSTED')
      const maxWait = Math.min(250, available - 150)
      return { maxWait, timeout: Math.min(5_000, available - maxWait - 100) }
    },
    statementLimit() { return Math.max(1, Math.min(2_000, remaining() - 50)) },
  }
}