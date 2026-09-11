import { trustedProxyHops } from './client-address.js'

/** Configuration, read per request rather than captured at construction.
 *
 * READ PER REQUEST ON PURPOSE. The one thing an operator needs from this
 * component at three in the morning is the ability to take it out of the
 * picture, and a value captured in a constructor cannot be changed without a
 * restart of every instance. `docs/rate-limiting.md` names this as the first
 * thing to do if collection or a screen is suspected of being refused.
 *
 * The cost is an environment read per request, which is a property lookup.
 */

export interface ResolvedRateLimitSettings {
  /** False removes every limit. Enforcement is ON by default: a limiter that
   * needs to be switched on is one that will be found switched off. */
  readonly enforce: boolean
  /** How many proxies in front of this service may be believed about who the
   * caller is. Null means unstated, which keeps every address-keyed limit inert
   * rather than keying them on a value every caller shares. */
  readonly trustedProxyHops: number | null
}

export const RATE_LIMIT_ENFORCE_VARIABLE = 'HAWKVIEW_RATE_LIMIT_ENFORCE'
export const TRUSTED_PROXY_HOPS_VARIABLE = 'HAWKVIEW_TRUSTED_PROXY_HOPS'

export function rateLimitSettings(
  environment: NodeJS.ProcessEnv = process.env,
): ResolvedRateLimitSettings {
  // Only the exact string "false" disables it. A typo, an empty value or an
  // accidental "0" must not silently remove every limit — if the intent is to
  // switch this off, it should have to be spelled out.
  const enforce = environment[RATE_LIMIT_ENFORCE_VARIABLE]?.trim().toLowerCase() !== 'false'
  return {
    enforce,
    trustedProxyHops: trustedProxyHops(environment[TRUSTED_PROXY_HOPS_VARIABLE]),
  }
}
