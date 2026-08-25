# Render backend deployment

Render hosts only the HawkView NestJS API. Supabase remains responsible for
PostgreSQL and user authentication, and Google AI Studio remains the frontend
development and publishing surface.

## Initial Blueprint deployment

1. In Render, create a **Blueprint** from `dharmik0431/hawkview-app`.
2. Render reads the repository root `render.yaml` and builds
   `backend/Dockerfile`.
3. Supply the variables marked `sync: false` when Render prompts for them.
   Never commit their real values.

| Variable                               | Value to supply                                                                           |
| -------------------------------------- | ----------------------------------------------------------------------------------------- |
| `DATABASE_URL`                         | Supabase **Session pooler** PostgreSQL URI, including the real password                   |
| `SUPABASE_URL`                         | `https://lvjqyvrtlkmhseelofda.supabase.co`                                                |
| `SECRET_ENCRYPTION_KEY`                | The existing 64-character encryption key used by HawkView                                 |
| `FRONTEND_ORIGINS`                     | Comma-separated published and preview frontend origins, without paths                     |
| `FRONTEND_APP_URL`                     | The published HawkView frontend origin, without a trailing slash                          |
| `GAS_PREVIEW_PROJECT_NUMBER`           | `660434798674`                                                                            |
| `MICROSOFT_ADMIN_CONSENT_REDIRECT_URI` | `https://api.hawkviewapp.com/api/tenants/microsoft/admin-consent/callback`               |
| `MICROSOFT_REQUIRED_PERMISSIONS`       | The same permission list currently configured on the API                                  |
| `SCHEDULER_SHARED_SECRET`              | A random value of at least 32 characters; use the same value in the replacement scheduler |

The Blueprint deliberately does not define Google Cloud OIDC variables. The
portable scheduler endpoint authenticates with `SCHEDULER_SHARED_SECRET`.

## Validation before cutover

Keep the Cloud Run API and existing scheduler enabled until every check below
passes against the Render URL:

1. `GET /health` returns HTTP 200.
2. `GET /health/database` returns `database: connected` and `schema: current`.
3. Login from the published frontend succeeds after temporarily targeting the
   Render API URL.
4. Tenant directory, tenant details, and profile settings load successfully.
5. A manual tenant sync completes and its data remains available after refresh.
6. Microsoft consent uses the Render callback and completes successfully.
7. The replacement five-minute scheduler invokes
   `POST /api/internal/sync/due-tenants` successfully.

Only after these checks pass should `NEXT_PUBLIC_API_URL` be permanently changed
to `https://api.hawkviewapp.com` and the Cloud Run service and Google
Cloud Scheduler be disabled.

## Instance choice

The Blueprint initially uses Render's free instance for a low-risk cutover test.
Free services sleep after inactivity and can take about a minute to wake, so use
an always-on paid instance before customer testing. No Render database is
required.
