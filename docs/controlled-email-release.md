# Controlled email-alert release

Baseline: fffa22a03ff2871ee56949016008b7245a7bc023. This is source implementation, not live acceptance.
Status: default off; independent source/DB/hosted gates and designated controlled inbox remain required.

## Scope and safeguards

- Reuses existing alert intake, scoped current-state/lifecycle resolution, atomic claim and bounded backoff.
- Selected active MSP_OWNER only, exact organization/user designation, current email/security opt-in, no digest.
- Exact canonical address must match the privately configured SHA-256 and current Supabase Admin user.
- Auth settings must report mailer_autoconfirm=false; the exact current address needs email_confirmed_at.
- Current settings cannot prove historical confirmation method. Owner-controlled inbox approval is still required.
- One durable logical message per activation, no overlapping replacement activation for an organization.
- Stable explicit cutoff and expiry, at most one hour; new job AND first notification occurrence after cutoff.
- Existing attempted jobs, previously withheld notices and pre-cutoff findings are not replayed.
- Frozen recipient/verification/from/body/random provider key; changing activation metadata is rejected.
- At most three durable reservations, spent before HTTP. Restart cannot reset attempts or the frozen key.
- Network/timeout/5xx ambiguity stays UNKNOWN/open, not a provider refusal or delivered message.
- Provider HTTP errors never create global address suppression.
- Current membership/preferences/lifecycle/verification are reread after claim; suppression is checked per send.
- After reservation, authoritative Auth is checked, then local policy/claim/suppression is the last I/O before handoff. A later external change cannot retroactively unsend mail; every retry revalidates.
- All database acquisition/statements and HTTP share an absolute, monotonic-capped budget. Provider timeout reserves time for fenced settlement; expired work starts no new operation.
- Authenticated webhook event IDs dedupe. Provider-ID lock serializes acceptance and early events.
- Only a matched frozen recipient can be suppressed for hard bounce/complaint. Raw webhook addresses are ignored.
- ACCEPTED means provider handoff; DELIVERED requires a later authenticated provider event.
- SQL tables are private, RLS enabled, public/anon/authenticated access revoked. No raw webhook bodies retained.
- No auth email template/confirmation-setting changes, no customer send, no new paid service/dependency.

## Private configuration prerequisites

Use existing secure server configuration; never paste values into a PR, task, logs or this document.
Required names: HAWKVIEW_ALERT_EMAIL_MODE (controlled only after acceptance authorization),
HAWKVIEW_ALERT_EMAIL_ACTIVATION_ID, HAWKVIEW_ALERT_EMAIL_ORGANIZATION_ID,
HAWKVIEW_ALERT_EMAIL_OWNER_USER_ID, HAWKVIEW_ALERT_EMAIL_RECIPIENT_SHA256,
HAWKVIEW_ALERT_EMAIL_STARTS_AT, HAWKVIEW_ALERT_EMAIL_EXPIRES_AT, HAWKVIEW_ALERT_EMAIL_FROM,
RESEND_API_KEY, RESEND_WEBHOOK_SIGNING_SECRET, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY,
FRONTEND_APP_URL (approved https://console.hawkviewapp.com origin).

Sender/domain permissions, quota, webhook URL and controlled recipient ownership must be checked privately.
Do not change membership, preferences or Auth configuration merely to make the selected inbox qualify.
No provider/configuration actions have been performed by this source change.

## Rollout and rollback

1. Freeze exact source SHA; E1 security review and QA focused mock/disposable PostgreSQL acceptance.
2. Complete required CI/independent acceptance before protected merge.
3. Confirm migration/deployment/configuration readiness without enabling general customer email.
4. Confirm the eligible owner-controlled inbox and a fresh non-overlapping activation window.
5. E2 alone may perform one separately authorized controlled acceptance. No synthetic production findings.
6. Observe durable handoff and signed delivered outcome separately, plus safe provider test-mode failure controls.
7. Rollback by returning HAWKVIEW_ALERT_EMAIL_MODE to disabled. Already handed-off mail cannot be recalled.
8. Do not drain/cancel historical jobs, delete envelopes or rotate idempotency keys to retry an ambiguous send.
9. Re-enable requires a fresh non-overlapping cutoff; prior expired/withheld/history stays excluded.

The existing scheduler invokes email only after collection and with sufficient remaining admission budget.
No independent timer, broad drain, digest, quiet-hours feature or expanded Risky Users regression suite is introduced.
One-message controlled activation is an acceptance safety cap, not a permanent owner-only product policy.

## Acceptance ownership and evidence

A/config and B/recipient: email-release-adapters.test.ts and email-release-regression.test.ts; real SQL authorization is QA-owned.
C/success and D/fresh veto: existing current-state/message-source tests plus QA joined production-path coverage.
E/concurrency and F/crash/retry: QA real two-worker PG controls; unit mocks are not concurrency proof.
G/webhook suppression: existing signature/controller tests plus QA matched/early/replay/suppression DB controls.
H/accounting: preserve accepted versus delivered and open ambiguous attempts; do not promise exactly-once inbox delivery.
I/webhook trust: existing signature-first raw-body controls remain; generic rate-limiting backlog is out of scope.
J/live: blocked until exact candidate and separately confirmed eligible owner-controlled inbox/configuration.
No test counts or live success are claimed in this document.

## External contract checked 2026-09-16

- https://resend.com/docs/dashboard/emails/idempotency-keys: identical request/key retained 24 hours, key <=256 characters; concurrent409 is retryable, changed payload409 is not a reason to rotate the key.
- https://resend.com/docs/api-reference/emails/send-email: POST /emails returns an ID on successful handoff.
- https://resend.com/docs/api-reference/errors and https://resend.com/docs/api-reference/rate-limit: distinguish errors/rate limits, honor Retry-After; a delay beyond our activation means no further send in that window.
- https://resend.com/docs/webhooks/event-types: delivered, bounced and complained are separate provider events.
- https://supabase.com/docs/reference/javascript/auth-admin-getuserbyid and https://github.com/supabase/auth/blob/master/internal/api/settings.go: server-side exact user lookup and current mailer_autoconfirm setting.
