/** Client boundary for the DIRECTORY_ROLES collection control API.
 *
 * `enabled` is the durable opt-in and nothing else. It is NOT eligibility, NOT a running collection,
 * and NOT a trustworthy complete result — those live in the separate results boundary
 * (`directory-role-results-view.ts`). Enabling does not fetch anything.
 *
 * Parsing validates the shape the server promised. It does not establish that the server authorized
 * this caller: the server is the authorization boundary and answers with its own status codes. */

/** The optimistic-concurrency context the server observed. Every field is nullable, and the client
 * carries the exact observed values back on a write — it never re-derives or substitutes them. */
export type DirectoryRoleControlExpectation = {
  readonly configurationRevision: string | null
  readonly connectionIncarnation: string | null
  readonly scopeIncarnation: string | null
  readonly scopeVersion: string | null
}

export type DirectoryRoleControlView = {
  readonly enabled: boolean
  readonly expected: DirectoryRoleControlExpectation
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

/** Matches the server's own nullable-identifier rule: either null, or a non-empty string. */
const nullableId = (v: unknown): string | null | undefined => {
  if (v === null) return null
  if (typeof v === 'string' && v.length > 0) return v
  return undefined
}

/** The server bounds scopeVersion at 100 characters and rejects anything longer, so a longer value
 * could never be echoed back successfully; refusing it here keeps the client from offering a control
 * whose write is already guaranteed to fail. */
const nullableVersion = (v: unknown): string | null | undefined => {
  if (v === null) return null
  if (typeof v === 'string' && v.length > 0 && v.length <= 100) return v
  return undefined
}

/** Returns null for anything malformed. A null result means "we could not read this answer" — the
 * screen must present that as an unavailable control, never as `enabled: false`, which would state
 * a durable opt-in the server did not report. */
export function parseDirectoryRoleControl(value: unknown): DirectoryRoleControlView | null {
  if (!isRecord(value)) return null
  if (typeof value.enabled !== 'boolean') return null
  if (!isRecord(value.expected)) return null

  const raw = value.expected
  const configurationRevision = nullableId(raw.configurationRevision)
  const connectionIncarnation = nullableId(raw.connectionIncarnation)
  const scopeIncarnation = nullableId(raw.scopeIncarnation)
  const scopeVersion = nullableVersion(raw.scopeVersion)
  if (configurationRevision === undefined || connectionIncarnation === undefined
    || scopeIncarnation === undefined || scopeVersion === undefined) return null

  // The server's own paired invariant: a scope incarnation and its version are present together or
  // absent together. A half-present pair is a shape we cannot echo back, not a usable context.
  if ((scopeIncarnation === null) !== (scopeVersion === null)) return null

  return {
    enabled: value.enabled,
    expected: { configurationRevision, connectionIncarnation, scopeIncarnation, scopeVersion },
  }
}

/** Presentational gate only. The server authorizes every control request on its own and refuses a
 * technician, viewer, disabled member or cross-org caller regardless of what this returns; this just
 * avoids offering an action that would be refused. It is never evidence that a caller is permitted. */
export function isDirectoryControlOffered(
  memberships: readonly { readonly role: string }[] | null | undefined
): boolean {
  if (!memberships) return false
  return memberships.some((m) => m.role === 'MSP_OWNER' || m.role === 'MSP_ADMIN')
}

export type DirectoryRoleControlAffordance = {
  readonly canEnable: boolean
  readonly canDisable: boolean
  /** Opt-in is off AND the server reported no current configuration or connection, so enabling
   * cannot succeed yet. Distinct from "not permitted" and from "already off". */
  readonly eligibilityUnavailable: boolean
}

/** What the screen may offer, derived only from what the server reported.
 *
 * Disable stays available whenever opt-in is on, including when configuration or connection is
 * unavailable: revoking does not require eligibility, and withdrawing consent must not depend on the
 * very connection the user may be trying to stop collecting through. Enable requires both a current
 * configuration and a current connection, which is what the server itself demands. */
export function directoryRoleControlAffordance(
  control: DirectoryRoleControlView | null,
  offered: boolean
): DirectoryRoleControlAffordance {
  if (!offered || !control) {
    return { canEnable: false, canDisable: false, eligibilityUnavailable: false }
  }
  const eligible =
    control.expected.configurationRevision !== null && control.expected.connectionIncarnation !== null
  if (control.enabled) {
    return { canEnable: false, canDisable: true, eligibilityUnavailable: false }
  }
  return { canEnable: eligible, canDisable: false, eligibilityUnavailable: !eligible }
}
