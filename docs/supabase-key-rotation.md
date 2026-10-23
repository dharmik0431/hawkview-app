# Supabase key rotation — runbook

Status: **plan only. Nothing in this document has been executed.** No key was
rotated, disabled or created; no environment variable was changed; nothing was
deployed. Every command below is written down rather than run.

Companion to [`public-schema-lockdown.md`](public-schema-lockdown.md), which
closed the PostgREST hole these keys unlocked. Rotation is the second half:
lockdown stops future access, rotation invalidates the credentials themselves.

## The short version

The expensive part is smaller than it looks, and the cheap part is available
immediately:

- **The legacy `anon` JWT is shipped nowhere.** Not in the browser bundle, not
  in the repo, not in Render, not in CI. It is an orphaned credential that is
  still live. It can be disabled with **no redeploy and no coordination**.
- **Only the `sb_publishable_` key is actually shipped**, and it is baked into
  the JavaScript at build time. Rotating it **requires a frontend rebuild and
  redeploy** — there is no way around that.
- Three of the places the keys were assumed to live **do not contain one**. See
  [Corrections](#corrections-to-the-assumed-scope).

## 1. Inventory

Verified against `origin/main` at `f78c9e0` and against the live deployment.

### Shipped to the browser (build-time baked)

| Where | What | Rotation impact |
|---|---|---|
| Google App Engine config for `console.hawkviewapp.com` | `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`, `NEXT_PUBLIC_SUPABASE_URL` | **Rebuild + redeploy required** |
| `/_next/static/chunks/1857-*.js` (live bundle) | the literal key, inlined | Replaced only by a new build |
| `lib/auth/supabase.ts:10` | reads `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | Consumer |
| `lib/config/public-runtime-config.ts:128` | reads `NEXT_PUBLIC_SUPABASE_URL` | Consumer |

`NEXT_PUBLIC_*` is inlined by Next.js at build time, not read at runtime. This
was confirmed rather than assumed — the current key appears as a string literal
in the served chunk:

```
let a=null!==(r="sb_publishable_4iffhmrt0m7thFwkAN4JeA_l8rSoQGv".trim())
```

So a new key does not take effect until the frontend is rebuilt and redeployed.
Changing the App Engine environment variable alone changes nothing.

### Server-side (runtime-read, unaffected by this rotation)

| Where | What | Note |
|---|---|---|
| Render `hawkview-api-dev` | `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` (`sync: false`) | Runtime `process.env`. A restart picks up a change; no rebuild. |
| `backend/src/workspace/workspace.service.ts:564-565` | service-role key for invite/admin calls | `/auth/v1` only |
| `backend/src/canary/authenticated-canary.service.ts:115` | service-role key for the canary sign-in | `/auth/v1` only |
| `backend/src/auth/identity-token-verifier.service.ts:68` | `SUPABASE_URL` as JWKS issuer | No key |

These are a **different credential** from the browser keys. Rotating the
publishable key does not touch them, and vice versa. Rotating the service-role
key is a separate exercise with its own blast radius (invites, MFA reset, the
canary) and is deliberately out of scope here.

### Placeholders — no action

| Where | Value |
|---|---|
| `.env.example:14` | `sb_publishable_replace_me` |
| `backend/.env.example:7` | `REPLACE_WITH_SERVER_ONLY_SERVICE_ROLE_KEY` |
| `.github/workflows/quality-gates.yml:21` | `sb_publishable_ci_validation_only_0123456789` |

The CI value is a syntactic placeholder that satisfies the
`sb_publishable_`-prefix check during `next build`. It is not a real key and
does not need rotating.

### Corrections to the assumed scope

Three places expected to hold a key do not:

1. **`hawkview-sync-dev` (Render cron) has no Supabase key at all.** Its only
   environment variable is `SCHEDULER_SHARED_SECRET` (`render.yaml:87-89`). It
   triggers the API over HTTP and never talks to Supabase. Not in scope.
2. **Neither `authenticated-canary.yml` nor `deployment-smoke.yml` holds a
   Supabase key.** Both pass only `EXPECTED_REVISION`; the canary authenticates
   via GitHub OIDC against the deployed API, which holds the service-role key
   server-side. Not in scope.
3. **The App Engine config is not in this repository.** There is no `app.yaml`,
   `cloudbuild.yaml` or equivalent anywhere in the tree; `render.yaml` defines
   only the two backend services. `console.hawkviewapp.com` is confirmed to be
   App Engine (`server: Google Frontend`, `x-cloud-trace-context`), but whatever
   supplies `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` to that build lives outside
   version control. **Locating it is a prerequisite for step 3 below, and it is
   the one input this runbook cannot supply.**

## 2. Which keys actually need rotating

Two separate credentials are live on this project.

### The `sb_publishable_` key — rotate

`sb_publishable_4iffhmrt0m7thFwkAN4JeA_l8rSoQGv`. This is what the console
ships and what was usable against `/rest/v1` before the lockdown. It has been
public for the life of the project by design — publishable keys are *meant* to
be public, which is exactly why the grants and RLS were the real defect. It
should still be rotated, because it was a working credential against an open
database for an extended period.

New-style API keys can coexist, so this rotates without downtime.

### The legacy `anon` JWT — disable rather than reissue

`eyJhbGciOiJIUzI1NiIs...` with `"role":"anon"`, `iat` 2026-08-04, `exp` 2036.

This is the finding worth acting on first. It is **not used anywhere**:

- Not in the browser bundle. Searched every chunk served on `/login` for the JWT
  header prefix — absent.
- Not in the repo. No occurrence in any tracked file.
- It *cannot* be used by the frontend even if it were supplied.
  `isBrowserSafeSupabasePublishableKey` (`lib/config/public-runtime-config.ts:75-86`)
  requires an `sb_publishable_` prefix, so a JWT-shaped value fails the check,
  `isSupabaseConfigured` is false, and the client is `null`.

Yet it was fully functional against `/rest/v1` before the lockdown — verified.
So it is a live, long-lived, unused credential. **Disable it; do not reissue
it.** There is no consumer to migrate and no redeploy to coordinate.

One caution to confirm in the dashboard before acting. Disabling a legacy key is
not the same operation as rotating the project's **JWT secret**. The JWT secret
also signs end-user session tokens, so rotating *that* would sign out all 9
accounts. This runbook calls for disabling the legacy `anon` key only. If the
dashboard presents the choice as "rotate JWT secret", stop — that is a different
action with a different blast radius, and it is not what step 1 asks for.

Which controls the dashboard actually offers could not be verified, because
checking would mean operating on live keys. Confirm before clicking.

## 3. Ordered sequence

Step 1 is independent of the rest and can be done alone.

### Step 1 — Disable the legacy `anon` JWT (no redeploy)

Nothing consumes it, so there is no coordination.

- **Verify first** that it is inert post-lockdown:
  ```bash
  curl -s -o /dev/null -w '%{http_code}\n' -H "apikey: $LEGACY_ANON" -H "Authorization: Bearer $LEGACY_ANON" "https://lvjqyvrtlkmhseelofda.supabase.co/rest/v1/users?select=*&limit=1"
  ```
  Expect `401`. It already returns `401` after the lockdown.
- **Then disable it** in the Supabase dashboard.
- **Verify after:** the same call still returns `401`, and a sign-in at
  `console.hawkviewapp.com/login` still succeeds.
- **Failure looks like:** any sign-in failure, or the API canary going red.
  Either would mean a consumer this inventory missed.
- **Rollback:** re-enable the legacy key in the dashboard. Immediate, no deploy.

### Step 2 — Issue a new publishable key (additive, no user impact)

- Create a second `sb_publishable_` key. Do **not** disable the current one.
- **Verify:** the new key returns a normal GoTrue response against
  `/auth/v1/health`, and `401` against `/rest/v1/users` (the lockdown denies
  every browser key — that is the expected result, not a failure).
- **Failure looks like:** the new key erroring on `/auth/v1`. Stop; nothing has
  changed yet.
- **Rollback:** delete the new key. Nothing consumed it.

### Step 3 — Rebuild and redeploy the console with the new key

The only step with user-visible risk.

- Update `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` wherever the App Engine build
  reads it — locate this first, per correction 3.
- Rebuild and deploy. **A config change without a rebuild does nothing**, since
  the key is inlined at build time.
- **Verify** the new key is in the served bundle and the old one is gone:
  ```bash
  curl -s https://console.hawkviewapp.com/login | grep -o "/_next/static/chunks/[a-zA-Z0-9._-]*\.js" | sort -u | while read c; do curl -s "https://console.hawkviewapp.com$c"; done | grep -o "sb_publishable_[A-Za-z0-9_]*" | sort -u
  ```
  Then sign in at `console.hawkviewapp.com/login` and confirm the session loads.
- **Failure looks like:** the login page rendering but sign-in doing nothing.
  That is the `isSupabaseConfigured === false` path — a malformed or missing key
  makes the client `null` and the form inert rather than erroring loudly. Run
  the bundle grep above before assuming Supabase is at fault.
- **Rollback:** redeploy the previous App Engine version. The old key is still
  enabled at this point, which is the entire reason step 4 is separate.

### Step 4 — Disable the old publishable key

Only after step 3 is verified, and after a deliberate soak. A day is ample here.

- **Verify:** sign in once more with the old key fully disabled.
- **Failure looks like:** sign-in breaking, meaning a cached bundle or another
  consumer is still presenting the old key.
- **Rollback:** re-enable the old key. Instant; no deploy needed.

## 4. Blast radius

Small, and worth saying plainly rather than hedging.

- **9 auth accounts, 2 live MSPs.** This is not a large user base.
- **Steps 1, 2 and 4 are dashboard toggles with instant rollback.** Step 4's
  worst case is sign-in breaking until the key is re-enabled — one click, no
  deploy.
- **Step 3 is the only one that can break the console**, and its failure mode is
  loud and immediate: sign-in stops working. Rollback is redeploying the
  previous App Engine version.
- **The backend is not in the blast radius at all.** It connects to Postgres
  directly as `postgres` over `DATABASE_URL` and reaches Supabase only at
  `/auth/v1` with the service-role key. None of that is touched. The 5-minute
  sync, the identity-risk pipeline and all data collection are unaffected.
- **No data is at risk in any step.** These are credential operations; nothing
  reads, writes or moves a row.

The honest summary: the worst realistic outcome is that sign-in breaks for 9
people and is restored by one dashboard click or one redeploy.

## 5. What rotation does and does not achieve

**It closes the window going forward.** After step 4, the credential that was
public during the exposure no longer works.

**It does nothing about data already taken.** If anything was pulled while the
database was open, rotation does not retract it. Those rows — `users`,
`encrypted_secrets`, `directory_users`, `sign_in_logs`, `m365_audit_records` and
the rest — are already out, if they were ever taken.

### Can we tell whether anything was actually pulled?

Partly, and only for a narrow recent window. This is the part not to overstate.

**What exists:** Supabase `edge_logs` capture every `/rest/v1` request with
path, status code, client IP and user agent. The mechanism is there.

**What it shows for the retained window:** exactly one client touched
`/rest/v1` — `24.105.181.14`, `curl/8.21.0`. That is this investigation: six
`200`s at 03:41 (three tables × two keys, the before-evidence) and twenty-four
`401`s afterwards (the after-evidence and the 18-table sweep). No other client
made a single PostgREST request.

**The limit, and it is the whole story:** log retention on this project is
**about 24 hours**. The oldest record across *every* log source — `edge_logs`,
`postgres_logs`, `auth_logs`, `supavisor_logs` — is `2026-09-09T04:27`. The
project was created `2026-08-04T14:59`.

**That leaves roughly 36 days of exposure with no logs at all.** For that period
there is **no way to know** whether anyone read the database. Not "we found no
evidence" — the evidence does not exist to be searched. Anyone who pulled data
before 2026-09-09 left no trace that is still available.

So the accurate statement is: *no third-party access in the last 24 hours, and
unknowable before that.* Any stronger claim would be false. If a definitive
answer is ever required — for a customer or a contractual notification
obligation — it cannot be obtained from these logs, and that itself is the
finding.

The mitigation for next time is retention, not rotation: longer log retention
would make this answerable rather than unknowable.

## 6. Recommended order of business

1. **Disable the legacy `anon` JWT.** Free, uncoupled, removes a live unused
   credential. No reason to wait.
2. **Decide on the publishable key** (steps 2-4) as scheduled work, since it
   needs the App Engine build config located first.
3. **Separately, consider log retention.** It is the reason question 5 has no
   answer, and it will have no answer next time either unless it changes.
