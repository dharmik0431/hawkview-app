# The encrypted secret store: key rotation, and what is deliberately refused

## What was wrong

**Rotating `SECRET_ENCRYPTION_KEY` destroyed every stored secret, permanently.**

The key was read straight from the environment and used for every seal and every
open. Nothing recorded which key had sealed which row. So changing the variable
left every row sealed with a key the service no longer had — and the failure was
indirect: the AES-GCM authentication tag failed, and the service reported

> The stored credential could not be decrypted.

which is the *same* message a genuinely corrupt row produces. You could not tell
a rotation mistake from data loss, and there was nothing to roll back to.

Two rows exist, and both matter more than their number suggests:

```
encrypted_secrets                        2 rows
  hawkview-microsoft-connector-client-secret   reads all five customer tenants
  hawkview-microsoft-consent-state-secret      signs consent-state tokens
tenant_connections holding a credential  0
```

If either is ever exposed, the correct response is to rotate — which was
precisely the operation that destroyed them.

## What is here now

`encrypted_secrets.key_version` records which key sealed each row, and the
service can hold two keys at once so a rotation has a window.

| Variable | Meaning |
|---|---|
| `SECRET_ENCRYPTION_KEY` | The current key. Required. |
| `SECRET_ENCRYPTION_KEY_VERSION` | Which version that key is. Unset means 1. |
| `SECRET_ENCRYPTION_KEY_PREVIOUS` | The key for version *current − 1*. Optional. |

A row is opened with the key matching its own `key_version`. When that is behind
the current version, the row is **re-sealed with the current key as it is read**,
so a rotation completes through ordinary traffic rather than a batch job.

Three properties are worth knowing because they are what make this safe:

- **A re-seal can never fail a read.** The caller already holds the plaintext by
  the time the re-seal runs. A write failure is logged as `secret_reseal_deferred`
  and retried on the next read; it never turns a successful decryption into an
  error. Adding rotation must not add a new way for collection to stop.
- **"I do not hold that key" is a different answer from "this did not decrypt".**
  A row sealed with an unavailable version returns code
  `SECRET_SEALED_WITH_UNAVAILABLE_KEY_VERSION` and says the ciphertext is intact.
  That distinction is the difference between an operator restoring a variable and
  an operator hunting for a backup.
- **The column has no default.** The migration adds it with `DEFAULT 1` to label
  the rows that already exist, then drops the default. A future writer that
  forgets the version now violates `NOT NULL` and fails loudly, instead of
  producing a row *labelled* version 1 whose bytes were sealed with version 2 —
  a mislabelled row is exactly as unreadable as an unlabelled one, and is found
  much later.

## Rotating the key

`SecretStoreService.rotationStatus()` is the instrument. It **opens every secret**
rather than reading its version column, because the version is a claim and the
claim is what you are verifying. It returns names, versions and whether each one
opened — never plaintext, never ciphertext.

1. **Before touching anything**, confirm the current state is sound:
   `rotationStatus()` should report `unreadable: 0`.
2. Set `SECRET_ENCRYPTION_KEY_PREVIOUS` to the **current** key. Set
   `SECRET_ENCRYPTION_KEY` to the new key. Set `SECRET_ENCRYPTION_KEY_VERSION` to
   one more than it was (unset counts as 1, so the first rotation sets `2`).
   Restart.
3. Check `rotationStatus()`: `unreadable` must be `0`. If it is not, **put the old
   key back in `SECRET_ENCRYPTION_KEY` and restart** — nothing has been lost.
4. Let traffic re-seal the rows, or force it by reading each secret. Watch
   `resealPending` fall to `0` and `complete` become `true`.
5. Only once `complete` is `true`, remove `SECRET_ENCRYPTION_KEY_PREVIOUS` and
   restart. The rotation is finished.

Do not skip step 5's precondition. While `resealPending` is above zero, the
previous key is still load-bearing.

**Apply the migration before rotating for the first time.** It labels existing
rows as version 1, which is only true while they are still sealed with the
original key.

## What to check first if a credential stops working

The symptom is a Microsoft call failing, or a tenant's connection reporting an
error, after a configuration change.

**1. Read the error code, not the message.**

- `SECRET_SEALED_WITH_UNAVAILABLE_KEY_VERSION` — the row is fine and this service
  does not hold its key. Someone rotated without setting
  `SECRET_ENCRYPTION_KEY_PREVIOUS`, or removed it too early. Put the previous key
  back and restart. **Nothing is lost, and no backup is needed.**
- `The stored credential could not be decrypted` — the key for that version *is*
  present and did not work. That is a wrong key value or a damaged row, and it is
  the serious case.
- `SECRET_TENANT_SCOPE_UNSUPPORTED` — not a rotation problem. See below.

**2. Run `rotationStatus()`.** `unreadable` names exactly which secrets are
affected, and `currentVersion` against each row's `keyVersion` says what the
service is looking for versus what the row was sealed with.

**3. If it is not the secret store**, the likelier causes are the credential
itself expiring (`platform_microsoft_connectors.credential_expires_at`) or the
Microsoft application's permissions changing. Those fail at the Graph call, not at
decryption, and the error will say so.

## The tenant-scoping refusal

**`encrypted_secrets` has no organization or tenant column, and
`SecretStoreService.access()` performs no scope check.** A reference is enough to
read a secret.

That is a real gap in the shape of the cross-tenant exposure guarded against
everywhere else in this codebase, and it is harmless today only because of a fact
written down nowhere in the code: **no tenant owns a stored secret.** Both rows
are HawkView's own, and all five customer tenants are `HAWKVIEW_MANAGED`.

A latent gap is the dangerous kind, so the deprioritisation is written into the
type system rather than into a ticket. Every write states an owner, and tenant
ownership is declared and unimplemented:

```ts
store(secretId, value, PLATFORM_OWNED)                       // works
store(secretId, value, { kind: 'TENANT', organizationId, customerTenantId })
                                                             // refuses, loudly
```

**This deliberately stops a working code path.**
`prepareCustomerManagedConnection` — the `CUSTOMER_MANAGED` onboarding route —
now fails with `SECRET_TENANT_SCOPE_UNSUPPORTED`. That costs nothing today: no
tenant uses it and no test exercises it. It is the only arrangement in which the
next person *meets* the problem instead of shipping past it.

### Lifting it

Delete the check only as the last step of implementing the scope, not as a way
around it:

1. Add `organization_id` and `customer_tenant_id` to `encrypted_secrets`,
   nullable, since the two platform rows have no tenant.
2. Give `access()` the caller's authorized scope and refuse a row whose tenant
   does not match — the same shape as every other tenant-scoped read here.
3. **Fix the write ordering.** On the onboarding path that *creates* a tenant, the
   credential is stored before the `customer_tenants` row exists, so at the moment
   of writing there is no tenant id to scope it by. That is why `customerTenantId`
   is nullable on the owner type. Create the tenant first, or store the secret
   inside the same transaction.
4. Then, and only then, let `assertStorable` accept `TENANT`.

## What is not covered

- **No scope check on `access()` for platform secrets.** Any caller inside the API
  with a reference can read them. That is the same trust boundary as before this
  change; narrowing it is the work described above.
- **No automatic re-seal for untouched rows.** A secret nothing reads stays on its
  old key indefinitely and keeps the previous key necessary. With two rows that is
  easily handled by reading them; it would need a sweep if the table grew.
- **`rotationStatus()` is not exposed over HTTP.** It is a service method. Adding a
  route means deciding who may call it, which is a separate decision from making
  rotation possible.
