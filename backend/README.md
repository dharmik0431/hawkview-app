# HawkView backend

This package contains the HawkView API, PostgreSQL access, and Identity Platform
token verification. Microsoft Graph synchronization and detailed server-side
authorization will be added in later milestones.

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

The API listens on port `8080` by default. Cloud Run can override it through
the `PORT` environment variable.

## Health endpoints

```text
GET /health
GET /health/database
```

`/health/database` checks the PostgreSQL connection and returns only a safe
availability status. It never returns credentials or database details.

## Development deployment

The development API is deployed separately from the Google AI Studio frontend:

```text
Cloud Run service: hawkview-api-dev
Cloud SQL instance: hawkview-db-dev
Region: northamerica-northeast2
```

Cloud Run receives `DATABASE_URL` from Secret Manager and connects through the
Cloud SQL integration. Database credentials are not included in the container
image or committed to Git.

## Authentication

Google Cloud Identity Platform verifies sign-ins. Passwordless-capable email
authentication is enabled first; Google and Microsoft will be enabled after
their provider and redirect settings are available. HawkView remains
responsible for its own users, memberships, roles, and tenant authorization in
PostgreSQL.

Authenticated API requests must include an Identity Platform ID token:

```text
Authorization: Bearer ID_TOKEN
```

The global authentication guard protects every endpoint unless it is explicitly
marked public. The two health endpoints are public. After a first successful
sign-in, the frontend calls:

```text
POST /auth/bootstrap
```

That endpoint safely links the verified Identity Platform user ID to the
HawkView `User` record and returns the user's active MSP memberships. It never
trusts an organization or role supplied by the browser.

`FRONTEND_ORIGINS` is a comma-separated allowlist of frontend origins permitted
to call the API from a browser. Add each deployed HawkView frontend URL
explicitly; do not use a wildcard for the authenticated API.
