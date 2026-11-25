/**
 * INERT `pg` REPLACEMENT, used only by the import observer.
 *
 * It records the real adapter's actual client wiring -- the options it
 * constructs a Client with, and every `connect`, `query` and `end` call -- and
 * never opens a socket, resolves a name or speaks the PostgreSQL protocol.
 *
 * It answers just enough for the driver to reach its first deployment attempt,
 * so the recorded log can show the real `spawnSync` request as well. Beyond
 * that it returns nothing and the driver refuses, which is the expected end of
 * an inert run.
 */
const observer = globalThis.__HAW70_OBSERVER__
const record = (kind, detail) => { observer?.record(kind, detail) }

/** Canned answers keyed by a distinctive fragment of the driver's own SQL. */
function answer(sql) {
  if (sql.includes('current_database()')) {
    return [{ database: 'hawkview_ci', user: 'hawkview_ci', port: 5432,
      version_num: '160004', time_zone: 'UTC' }]
  }
  if (sql.includes('to_regclass')) return [{ public_objects: '0', history_present: false }]
  return []
}

export class Client {
  constructor(options) {
    // The ACTUAL options the adapter built, recorded field by field. The
    // password is recorded only as a length, never as a value.
    const { password, ...rest } = options ?? {}
    record('pg:construct', JSON.stringify({
      ...rest, passwordLength: typeof password === 'string' ? password.length : null }))
    this.ended = 0
    if (process.env.HAW70_OBSERVER_PG_CONNECT_REJECTS === '1') this.failConnect = true
  }

  async connect() {
    record('pg:connect', this.failConnect === true ? 'rejecting' : 'accepted')
    if (this.failConnect === true) throw new Error('INERT STUB: connect refused')
  }

  async query(sql, parameters) {
    record('pg:query', JSON.stringify({
      sql: String(sql).replace(/\s+/g, ' ').trim().slice(0, 120),
      parameterCount: Array.isArray(parameters) ? parameters.length : 0 }))
    return { rows: answer(String(sql)) }
  }

  async end() {
    this.ended += 1
    record('pg:end', String(this.ended))
  }
}

export default { Client }
