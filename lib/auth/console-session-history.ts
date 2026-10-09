/** Client contract for the self-only console session history.
 *
 * The server owns every judgement here. This module only decides whether a
 * response is readable at all: anything it cannot fully validate becomes
 * `unreadable`, never a partial list and never an empty success. "We could not
 * read this" and "there is nothing recorded" are different answers, and the
 * panel must be able to tell them apart.
 */

export const CONSOLE_SESSION_HISTORY_VERSION = 'console-session-history/v1'
export const CONSOLE_SESSION_HISTORY_LIMIT = 50

export type ConsoleSessionHistoryState = 'revoked' | 'expired' | 'idle-eligible' | 'unknown'

export type ConsoleSessionHistoryRow = {
  authenticatedAt: string | null
  idleExpiresAt: string
  revokedAt: string | null
  createdAt: string
  state: ConsoleSessionHistoryState
  isCurrent: boolean
}

export type ConsoleSessionHistory = {
  responseVersion: typeof CONSOLE_SESSION_HISTORY_VERSION
  generatedAt: string
  returned: number
  truncated: boolean
  sessions: ConsoleSessionHistoryRow[]
}

const STATES: ConsoleSessionHistoryState[] = ['revoked', 'expired', 'idle-eligible', 'unknown']

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** A timestamp is usable only if it is a string we can turn into a finite time.
 * An empty string is explicitly not a date — the server must never send one, and
 * if it ever does we refuse rather than render a blank. */
const readInstant = (value: unknown): number | null => {
  if (typeof value !== 'string' || value.length === 0) return null
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : null
}

const readNullableInstant = (value: unknown): { ok: boolean } =>
  value === null ? { ok: true } : { ok: readInstant(value) !== null }

function readRow(value: unknown): ConsoleSessionHistoryRow | null {
  if (!isObject(value)) return null
  const { authenticatedAt, idleExpiresAt, revokedAt, createdAt, state, isCurrent } = value
  if (typeof isCurrent !== 'boolean') return null
  if (typeof state !== 'string' || !STATES.includes(state as ConsoleSessionHistoryState)) return null
  if (readInstant(idleExpiresAt) === null || readInstant(createdAt) === null) return null
  if (!readNullableInstant(authenticatedAt).ok || !readNullableInstant(revokedAt).ok) return null
  return {
    authenticatedAt: (authenticatedAt as string | null),
    idleExpiresAt: idleExpiresAt as string,
    revokedAt: (revokedAt as string | null),
    createdAt: createdAt as string,
    state: state as ConsoleSessionHistoryState,
    isCurrent: isCurrent as boolean,
  }
}

/** Returns null for anything unreadable. Callers must treat null as "cannot
 * read", distinct from a readable response carrying zero sessions. */
export function parseConsoleSessionHistory(value: unknown): ConsoleSessionHistory | null {
  if (!isObject(value)) return null
  if (value.responseVersion !== CONSOLE_SESSION_HISTORY_VERSION) return null
  if (readInstant(value.generatedAt) === null) return null
  if (typeof value.truncated !== 'boolean') return null
  if (typeof value.returned !== 'number' || !Number.isInteger(value.returned)) return null
  if (value.returned < 0 || value.returned > CONSOLE_SESSION_HISTORY_LIMIT) return null
  if (!Array.isArray(value.sessions)) return null
  if (value.sessions.length !== value.returned) return null
  if (value.sessions.length > CONSOLE_SESSION_HISTORY_LIMIT) return null
  // A truncation flag with fewer than the maximum rows contradicts itself.
  if (value.truncated && value.sessions.length !== CONSOLE_SESSION_HISTORY_LIMIT) return null

  const sessions: ConsoleSessionHistoryRow[] = []
  for (const candidate of value.sessions) {
    const row = readRow(candidate)
    if (!row) return null
    sessions.push(row)
  }
  // More than one current session would mean the server marked a row we did not
  // ask about; refuse rather than show two "this browser" entries.
  if (sessions.filter(row => row.isCurrent).length > 1) return null

  return {
    responseVersion: CONSOLE_SESSION_HISTORY_VERSION,
    generatedAt: value.generatedAt as string,
    returned: value.returned as number,
    truncated: value.truncated as boolean,
    sessions,
  }
}

/** Phases carry the identity they were produced for, so a render that happens
 * after an account change can discard them before painting. */
export type IdentityBoundPhase<TReady> =
  | { kind: 'idle'; token: null }
  | { kind: 'loading'; token: string }
  | { kind: 'ready'; token: string; history: TReady }
  | { kind: 'unreadable'; token: string }

/** Decides what may be painted for `token`.
 *
 * Pure and synchronous on purpose. Clearing stale state in an effect is too
 * late — the offending frame has already been shown — and a mounted test cannot
 * observe that frame, because `act` flushes effects before assertions run. So
 * the rule lives here, where removing it fails a test that actually exercises it.
 */
export function visibleForIdentity<TReady>(
  phase: IdentityBoundPhase<TReady>,
  token: string | null
): IdentityBoundPhase<TReady> {
  if (token === null) return { kind: 'idle', token: null }
  return phase.token === token ? phase : { kind: 'loading', token }
}

/** Copy is chosen from recorded state only. Nothing here implies that a session
 * is online, and an expired session is never described as revoked. */
export function describeSessionState(state: ConsoleSessionHistoryState): string {
  switch (state) {
    case 'revoked':
      return 'Signed out'
    case 'expired':
      return 'Ended by inactivity'
    case 'idle-eligible':
      return 'Within its inactivity window'
    case 'unknown':
      return 'Not reconciled'
  }
}

/** Ages are stated relative to the server's own sample, never the browser clock,
 * so a skewed device cannot invent a different history. */
export function formatAsOfAge(instant: string, generatedAt: string): string | null {
  const at = readInstant(instant)
  const asOf = readInstant(generatedAt)
  if (at === null || asOf === null) return null
  const seconds = Math.round((asOf - at) / 1000)
  if (seconds < 0) return null
  if (seconds < 60) return 'less than a minute'
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'}`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'}`
  const days = Math.floor(hours / 24)
  return `${days} day${days === 1 ? '' : 's'}`
}
