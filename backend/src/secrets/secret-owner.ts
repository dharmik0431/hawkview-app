import { ServiceUnavailableException } from '@nestjs/common'

/** Who a stored secret belongs to, stated by the caller rather than inferred.
 *
 * WHY THIS EXISTS, AND WHY IT REFUSES SOMETHING.
 *
 * `encrypted_secrets` has no organization or tenant column, and `access()` takes
 * a reference and returns the plaintext with no scope check of any kind. That is
 * a real gap in the shape of the cross-tenant exposure this codebase guards
 * against everywhere else — and it is, today, harmless, because of a fact that is
 * nowhere written down in the code: **no tenant owns a stored secret.** Both rows
 * in the table are HawkView's own, and all five customer tenants are
 * `HAWKVIEW_MANAGED`.
 *
 * That makes the gap LATENT, which is the dangerous kind. It becomes live the
 * first time a `CUSTOMER_MANAGED` tenant is onboarded — one credential per
 * customer, stored in a table with nothing to scope them by and read through a
 * method that checks nothing. Nobody would be making a mistake at that moment.
 * They would be using a feature that already exists, and inheriting a gap that
 * was deprioritised on the strength of a measurement taken months earlier.
 *
 * So the deprioritisation is written into the type system instead of into a
 * ticket. Every caller must say who the secret belongs to; tenant ownership is
 * declared and unimplemented, so the first attempt to store one stops with an
 * explanation rather than succeeding quietly. A new caller cannot reach the gap
 * without first being told it is there.
 *
 * THIS IS A DELIBERATE REFUSAL OF A WORKING CODE PATH.
 * `prepareCustomerManagedConnection` will now fail. That costs nothing today — no
 * test exercises it, and no tenant uses it — and it is the only arrangement where
 * the next person meets the problem instead of shipping past it. Lifting it means
 * implementing the scope, not deleting the check; `docs/secret-store.md` says
 * what that involves.
 */

export type SecretOwner =
  | Readonly<{ kind: 'PLATFORM' }>
  /** Not yet storable. The fields are named here so that implementing the scope
   * is a matter of adding columns and a check, not of redesigning the call.
   *
   * `customerTenantId` is nullable, and the null case is a finding rather than a
   * convenience: on the onboarding path that creates a tenant, the credential is
   * stored BEFORE the `customer_tenants` row exists, so at the moment of writing
   * there is no tenant id to scope it by. Implementing the scope therefore also
   * means changing that order — create the tenant first, or store the secret
   * inside the same transaction — and not only adding columns. */
  | Readonly<{ kind: 'TENANT'; organizationId: string; customerTenantId: string | null }>

/** HawkView's own secrets: the Microsoft client secret that reads every customer
 * tenant, and the key that signs consent-state tokens. Neither belongs to a
 * customer, and neither needs a scope to be safe. */
export const PLATFORM_OWNED: SecretOwner = Object.freeze({ kind: 'PLATFORM' })

export const TENANT_SCOPE_UNSUPPORTED = 'SECRET_TENANT_SCOPE_UNSUPPORTED'

export class TenantScopedSecretUnsupportedError extends ServiceUnavailableException {
  constructor(readonly customerTenantId: string | null) {
    super({
      statusCode: 503,
      code: TENANT_SCOPE_UNSUPPORTED,
      message:
        'Storing a credential that belongs to one customer tenant is not supported yet. ' +
        'encrypted_secrets has no organization or tenant column and SecretStoreService.access() ' +
        'performs no scope check, so a per-tenant credential stored today would be readable ' +
        'through any reference with no tenant boundary. This refusal is deliberate and is ' +
        'described in docs/secret-store.md.',
    })
  }
}

/** Refuses what cannot yet be stored safely. Called on every write path, so a new
 * caller meets it rather than discovering the gap later. */
export function assertStorable(owner: SecretOwner): void {
  if (owner.kind === 'TENANT') {
    throw new TenantScopedSecretUnsupportedError(owner.customerTenantId)
  }
}
