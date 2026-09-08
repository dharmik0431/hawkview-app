# Workspace administrative audit evidence

HawkView records material workspace-administration outcomes in
`workspace_admin_audit_logs`. Version 2 events carry server-generated request
and operation identifiers so one user request and its related stages can be
correlated without storing request bodies or provider payloads.

## Version 2 contract

Every new event contains the organization, actor user ID, action, outcome,
stage, target type, opaque target identifier, request ID, operation ID,
event-version, creation time, and expiration time. A stable error code is
included for failed outcomes. Target user ID is included only when HawkView has
already established that internal identity.

New events do not duplicate actor or target email addresses. Authorized UI
views resolve internal user IDs against the current organization membership.
Legacy rows may still contain email fields until they expire.

The metadata contract is closed. Only these bounded fields may be persisted:

- `changedFields`
- `delivery`
- `factorsRemoved`
- `idempotent`
- `priorRole` and `priorStatus`
- `role` and `status`

Tokens, secrets, authorization headers, passwords, MFA factor identifiers,
confirmation links, request or response bodies, provider payloads, email
content, and Microsoft tenant content are prohibited. Provider failures are
represented only by stable HawkView error codes and bounded provider request
identifiers when a future reviewed integration explicitly allows them.

## Invitation evidence sequence

An invitation writes `WORKSPACE_MEMBER_INVITE_REQUESTED` before calling the
authentication provider. A provider acceptance writes
`WORKSPACE_MEMBER_INVITE_PROVIDER_ACCEPTED`. Membership persistence and
`WORKSPACE_MEMBER_INVITED` commit in the same database transaction. Any caught
failure appends `WORKSPACE_MEMBER_INVITE_FAILED` with the same request and
operation identifiers and a safe error code.

If the initial evidence write fails, HawkView fails closed and does not send an
authentication email. This avoids an external email side effect with no
durable attempt record.

## Retention and access

All rows expire 365 days after creation. The migration backfills every legacy
row to `created_at + 365 days`, including older rows that may contain actor or
target email fields, and then makes `expires_at` non-nullable. The authorized
MSP-owner audit read requires `expires_at` to be in the future and
opportunistically prunes expired rows. If schema drift ever produces an
unexpected NULL, the positive read predicate excludes it fail-closed rather
than treating it as indefinitely readable. The expiry index supports a future
dedicated maintenance job without changing the contract. Changing the
retention period requires an explicit privacy/compliance review and a migration
or versioned configuration change.

Audit reads remain organization-scoped and owner-authorized. The endpoint
currently returns the newest 100 unexpired rows. That bounded view is adequate
for the P0 evidence slice but pagination and a dedicated operational search
surface remain follow-up work.

## Tenant onboarding decisions and report checks

The existing owner-authorized Audit History also includes these app-only
tenant onboarding actions, using the internal customer-tenant ID as an opaque
target. Actor and organization IDs, server-generated request and operation IDs,
stage, status, creation time, and the existing expiration remain available.

| Action | Evidence |
| --- | --- |
| `TENANT_EXCHANGE_SETUP_DEFERRED` | The optional Exchange setup was explicitly deferred. |
| `TENANT_REPORT_VISIBILITY_DEFERRED` | Report visibility setup was explicitly deferred. |
| `TENANT_REPORT_VISIBILITY_CHECKED` | A read-only check returned `READY`, `IDENTIFIERS_CONCEALED`, or an allowlisted failure status. |
| `TENANT_ONBOARDING_COMPLETED` | The existing required and optional-step completion conditions were satisfied and completion was persisted. |

Each local transition and its audit event commit in the same transaction.
Repeated deferral and completion requests preserve the original timestamp and
do not append another successful transition. A later deferral after the prior
deferral has been cleared is a new decision. Each report verification performs
a new read and records a new observation, including unchanged results; it does
not claim that HawkView changed Microsoft's setting or completed onboarding.
`SUCCEEDED` with `IDENTIFIERS_CONCEALED` means the read succeeded, not that
identifiers are visible. Optional steps remain optional and explicitly deferrable.

Report-check metadata contains only an allowlisted status. Expected failures
use bounded `REPORT_VISIBILITY_*` codes; unexpected exceptions use the existing
safe workspace error mapping and `CHECK_FAILED`. No Microsoft tenant ID,
customer name, domain, email, credential, URL, or provider payload is copied
into these events.

If local state or evidence persistence fails, the transaction rolls back and
the request fails. When the audit store remains available, a separate failed
event uses the same correlation IDs and `LOCAL_PERSISTENCE` stage. If the audit
store itself is unavailable, durable failure evidence cannot be guaranteed;
the request still fails rather than reporting success. Unauthorized or
foreign-workspace requests are rejected before tenant or audit writes.

These rows use the existing 365-day workspace audit retention and the existing
newest-100 owner view. This slice adds no new public endpoint, log store,
permission rule, pagination, or product-wide audit guarantee.

## Current boundary

This P0 covers material workspace administrative operations. Tenant sync job
runs, Microsoft consent history, pre-organization authorization failures, and
self-service Supabase login/recovery/MFA events still require the broader
application-audit foundation described in the delivery backlog.
