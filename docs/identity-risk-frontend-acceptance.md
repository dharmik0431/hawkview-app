# Risky Users frontend truthfulness acceptance

Base: `92cb239afebc73fe5a61a28476e49b728ff7d68f` (PR224).

This change is presentation and synthetic tests only. It changes no API, detector,
permissions, flags, dependencies, or lookup authorization. No live tenant data was
used. The server/build gate treats an absent or null value as enabled for backward
compatibility. Explicit `false`, blank, or invalid values disable the UI; a missing
React provider also disables it independently. Operators must use explicit values
instead of assuming that unsetting the variable hides the UI.

## Publication verification

Frontend source and backend verification do not prove that a user-facing build
has been published. The owner must publish from the reviewed source with the
server/build variable `HAWKVIEW_IDENTITY_RISK_UI_ENABLED=true`. Do not rename it
to `NEXT_PUBLIC_*` or treat `.env.example` as deployed configuration.

Publication is complete only after the exact build is recorded privately and an authorized
user verifies the two separate cards and the states available, partial, stale,
unavailable, not evaluated, and evaluated empty. Do not expose operator, Swagger,
admin, or debug routes as part of this user verification.

## Acceptance behavior

- HawkView and Microsoft remain independent. A missing, unlicensed, or failed
  Microsoft response cannot erase a supported HawkView finding.
- Available evidence is blue/neutral, not green. Partial and stale states retain
  their warning even when the reported limitation is only a shadow-mode notice.
- Disabled, not-evaluated, load-error, missing, partial, and stale evidence do not
  render a confirmed empty result. The exact server limitation remains visible;
  the frontend does not infer why a gate is disabled.
- An evaluated-empty HawkView statement requires current/full metadata, a complete
  page, positive not-matched outcomes, reported rule coverage, and exact zero
  matched, suppressed, not-evaluated, open-finding and affected-identity counts.
  Even then, the statement is limited to evaluated evidence, never a safe verdict.
- The UI calls `counts.evaluatedRules` “Rules with reported outcomes”: the backend
  actually counts coverage records, including not-evaluated-only rules.
- The implemented scope is configured enabled mailbox forwarding outside the
  exact normalized Microsoft Graph verified-domain set. It is not authoritative
  Exchange accepted/InternalRelay transport-domain coverage. Findings do not
  prove compromise, delivery, or exfiltration. Broader behavioral detection and
  scoring remain incomplete.
- Source labels and reported timestamps remain visible. Approved evidence and
  benign-alternative codes are translated into plain language. Lists remain
  pseudonymous; affected mailbox identity still requires the existing explicit,
  current, server-authorized lookup, scoped to MSP session and tenant.

## Backend contract gaps (not implemented here)

References below are in the unchanged backend at the base above.

1. `backend/src/identity-risk/identity-risk.contract.ts:152` defines the envelope
   with aggregate capability/status, limitation, evaluated/observed timestamps;
   it has no typed disabled/readiness reason. The collapsed pilot gate returns
   “not enabled” at `identity-risk.service.ts:391`. Distinguishing tenant opt-out
   from other gate causes requires an explicit server-owned safe reason contract.
2. The envelope above and finding DTO at `identity-risk.contract.ts:177` do not
   expose per-source observed timestamps/coverage, per-rule omitted-check reasons,
   coverage denominators, or a completed-detector inventory. Richer coverage
   display needs those backend-authored facts. The channel observation can fall
   back to evaluation time at `identity-risk.service.ts:221`; the frontend cannot
   reconstruct independent source freshness from that value.
3. `identity-risk.service.ts:425` reads coverage records and
   `identity-risk.service.ts:516` sets `evaluatedRules` to `coverage.length`.
   A count of actually executed rules requires a separately defined backend
   aggregate; this change only makes the existing count's UI label truthful.
4. Microsoft absence and stale branches at `identity-risk.service.ts:869` and
   `identity-risk.service.ts:903` return generic unavailable envelopes. They do
   not identify license versus permission causes, and stale responses discard
   timestamps. Detailed diagnosis or last-observed evidence requires an explicit
   server DTO; the frontend displays only the returned limitation and null dates.

## Validation

- Focused: `node --experimental-strip-types --test lib/identity-risk/*.test.ts lib/api/mailbox-investigation*.test.ts` — 43 passed.
- All frontend tests: PowerShell `$riskTests = @(rg --files lib components -g '*.test.ts' -g '*.test.mjs'); node --experimental-strip-types --test @riskTests` — 301 passed.
- `npm run typecheck` and `npm run lint` — passed, no lint warnings/errors.
- `npm run build` — passed; only existing Browserslist-age and webpack cache
  snapshot warnings. No dependency updates were made.
- `npm run test:root-routes` — 2 passed against the local standalone build.
- The new render tests execute the real section, hooks, strict adapter and
  presentation helpers with fixed-time synthetic DTOs; network/auth are mocked.
  Existing mailbox DOM tests separately exercise explicit click, result/hide,
  failure/unavailable, and abort-on-unmount behavior.
