/** The address a request actually came from, or null when we cannot know it.
 *
 * NULL IS THE IMPORTANT RETURN VALUE, and the reason this module exists at all.
 *
 * Nothing in this backend configures Express to trust a proxy: `main.ts` calls
 * `NestFactory.create` and never sets `trust proxy`, so `request.ip` is the peer
 * that opened the socket. In production that peer is the platform's edge, which
 * is the SAME for every request the service receives. A per-address limiter
 * keyed on it would put every customer of every MSP into one bucket and quietly
 * convert a per-caller limit into a global one — the entire API refused after N
 * requests a minute, for everyone, from a change whose unit tests all pass
 * because a synthetic request carries its own distinct address.
 *
 * X-Forwarded-For cannot simply be read instead. A client may send its own, and
 * a proxy appends rather than replaces, so the LEFTMOST entries are
 * caller-controlled. Keying on those would let an attacker mint a fresh bucket
 * per request by varying a header — the same forgery `RequestCorrelationMiddleware`
 * already refuses for audit identifiers, one layer out.
 *
 * What makes the header readable is knowing how many trailing entries were
 * appended by infrastructure we control. That number is a property of the
 * deployment, not of the code, so it must be stated by whoever operates the
 * deployment. Until it is stated this returns null and every address-keyed limit
 * stays inert.
 *
 * INERT IS THE RIGHT DEFAULT HERE. The address-keyed limits are defence in
 * depth; the cost of guessing the hop count wrong is a total outage. An
 * unenforced limit is a gap we have written down. A limit keyed on a value that
 * is identical for everybody is an outage we have not.
 */

/** Characters that can legitimately appear in an IPv4 or IPv6 literal, plus the
 * zone separator. Anything else means we were handed something that is not an
 * address, and an unparseable address is indeterminate — never a shared key. */
const ADDRESS_SHAPE = /^[0-9a-f.:%]+$/i

/** Reads the trusted hop count from configuration.
 *
 * Absent, unparseable, or negative all mean "not stated", which is null rather
 * than a default guess: a wrong guess here is the outage described above, and
 * silently picking 1 because it is the common case would be exactly that guess.
 */
export function trustedProxyHops(value: string | undefined): number | null {
  const candidate = value?.trim() ?? ''
  if (candidate === '') return null
  if (!/^\d+$/.test(candidate)) return null
  const hops = Number(candidate)
  return Number.isSafeInteger(hops) ? hops : null
}

export function clientAddress(
  forwardedFor: string | string[] | undefined,
  socketAddress: string | undefined,
  hops: number | null,
): string | null {
  if (hops === null) return null

  // Zero trusted proxies means the service is reached directly, so the socket
  // peer IS the client and the header — which anyone may send — is ignored.
  if (hops === 0) return normalize(socketAddress)

  const entries = (Array.isArray(forwardedFor) ? forwardedFor.join(',') : forwardedFor ?? '')
    .split(',')
    .map(entry => entry.trim())
    .filter(entry => entry !== '')

  // Counting from the RIGHT. Each proxy appends the peer it saw, so with `hops`
  // trusted proxies in front of us the outermost one appended the real client,
  // and the `hops - 1` entries after it are the proxies themselves. Anything
  // further left was supplied by the caller and is not evidence of anything.
  //
  // Too few entries means the request did not traverse the proxies we were told
  // to expect, so we do not know who sent it. That is null, not the leftmost
  // entry we happen to have.
  if (entries.length < hops) return null
  return normalize(entries[entries.length - hops])
}

function normalize(value: string | undefined): string | null {
  let candidate = value?.trim() ?? ''
  if (candidate === '') return null
  // An IPv6 literal may arrive bracketed, with or without a port.
  const bracketed = candidate.match(/^\[([^\]]+)\](?::\d+)?$/)
  if (bracketed) candidate = bracketed[1]
  // IPv4 with a port. Only stripped when there is exactly one colon, so an
  // unbracketed IPv6 literal is not truncated at its first group.
  else if ((candidate.match(/:/g)?.length ?? 0) === 1 && candidate.includes('.')) {
    candidate = candidate.slice(0, candidate.indexOf(':'))
  }
  // IPv4-mapped IPv6, which is how a v4 peer often appears on a dual-stack
  // socket. Folded so the same caller is one bucket rather than two.
  const mapped = candidate.match(/^::ffff:((?:\d{1,3}\.){3}\d{1,3})$/i)
  if (mapped) candidate = mapped[1]
  if (candidate === '' || !ADDRESS_SHAPE.test(candidate)) return null
  return candidate.toLowerCase()
}
