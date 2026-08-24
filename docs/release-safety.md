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

## Authenticated canary follow-up

Health endpoints cannot prove that an authenticated, organization-scoped product query works. The next release-safety increment should add a dedicated non-production canary with:

- two test-only Supabase users;
- two isolated HawkView organizations;
- one synthetic customer tenant per organization;
- a server-controlled short-lived authentication flow—never stored user passwords or a long-lived access token;
- assertions that each user sees exactly one expected tenant and a foreign tenant UUID is denied;
- alert routing agreed by the operator.

Do not point this canary at customer tenants or reuse founder/personal accounts.
