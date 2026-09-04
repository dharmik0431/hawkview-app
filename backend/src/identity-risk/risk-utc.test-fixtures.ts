import assert from 'node:assert/strict'

/** Minimal interactive-transaction adapter for existing in-memory collector fakes. */
export function utcTestDatabase<T extends object>(database: T) {
  return Object.assign(database, {
    $executeRawUnsafe: async (sql: string) => { assert.equal(sql, "SET LOCAL TIME ZONE 'UTC'"); return 0 },
    $queryRawUnsafe: async (sql: string) => {
      assert.equal(sql, "SELECT current_setting('TimeZone') AS timezone")
      return [{ timezone: 'UTC' }]
    },
    $transaction: async (work: ((tx: T) => Promise<unknown>) | Promise<unknown>[]) =>
      typeof work === 'function' ? work(database) : Promise.all(work),
  })
}
