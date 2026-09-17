# Scoped regular alert email

This extends the existing controlled release with sustained admission for exactly one configured
organization and designated owner. It does not enable every account, add recipient fanout, or
change the approved compact content, source provenance, detectors, transport, or signed webhooks.

## Consent is separate from sender availability

Email remains OFF by default for every user. Missing, null, unknown, or false preference values
do not grant consent. Only that user's existing explicit email opt-in, security opt-in, immediate
delivery preference, active owner membership, current confirmed Auth identity, and matching
configured recipient hash can qualify. This migration, startup, and activation never write
preferences. Preserve existing intentional opt-ins; do not bulk-enable or reset accounts.

## Configuration

The existing controlled configuration and its one-message, maximum-one-hour semantics remain.
Regular mode explicitly uses HAWKVIEW_ALERT_EMAIL_MODE=regular and the existing activation,
organization, owner, recipient-hash, from-address, console-origin, Auth and provider configuration.
HAWKVIEW_ALERT_EMAIL_STARTS_AT is an immutable declared prospective cutoff.
HAWKVIEW_ALERT_EMAIL_EXPIRES_AT must be absent or empty in regular mode: regular authorization
has no rolling global expiry. It is not a succession of controlled trials.
Secrets and scope values belong only in secure server configuration.

A private immutable regular epoch is persisted before first eligibility. Its effective cutoff is
the later of the declared cutoff and first registration's database time, so a first configuration
cannot adopt an earlier queue. The epoch binds organization, owner, recipient hash, sender, origin,
and declared/effective cutoff. Reusing an ID with different metadata fails closed.
Only one epoch can be active per organization. Another ID cannot replace an active epoch.

## Prospective admission and throughput

Each scheduler pass may claim at most one message. Under canonical activation-ID then organization
advisory locks, the worker checks existing durable unexpired organization job leases before claiming
a distinct job. This protects the period after the admission transaction commits.

New jobs must have no existing envelope and no previous attempt, and must be created after the
effective cutoff. Original notification first occurrence and creation, plus job creation, must
also satisfy the current eligible-since boundary: the greatest of epoch cutoff, designated
owner preference updated_at, and persisted policy updated_at when present.
First occurrence and job creation must be no more than one hour old on first admission.
There is no intake rewind or drain of old, terminal, withheld, pre-cutoff, or other-epoch work.

The preference/policy boundary is deliberately conservative: ANY preference or policy save,
including unrelated settings or a same-value save, can exclude older queued work. It does not
pretend to be an email-specific consent history. The same current timestamp boundary is repeated
before retry reservation and in the final local handoff gate. Turning OFF then ON cannot make
older queued work eligible merely because the current boolean is true.

Limits are rolling database-clock hours, per organization, across activation IDs:
- At most six new logical message envelopes.
- At most twelve durable attempt reservations, including controlled activity and all outcomes.
- At most three reservations per message, including crashes or ambiguous provider outcomes.

Admission and reservation checks are atomic under the organization lock. Quota deferral is recorded
as REGULAR_RATE_LIMITED on the job, not as delivery or provider failure. Stale/ineligible work is
withdrawn with a durable email stop code. Limits do not reset on deployment or activation rotation.

## Frozen message lifetime and outcomes

Each regular envelope stores its own original start and expiry, at most one hour apart.
The deadline never extends on retries, restart, configuration reload, or epoch rotation.
This remains well below the provider's documented 24-hour idempotency-key retention.
Message identity, recipient, payload, sender, random provider key and provider ID remain immutable.
Durable message identity survives expiry; never delete an envelope or rotate a key to retry.

Every handoff retains authoritative Auth verification, exact canonical organization/tenant scope,
current owner membership and address, preferences, severity/policy, incident lifecycle, suppression,
lease fencing, deadline and final configuration checks.
ACCEPTED is provider handoff, not delivered. UNKNOWN remains unresolved with the same identity.
Only a matched authenticated delivered event establishes receiving-mailserver delivery.
Inbox placement or reading is not asserted.

## OFF and re-enable

Set mode to disabled while retaining the validated activation, organization and owner identifiers.
On the scheduled runtime configuration read, the application durably closes that exact regular
epoch and reports DISABLED_EPOCH_CLOSED with zero attempted sends. Wait for this evidence before
any new activation. A missing or malformed retained identity is OFF but is NOT closure proof.
A closed epoch cannot reopen, including under the same activation ID.

