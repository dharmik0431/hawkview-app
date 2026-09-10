import type { Finding, FindingSignal } from '../evaluation-core/contract.js'

/** The wire shape for a finding's evidence, and the rules for putting it there.
 *
 * Written to the consumer's stated constraints rather than to what is
 * convenient here — the renderer carries the cost of every choice below, and
 * two of them were decided against my proposal.
 *
 * WHY A SEPARATE TYPE FROM THE CORE'S `FindingSignal`, given they currently
 * match field for field: the core's is an internal contract two modules agree
 * on and may change freely; this one is published to a deployed frontend and
 * cannot. Aliasing them would make a core refactor a silent breaking change to
 * something already running in a browser. The mapping being trivial is what a
 * seam looks like when nothing has diverged yet.
 */

export type SignalRecencyDto = Readonly<{
  at: string
  /** EVENT_OCCURRED = when it happened. STATE_OBSERVED = when we looked and the
   * state was still set. A read time is always recent, so a renderer that
   * cannot tell them apart shows a six-month-old forwarding rule as the most
   * urgent item on the page. */
  kind: 'EVENT_OCCURRED' | 'STATE_OBSERVED'
}>

export type SignalDto = Readonly<{
  signal: string
  count: number
  /** `null` = evaluated and none occurred. A signal ABSENT from the array was
   * never evaluated. Different facts, and the renderer prints different
   * sentences for them. */
  latest: SignalRecencyDto | null
  /** The window was truncated, so `count` is a floor.
   *
   * MUST NOT be confused with the tenant count's `AT_LEAST`. Both mean "floor"
   * and they bound different things: this bounds an evidence window, that
   * bounds a population of people. A technician reading "at least 4 users"
   * because a lockout window truncated would be given a fabricated lower bound
   * on how many people are affected. Separate axes, deliberately. */
  capped: boolean
}>

/** Non-empty, mirroring the core. A finding resting on nothing is a finding
 * whose basis nobody recorded. */
export type SignalsDto = readonly [SignalDto, ...SignalDto[]]

const toSignal = (signal: FindingSignal): SignalDto => ({
  signal: signal.signal,
  count: signal.count,
  latest: signal.latest === null ? null : { at: signal.latest.at, kind: signal.latest.kind },
  capped: signal.capped,
})

export function signalsOf(finding: Finding): SignalsDto {
  const [first, ...rest] = finding.signals
  return [toSignal(first), ...rest.map(toSignal)]
}

/** Attaches `signals` to a finding's wire object, or omits the key entirely.
 *
 * ABSENCE IS THE MISSING KEY. Not `null`, and never `[]`. The consumer's
 * reasoning, which is better than the reason I offered:
 *
 *   - MISSING KEY already means "this server does not speak this field" to a
 *     presence-based adapter. Both halves of a split deploy work with no new
 *     code on either side, which matters because frontend and backend publish
 *     through separate systems and every release has a window where one side is
 *     old.
 *
 *   - `null` would mean "the server speaks this field and is telling you
 *     something", and there is nothing for it to tell. The consumer would
 *     collapse it to the same handling as absent, so the distinction would
 *     exist only to be discarded.
 *
 *   - `[]` is not ambiguous, it is SELF-CONTRADICTING. This contract says a
 *     signal missing from the array was never evaluated, so an empty array
 *     asserts a finding that exists on the strength of nothing. The consumer
 *     rejects it to keep it meaning that — which means using `[]` as an
 *     old-server sentinel would make them reject every finding in the tenant
 *     for the length of the deploy window. Silent, total, and indistinguishable
 *     from a clean tenant: the exact failure this whole feature exists to end.
 *
 * ADDITIVE ON BOTH SIDES. The finding-level `evidenceCount`,
 * `evidenceCountCapped`, `firstSeen` and `lastSeen` that `signals` supersedes
 * must survive at least one release after this ships. An old frontend against a
 * new backend is the same deploy window as the reverse, and it is the one where
 * the consumer has no fallback to reach for.
 */
export function withSignals<T extends object>(
  wire: T, signals: SignalsDto | undefined,
): T | (T & Readonly<{ signals: SignalsDto }>) {
  return signals === undefined ? wire : { ...wire, signals }
}
