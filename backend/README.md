# HawkView backend

This package contains the HawkView API, PostgreSQL access, Identity Platform
token verification, and Microsoft 365 tenant-consent handling. Microsoft
directory users, subscribed-license totals, and verified tenant domains are
synchronized into PostgreSQL. Additional Microsoft workloads are added as
independent synchronization modules.

Prisma is isolated here so database credentials and generated database code are
never included in the frontend package.

The development connection uses the Cloud SQL Auth Proxy on
`127.0.0.1:5433` for the instance:

`hawkview-app:northamerica-northeast2:hawkview-db-dev`

The connection and Prisma migrations have been verified successfully.

## API commands

```text
npm run dev
npm run build
npm start
```

The API listens on port `8080` by default. The hosting platform can override it
through the `PORT` environment variable.

## Health endpoints

```text
GET /health
GET /health/database
```

`/health/database` checks the PostgreSQL connection and returns only a safe
availability status. It never returns credentials or database details.

## Deployment

The API is deployed separately from the Google AI Studio frontend. The
container is hosting-neutral and can run anywhere that supports Docker and a
public HTTPS service.

```text
Frontend -> HTTPS API -> Supabase PostgreSQL
```

The hosting environment must provide `DATABASE_URL`, `SUPABASE_URL`, and the
other values documented in `.env.example`. Credentials are not included in the
container image or committed to Git.

## Authentication

Supabase Auth verifies sign-ins. Email authentication is enabled first; Google
and Microsoft can be enabled through Supabase after their provider and redirect
settings are configured. HawkView remains responsible for its own users,
memberships, roles, and tenant authorization in PostgreSQL.

Authenticated API requests must include a Supabase access token:

```text
Authorization: Bearer ID_TOKEN
```

The global authentication guard protects every endpoint unless it is explicitly
marked public. The two health endpoints are public. After a first successful
sign-in, the frontend calls:

```text
POST /auth/bootstrap
```

That endpoint safely links the verified Supabase user ID to the HawkView `User`
record and returns the user's active MSP memberships. It never
trusts an organization or role supplied by the browser.

`FRONTEND_ORIGINS` is a comma-separated allowlist of frontend origins permitted
to call the API from a browser. Add each deployed HawkView frontend URL
explicitly; do not use a wildcard for the authenticated API.

## Scheduled synchronization

The portable scheduler calls:

```text
POST /api/internal/sync/due-tenants
Authorization: Bearer SCHEDULER_SHARED_SECRET
```

Use a long random `SCHEDULER_SHARED_SECRET` stored only in the backend host and
the scheduler's encrypted secret store. The Render Blueprint defines
`hawkview-sync-dev`, which calls this endpoint every five minutes. Enter the
same `SCHEDULER_SHARED_SECRET` value for both the web service and cron job; the
cron runner exits unsuccessfully when the API cannot be reached or rejects the
request, so failures appear in Render's run history.

During the GCP-to-portable migration,
the endpoint also accepts the existing Google Cloud Scheduler OIDC token when
`SCHEDULER_OIDC_AUDIENCE` and `SCHEDULER_SERVICE_ACCOUNT_EMAIL` are configured.
Remove those two Google settings after the replacement scheduler is verified.

## Microsoft tenant consent

HawkView supports two Microsoft connection modes:

- `HAWKVIEW_MANAGED`: the customer provides a tenant ID and approves the
  HawkView multitenant application.
- `CUSTOMER_MANAGED`: the customer provides a tenant ID, application ID, and
  credential for an application they control.

Platform Admins configure the HawkView-owned connector through the protected
HawkView Settings page. MSP Owners and Admins choose the connection mode while
onboarding a tenant.

The backend requires:

```text
SECRET_ENCRYPTION_KEY
MICROSOFT_ADMIN_CONSENT_REDIRECT_URI
MICROSOFT_REQUIRED_PERMISSIONS
FRONTEND_APP_URL
```

The backend validates submitted credentials with Microsoft before storing
them. Each secret is encrypted with AES-256-GCM before its ciphertext is stored
in PostgreSQL. The 32-byte `SECRET_ENCRYPTION_KEY` must be supplied by the
backend hosting environment and must never be stored in PostgreSQL or committed
to source control. Secrets are never returned to the browser. The consent state
signing key is created automatically in the encrypted store. Consent links are
signed, expire after 15 minutes, and can be used only once.

Credential references created before the migration continue to resolve through
their imported `legacyReference` mapping in PostgreSQL. The backend no longer
calls Google Secret Manager to read, create, or delete application secrets.

The initial least-privilege permission set is:

```text
Organization.Read.All
User.Read.All
```

After consent, the backend obtains a tenant-specific application token, reads
the organization from Microsoft Graph, verifies the returned tenant ID, stores
the real organization name and primary domain, and records granted or missing
permissions. Synchronization must not begin until every required permission is
present.
