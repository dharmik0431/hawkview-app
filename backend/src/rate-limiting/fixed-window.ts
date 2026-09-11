/** A bounded fixed-window request counter.
 *
 * FIXED WINDOW RATHER THAN SLIDING, and the reason is the heap. A sliding
 * window keeps a timestamp per request per key, so the memory an attacker can
 * make us spend grows with the requests they send — which is the wrong
 * direction for a component whose job is to survive being attacked. A fixed
 * window costs two numbers per key no matter how many requests arrive.
 *
 * The cost of that choice is the window boundary: a caller can spend its whole
 * allowance at the end of one window and again at the start of the next, so the
 * true worst case is twice the limit across a window's span. That is acceptable
 * because these limits exist to bound abuse, not to meter a quota — the numbers
 * are set an order of magnitude above real use, and twice a generous number is
 * still generous. It would NOT be acceptable for a billing counter.
 *
 * IN-MEMORY AND PER-INSTANCE, deliberately. A shared counter means Redis: a new
 * dependency, and a new thing that can be unreachable. A limiter that refuses
 * everything when its store is down is a worse outage than the abuse it
 * prevents, and a limiter that allows everything is one we cannot rely on. With
 * N service instances the effective ceiling is N times the configured number,
 * which `docs/rate-limiting.md` states so nobody reads these figures as exact.
 */

export interface WindowState {
  /** False once the limit is exceeded within the current window. */
  readonly allowed: boolean
  /** Hits recorded in the current window, including this one. */
  readonly count: number
  readonly limit: number
  /** Whole seconds until the window resets; never below one. */
  readonly retryAfterSeconds: number
}

interface Window {
  count: number
  endsAtMs: number
}

export class FixedWindowCounter {
  private readonly windows = new Map<string, Window>()

  /** Keys evicted while still live, i.e. the cap was reached with nothing
   * expired. Non-zero means the cap is too low for this deployment rather than
   * that anything is wrong with a caller, so it is worth being able to read. */
  private liveEvictions = 0

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly maxKeys = 20_000,
  ) {
    // A limit of zero would refuse every request, which is the failure mode this
    // whole module exists to avoid. Refuse to be constructed that way rather
    // than discovering it in production.
    if (!Number.isInteger(limit) || limit < 1) {
      throw new Error('A rate limit must be a whole number of at least one request.')
    }
    if (!Number.isInteger(windowMs) || windowMs < 1) {
      throw new Error('A rate limit window must be a positive whole number of milliseconds.')
    }
    if (!Number.isInteger(maxKeys) || maxKeys < 1) {
      throw new Error('A rate limit key cap must be a positive whole number.')
    }
  }

  /** Records one request against `key` and says whether it is within the limit. */
  hit(key: string, nowMs: number): WindowState {
    const existing = this.windows.get(key)
    if (existing !== undefined && nowMs < existing.endsAtMs) {
      existing.count += 1
      return this.stateOf(existing, nowMs)
    }
    // Either unseen, or its window has closed. Both start a fresh window; the
    // expired entry is simply overwritten.
    if (existing === undefined && this.windows.size >= this.maxKeys) this.makeRoom(nowMs)
    const fresh: Window = { count: 1, endsAtMs: nowMs + this.windowMs }
    this.windows.set(key, fresh)
    return this.stateOf(fresh, nowMs)
  }

  /** Reads the current state for `key` WITHOUT recording a request. */
  peek(key: string, nowMs: number): WindowState {
    const existing = this.windows.get(key)
    if (existing === undefined || nowMs >= existing.endsAtMs) {
      return { allowed: true, count: 0, limit: this.limit, retryAfterSeconds: 1 }
    }
    return this.stateOf(existing, nowMs)
  }

  /** Live key count, for tests and for telemetry about the cap. */
  size(): number {
    return this.windows.size
  }

  evictionsUnderPressure(): number {
    return this.liveEvictions
  }

  private stateOf(window: Window, nowMs: number): WindowState {
    return {
      allowed: window.count <= this.limit,
      count: window.count,
      limit: this.limit,
      // Always at least a second: a Retry-After of 0 invites an immediate retry
      // and reads, to anything parsing it, like "no wait required".
      retryAfterSeconds: Math.max(1, Math.ceil((window.endsAtMs - nowMs) / 1000)),
    }
  }

  /** Drops expired windows, and if that is not enough, the one closest to
   * expiring.
   *
   * EVICTING A LIVE KEY FORGIVES THAT CALLER'S COUNT, which is the lesser harm
   * on purpose. The alternative — refusing to track a new key once full, and so
   * refusing the request — would turn heap pressure into refusals for callers
   * who have done nothing, including a customer signing in for the first time
   * during someone else's flood. This degrades the limiter under pressure
   * instead of degrading the product, and `liveEvictions` makes the degradation
   * visible rather than silent. */
  private makeRoom(nowMs: number) {
    for (const [key, window] of this.windows) {
      if (nowMs >= window.endsAtMs) this.windows.delete(key)
    }
    if (this.windows.size < this.maxKeys) return
    let soonest: string | null = null
    let soonestEndsAtMs = Number.POSITIVE_INFINITY
    for (const [key, window] of this.windows) {
      if (window.endsAtMs < soonestEndsAtMs) {
        soonest = key
        soonestEndsAtMs = window.endsAtMs
      }
    }
    if (soonest !== null) {
      this.windows.delete(soonest)
      this.liveEvictions += 1
    }
  }
}