Re-enable requires a new activation ID and fresh declared cutoff no earlier than the previous
durable closure. Owner, recipient, or sender changes follow this same OFF/close/new-epoch procedure.
Old pending or ambiguous envelopes remain audit records and are never rebound or adopted.
Do not cancel/drain historical jobs, reset preferences, or remove suppression to get a passing test.

OFF takes effect when the runtime configuration is applied/read and the epoch closes; it is not
instantaneous cross-process recall. A concurrent external change after the final local check cannot
unsend an already handed-off message. Apply OFF before rolling back application code; do not drop
the additive audit schema or immutable envelope history during operational rollback.

## Capability compatibility

The v1 availability vocabulary remains unchanged. Older clients cannot represent sustained mode
and see a conservative unavailable legacy representation, not evidence of a broken backend.
An additive regular capability reports AVAILABLE only for the designated owner/organization and
always requiresOptIn=true. New clients explain this as availability, not personal consent or
guaranteed delivery. Other accounts are not enabled. No unrelated preference UI is required.

## Release and real acceptance

Before production activation: independent source review, regular and controlled tests, real
PostgreSQL concurrency/rate/restart/consent checks, exact-head hosted CI, normal protected merge,
and exact deployed-revision/health evidence must pass. Privately verify configured scope, current
explicit owner consent/Auth, provider/domain/key permissions, signed webhook readiness, suppression,
and a prospective queue baseline. Never expose secret values or customer payloads in handoffs.

After activation use the existing scheduled production application path only. Observe the durable
epoch and redacted regular-mode admission status. A natural eligible new incident must produce its
durable frozen envelope/reservation, provider acceptance ID, and matched signed delivery outcome
before claiming application delivery. If no qualifying new incident occurs, report enabled/awaiting
a qualifying event. Do not manufacture incidents or replay existing jobs. Prior standalone provider
tests are not application proof and are not to be repeated.


## Required database-session timezone

The production PrismaPg timestamptz decoder can lose non-UTC session offsets. Node TZ=UTC alone is not a database-session guarantee. Every emailSqlRunner transaction explicitly executes SET LOCAL TIME ZONE 'UTC' before product SQL, then rechecks its original shared deadline. Initialization failure aborts the transaction before eligibility, reservation or provider authorization; no cutoff, freshness or retry horizon is extended. SET LOCAL applies only to that transaction and does not change the database role or other pooled sessions.

For the disposable PostgreSQL suite, set both TZ=UTC and PGOPTIONS='-c timezone=UTC' for fixture creation and direct Prisma assertions outside the delivery runner. Also execute the dedicated non-UTC session regression: the production email runner must report UTC and preserve a known timestamptz instant despite a non-UTC outer connection, then restore the prior session setting on transaction completion. A different connector's timezone is not evidence of the application's connection.

Before activation, require the reviewed UTC-initializing runner on the exact deployed release and application-connection/session evidence for that guarantee. Do not treat a successful migration, an environment variable alone, or another SQL connector as runtime proof. Keep email OFF if this gate is unproven.


## Shared application connection initialization

PrismaService also supplies the installed pg-pool awaited onConnect configuration hook. Before a newly connected client can be acquired by application code, the hook sets that session to UTC and reads back TimeZone using constant SQL and a shared five-second query timeout budget. A failure, timeout or unexpected readback raises a safe error; the pool discards the client. This is not an async EventEmitter listener and does not race application queries.

This protects Prisma ORM consent/policy timestamp writes as well as raw timestamp readers on supported direct or session-pool connections. The existing connection string, TLS settings and unrelated connection options remain unchanged. No database-role/global setting, external environment or dependency is changed. The email transaction-local UTC guard remains defense in depth. Tests must prove real preference/policy ORM epoch chronology with both positive and negative non-UTC connection defaults, and multiple/recreated pool clients, not merely UTC-wrapped fixtures.

A connect-time session hook alone is not a guarantee for an external transaction-mode pooler that changes server sessions between transactions. Before activation, establish the actual application's connection mode through sanitized trusted configuration and verify the supported session guarantee. If that mode or guarantee is unknown, keep email OFF; do not change endpoints or claim transaction-pooler support without a separately reviewed solution.
