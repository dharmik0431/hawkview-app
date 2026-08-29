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

Version 2 rows expire 365 days after creation. The authorized MSP-owner audit
read excludes expired rows and opportunistically prunes them. The expiry index
supports a future dedicated maintenance job without changing the contract.
Changing the retention period requires an explicit privacy/compliance review
and a migration or versioned configuration change.

Audit reads remain organization-scoped and owner-authorized. The endpoint
currently returns the newest 100 unexpired rows. That bounded view is adequate
for the P0 evidence slice but pagination and a dedicated operational search
surface remain follow-up work.

## Current boundary

This P0 covers material workspace administrative operations. Tenant sync job
runs, Microsoft consent history, pre-organization authorization failures, and
self-service Supabase login/recovery/MFA events still require the broader
application-audit foundation described in the delivery backlog.
