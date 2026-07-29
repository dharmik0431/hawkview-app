# HawkView backend

This package will contain the HawkView API, PostgreSQL access, Microsoft Graph
synchronization, authentication, and server-side authorization.

Prisma is isolated here so database credentials and generated database code are
never included in the frontend package.

The development connection uses the Cloud SQL Auth Proxy on
`127.0.0.1:5433` for the instance:

`hawkview-app:northamerica-northeast2:hawkview-db-dev`

The connection has been verified successfully. No database models or
migrations have been created yet. The next milestone is to define and review
the initial HawkView schema before applying the first migration.
