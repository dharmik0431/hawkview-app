# HawkView backend

This package contains the HawkView API and PostgreSQL access. Microsoft Graph
synchronization, authentication, and server-side authorization will be added
in later milestones.

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
