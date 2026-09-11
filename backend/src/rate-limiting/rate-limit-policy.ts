/** Which bucket a request belongs to, and which requests no bucket may refuse.
 *
 * A PURE FUNCTION, SEPARATE FROM THE NEST WIRING, because the decision worth
 * testing is the policy and not the plumbing. Everything here is decided from
 * four facts about a request, so the cases that matter — above all the ones that
 * must never be refused — are assertable without a server, a socket or a clock.
 *
 * THE EXEMPTIONS COME FIRST, AND THAT ORDERING IS THE GUARANTEE. The scheduler
 * heartbeat is answered before any configuration, any key and any counter is
 * consulted, so there is no setting, no limit, no flood and no bug in the
 * counter that can cause it to be refused. Expressed as a later `if`, or as a
 * large limit, the property would hold today and quietly stop holding the first
 * time somebody reordered the function or lowered a number.
 *
 * Why that matters more than the rest of this module: `POST
 * /api/internal/sync/due-tenants` is the product's heartbeat. It arrives once
 * every five minutes and it is what causes HawkView to collect anything at all.
 * A limiter that refuses it does not show an error to any customer or operator —
 * collection simply stops, the data goes stale, and every screen keeps
 * confidently displaying the last thing it knew. That is the failure shape this
 * team spent a night removing from the evaluation engine, and it must not be
 * reintroduced by the component added to make the service safer.
 */

/** The scheduler's routes. The whole prefix rather than the single known path:
 * every route under it is internal, scheduler-authenticated and called by our
 * own infrastructure, so the next one added inherits the exemption instead of
 * inheriting an outage nobody sees. */
export const SCHEDULER_PATH_PREFIX = '/api/internal/sync'

/** Liveness and readiness. Refusing these does not throttle an attacker, it
 * tells the platform the service is unhealthy and takes it out of rotation —
 * turning a rate limit into the outage it was meant to prevent. */
export const HEALTH_PATH_PREFIX = '/health'

export const WINDOW_MS = 60_000

/** Generous, per authenticated subject.
 *
 * DERIVED FROM MEASURED USE, not picked for roundness: one tenant page issues
 * about six requests, and an operator moving briskly through tenants was
 * measured at roughly sixty requests a minute. Six hundred is an order of
 * magnitude above that, which is the headroom a limit needs when the thing it
 * must never do is interrupt ordinary work. It still bounds what one
 * compromised token or one looping client can cost.
 *
 * Keyed on the SUBJECT rather than the address because an MSP office sits behind
 * one NAT: address-keyed, a busy afternoon in a ten-person office looks exactly
 * like one abusive caller, and the ten people are refused together. */
export const SUBJECT_REQUESTS_PER_WINDOW = 600

/** Tight, per address, for requests that carry no usable identity.
 *
 * A hundred and twenty a minute is far below what any flood is worth mounting
 * and far above what a legitimate caller produces: unauthenticated requests
 * should be a handful per session. The headroom exists for the one benign burst
 * we can name — an office whose tokens expire together after a key rotation, and
 * whose browsers all retry at once. */
export const UNAUTHENTICATED_REQUESTS_PER_WINDOW = 120

export type ExemptReason =
  | 'SCHEDULER_HEARTBEAT'
  | 'HEALTH_PROBE'
  | 'ENFORCEMENT_DISABLED'
  | 'NO_TRUSTED_CLIENT_ADDRESS'

export type RateLimitBucket = 'SUBJECT' | 'UNAUTHENTICATED'

export type RateLimitPlan =
  | { readonly enforce: false; readonly because: ExemptReason }
  | { readonly enforce: true; readonly bucket: RateLimitBucket; readonly key: string }

export interface RequestFacts {
  readonly path: string
  /** The VERIFIED subject, or null. Never a value decoded from an unverified
   * token: an attacker who could choose their own subject would mint a fresh
   * bucket per request and the limit would bound nothing. */
  readonly subject: string | null
  /** From `clientAddress`, which returns null whenever the address is not
   * knowable. Null must never collapse into a shared key. */
  readonly clientAddress: string | null
}

export interface RateLimitSettings {
  readonly enforce: boolean
}

export function isExemptPath(path: string): ExemptReason | null {
  const normalized = normalizePath(path)
  if (withinPrefix(normalized, SCHEDULER_PATH_PREFIX)) return 'SCHEDULER_HEARTBEAT'
  if (withinPrefix(normalized, HEALTH_PATH_PREFIX)) return 'HEALTH_PROBE'
  return null
}

export function planFor(facts: RequestFacts, settings: RateLimitSettings): RateLimitPlan {
  // FIRST, before configuration and before any key exists. See the file comment:
  // this ordering is what makes "the heartbeat cannot be refused" a property of
  // the code rather than a property of the current numbers.
  const exempt = isExemptPath(facts.path)
  if (exempt !== null) return { enforce: false, because: exempt }

  if (!settings.enforce) return { enforce: false, because: 'ENFORCEMENT_DISABLED' }

  // An authenticated subject is the better key whenever we have one: it is
  // verified, it survives a caller changing networks, and it does not punish
  // colleagues who share an office address.
  if (facts.subject !== null && facts.subject !== '') {
    return { enforce: true, bucket: 'SUBJECT', key: `subject:${facts.subject}` }
  }

  if (facts.clientAddress !== null && facts.clientAddress !== '') {
    return { enforce: true, bucket: 'UNAUTHENTICATED', key: `address:${facts.clientAddress}` }
  }

  // No identity and no knowable address. The only remaining key would be one
  // every caller shares, which is a global limit wearing a per-caller label —
  // so nothing is enforced and the gap is named.
  return { enforce: false, because: 'NO_TRUSTED_CLIENT_ADDRESS' }
}

/** Lowercased, query stripped, trailing slashes removed, and a guaranteed
 * leading slash, so that `/Health/`, `/health?probe=1` and `health` cannot
 * sidestep an exemption by spelling. */
export function normalizePath(path: string): string {
  const withoutQuery = path.split('?')[0].split('#')[0]
  const lowered = withoutQuery.toLowerCase()
  const leading = lowered.startsWith('/') ? lowered : `/${lowered}`
  const trimmed = leading.replace(/\/+$/, '')
  return trimmed === '' ? '/' : trimmed
}

/** True when `path` is the prefix itself or a route beneath it — but not when it
 * merely starts with the same characters, so `/healthcheck-admin` is not treated
 * as a health probe. */
function withinPrefix(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(`${prefix}/`)
}
