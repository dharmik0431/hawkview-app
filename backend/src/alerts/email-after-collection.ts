/** Email never steals collector time or changes its result, even if its adapter fails. */
export async function emailAfterCollection<T>(
  result: T, deadlineAt: number, run?: (deadlineAt: number) => Promise<unknown>,
  clock: () => number = Date.now,
): Promise<T> {
  const at = clock()
  if (run && Number.isFinite(at) && Number.isFinite(deadlineAt) && deadlineAt - at >= 25_000) {
    try { await run(Math.min(deadlineAt, at + 25_000)) } catch { /* Collection already succeeded. */ }
  }
  return result
}