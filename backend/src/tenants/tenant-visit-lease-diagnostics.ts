import { TenantVisitLeaseLostError, tenantVisitLeaseLoss } from './tenant-visit-lease-error.js'

/**
 * Bounded diagnosis for a recognized tenant-visit ownership loss.
 *
 * `scheduled_tenant_sync_failure` carries one undifferentiated
 * `TENANT_VISIT_LEASE_LOST` code, and the lifecycle's renewal rejection
 * handler takes no parameter, so the rejection reason is discarded at the
 * source. The branch that produced the loss therefore cannot be identified
 * from the event at all. This records that branch, and nothing more: a pair
 * names where the loss was constructed, never why the underlying store
 * behaved as it did.
 *
 * Diagnosis only. It changes no check, lock, timer, retry delay, quota,
 * cadence, flag, response, visit duration, renewal interval, transport budget
 * or API aggregate, and it never carries an error, cause, stack, SQL, owner
 * token, generation, provider or customer value -- only one pair drawn from
 * the closed table below.
 *
 * The pair lives in a module-private WeakMap keyed by the error INSTANCE, not
 * on the error, so a caller cannot forge or leak one by assigning properties;
 * stored values are frozen; and the emission-time reader revalidates and falls
 * back to `unspecified` instead of throwing.
 */
export type TenantVisitLeaseLossDiagnostic = {
  readonly phase: string
  readonly reason: string
}

/**
 * The closed set of pairs. Expressed as a tuple union so an unlisted pairing
 * is a compile error at the branch, and re-checked at emission so a mutated or
 * hostile value is still refused at runtime.
 *
 *   - `admission`    the acquired lease did not match the requested scope.
 *   - `local_guard`  a local guard refused further owned work; no store call
 *                    was made, so ownership may well still be held.
 *   - `renewal`      a renewal refusal. `no_matching_owner` means the renewal
 *                    matched no row for this exact owner, which is NOT proof
 *                    of replacement or expiry: a missing or invisible scope or
 *                    lease row produces the same result. `store_rejected`
 *                    means the store renewal rejected for an unspecified
 *                    reason -- any transaction failure, not necessarily a
 *                    timeout, and not evidence that ownership moved.
 *   - `release`      cleanup, after owned work already finished, with the same
 *                    two neutral meanings as above.
 *   - `unspecified`  recognized by identity but produced outside a labelled
 *                    branch, including every pre-existing collector site.
 */
export type TenantVisitLeaseLossPair =
  | readonly ['admission', 'scope_mismatch']
  | readonly ['local_guard', 'context_closed' | 'deadline_elapsed' | 'owner_mismatch']
  | readonly ['renewal',
    'deadline_elapsed' | 'no_matching_owner' | 'owner_mismatch' | 'response_late' | 'store_rejected']
  | readonly ['release', 'no_matching_owner' | 'store_rejected']
  | readonly ['unspecified', 'unspecified']

/**
 * The same closed table at runtime, deliberately NOT exported. `ReadonlyMap`
 * and `ReadonlySet` are compile-time only: an importer could still call
 * `.set` or `.add` and widen the allowlist, and `Object.freeze` does not
 * protect Map or Set internals. Keeping it module-private is part of the
 * bounded-redaction contract, so tests assert their own literal expectations
 * instead of importing this validation state.
 *
 * A Map, not an object, so `get` on `__proto__` or `constructor` is a miss.
 */
const ALLOWED: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ['admission', new Set(['scope_mismatch'])],
  ['local_guard', new Set(['context_closed', 'deadline_elapsed', 'owner_mismatch'])],
  ['renewal', new Set([
    'deadline_elapsed', 'no_matching_owner', 'owner_mismatch', 'response_late', 'store_rejected',
  ])],
  ['release', new Set(['no_matching_owner', 'store_rejected'])],
  ['unspecified', new Set(['unspecified'])],
])

const UNSPECIFIED: TenantVisitLeaseLossDiagnostic =
  Object.freeze({ phase: 'unspecified', reason: 'unspecified' })

const recorded = new WeakMap<TenantVisitLeaseLostError, TenantVisitLeaseLossDiagnostic>()

/** Construct a lease-loss error labelled with its originating branch. */
export function tenantVisitLeaseLossAt(
  ...[phase, reason]: TenantVisitLeaseLossPair
): TenantVisitLeaseLostError {
  const error = new TenantVisitLeaseLostError()
  recorded.set(error, Object.freeze({ phase, reason }))
  return error
}

/**
 * Carry the FIRST recognized loss's pair onto the instance that is actually
 * thrown, so cleanup or a late renewal cannot relabel an earlier cause.
 *
 * It returns the same `thrown` instance: the outward error identity, class and
 * message must not change to achieve a better label. An earlier loss with no
 * recorded pair yields `unspecified`, which is honest -- the earlier cause is
 * known to be an ownership loss, but its branch is not labelled.
 */
export function carryTenantVisitLeaseLossPair(
  thrown: TenantVisitLeaseLostError,
  first: TenantVisitLeaseLostError | undefined,
): TenantVisitLeaseLostError {
  if (first === undefined || first === thrown) return thrown
  recorded.set(thrown, recorded.get(first) ?? UNSPECIFIED)
  return thrown
}

/**
 * The existing classifier with its `.cause` read guarded, for DIAGNOSTIC use
 * only. The classifier reads `.cause`, which on a hostile value can be an
 * accessor that throws; a diagnostic read must never add a throw of its own,
 * and must never change which error a caller rethrows. Recognition itself is
 * unchanged and deliberately NOT widened: this returns exactly what
 * `tenantVisitLeaseLoss` returns, or null where that read would throw.
 */
export function recognizedTenantVisitLeaseLoss(error: unknown): TenantVisitLeaseLostError | null {
  try { return tenantVisitLeaseLoss(error) } catch { return null }
}

/**
 * Resolve a bounded pair for logging. Uses the EXISTING identity and
 * single-cause predicate without widening it, revalidates the recorded pair
 * against the closed table, and returns a fresh two-key frozen literal so a
 * mutated stored value cannot add keys.
 *
 * This helper itself does not throw: it resolves through
 * `recognizedTenantVisitLeaseLoss`. The scheduled classification is untouched
 * and keeps its existing behaviour, including its own pre-existing
 * `tenantVisitLeaseLoss` read.
 */
export function tenantVisitLeaseLossDiagnostic(error: unknown): TenantVisitLeaseLossDiagnostic {
  const lost = recognizedTenantVisitLeaseLoss(error)
  if (!lost) return UNSPECIFIED
  const pair = recorded.get(lost)
  if (!pair || typeof pair.phase !== 'string' || typeof pair.reason !== 'string') return UNSPECIFIED
  if (!ALLOWED.get(pair.phase)?.has(pair.reason)) return UNSPECIFIED
  return Object.freeze({ phase: pair.phase, reason: pair.reason })
}
