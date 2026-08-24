# HawkView release safety

## Required pull-request checks

The repository workflow `.github/workflows/quality-gates.yml` defines two checks:

- `Frontend quality`
- `Backend quality and database integration`

The backend check starts an isolated PostgreSQL 16 service, applies every committed Prisma migration, and runs the complete backend suite with the real tenant-directory isolation test enabled. The test creates two temporary MSP organizations and proves each provider subject receives only its own tenant through the production `TenantsService.listForIdentity` Prisma query. Test records are UUID-scoped and removed when the test finishes.

After the workflow has completed successfully on its first pull request, protect `main` in GitHub:

1. Require a pull request before merging.
2. Require both checks above to pass and require the branch to be up to date.
3. Require conversations to be resolved before merging.
4. Block force pushes and branch deletion.
5. Do not require an approving review until a second independent reviewer exists; GitHub does not allow a pull-request author to approve their own change.

Do not add production credentials, Microsoft client secrets, Supabase service-role keys, or personal passwords to these workflows. The database service is disposable and uses CI-only credentials.

## Deployment smoke check

`.github/workflows/deployment-smoke.yml` listens for a successful Render GitHub deployment of `main - hawkview-api-dev`. It then verifies:

- `/health` reports healthy and serves the exact 40-character deployment revision from Render's `RENDER_GIT_COMMIT` value;
- `/health/database` reports connected with the expected schema.

The smoke check retries boundedly to tolerate a brief routing transition. It can also be run manually from GitHub Actions. A mismatch between the GitHub deployment SHA and the API revision fails the workflow.

## Authenticated two-MSP canary

`.github/workflows/authenticated-canary.yml` runs after the exact successful
`main - hawkview-api-dev` deployment and can also be dispatched manually from
`main`. It obtains a short-lived GitHub OIDC token and presents it to the
disabled-by-default backend endpoint `/api/internal/canary/sessions`.

The backend accepts only the exact repository ID, repository name, main ref,
workflow path, event type, live deployment revision, audience, issuer, and a
token issued within five minutes. It then verifies that both configured users
are enabled synthetic MSP owners, each has exactly one total active membership,
each organization has exactly one total member, and each organization has
exactly one expected pending synthetic tenant. That tenant must have only a
pending HawkView-managed connection with no client ID, credential reference,
consented permission, consent time, or completed onboarding. HawkView
temporarily assigns a cryptographically random password through the existing
server-only Supabase administration boundary, signs in, rotates the password
again, and returns only the short-lived access token. The service-role key,
temporary password, and refresh token never leave the backend or enter GitHub.

The workflow asserts for both identities that:

- `/auth/bootstrap` returns the expected email and exact organization;
- `/api/tenants` returns exactly the one expected tenant;
- the own tenant onboarding route is readable;
- the other canary MSP's tenant onboarding route returns 403 or 404;
- the API revision and database schema still match the deployment event.

### One-time fixture and Render configuration

Do not enable the endpoint until all of the following are true:

1. Create two dedicated non-production Supabase users. Never reuse a founder,
   employee, demo-customer, or personal account.
2. Bootstrap each into a separate synthetic HawkView organization. Each user
   and organization must have exactly one total membership: that user as the
   active MSP owner. Do not invite another member or attach another workspace.
3. Add exactly one synthetic, non-customer tenant to each organization, but do
   not grant Microsoft consent. It must remain `PENDING` with a
   `HAWKVIEW_MANAGED` / `PENDING_CONSENT` connection and no client ID,
   credential reference, consented permissions, consent timestamp, or completed
   onboarding. Never use a real Microsoft tenant ID or customer credentials.
4. In the Render API environment, set the eight `HAWKVIEW_CANARY_A_*` and
   `HAWKVIEW_CANARY_B_*` values documented in `backend/.env.example`, verify
   `SUPABASE_SERVICE_ROLE_KEY` remains server-only, and set
   `HAWKVIEW_CANARY_ENABLED=true` last.
5. In GitHub Actions repository variables, set
   `HAWKVIEW_AUTH_CANARY_ENABLED=true` last. Until this variable is present,
   the canary job is skipped rather than turning expected setup work into a
   false deployment failure.
6. Run `Authenticated two-MSP canary` manually from `main`. A green run is the
   acceptance criterion. A failed scheduled run is a release alert and must
   be investigated before treating the deployment as healthy.

The endpoint returns 404 while disabled. Missing, duplicated, cross-linked,
disabled, or expanded fixtures fail closed before a password or session is
issued. No canary request creates organizations, tenants, memberships, or
Microsoft connections, and no workflow secret or stored user password is
required.
