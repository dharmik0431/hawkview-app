# HawkView frontend API contract

The browser reads product data only from the HawkView backend URL configured by
`NEXT_PUBLIC_API_URL`. The frontend must never receive database credentials,
Microsoft application secrets, or tenant-wide Microsoft access tokens.

## Required endpoints

| Method | Endpoint | Purpose |
| --- | --- | --- |
| `GET` | `/api/tenants` | Tenant directory and dashboard summaries |
| `GET` | `/api/tenants/:tenantId` | Stored tenant bundle and freshness metadata |
| `POST` | `/api/tenants/:tenantId/sync` | Queue an asynchronous tenant refresh |
| `GET` | `/api/dashboard/summary` | Prepared organization dashboard totals |
| `GET` | `/api/changes` | Stored cross-tenant change timeline |

All endpoints must authenticate the user and enforce their organization
membership and tenant assignments on the backend. The browser must not supply a
trusted `organizationId`.

Authenticated requests include the current Identity Platform ID token in the
`Authorization: Bearer ...` header. The backend verifies that short-lived token,
loads the HawkView user and memberships from PostgreSQL, and must allow only
approved HawkView frontend origins through CORS.

The sync endpoint should return quickly after queueing work. Existing database
data remains visible while the backend refreshes Microsoft data asynchronously.
