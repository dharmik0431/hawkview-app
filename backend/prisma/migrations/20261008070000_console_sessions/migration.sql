-- DRAFT: reviewed migration application must precede deployment of the guard.
-- No session backfill or expiry cleanup: retained rows prevent token revival.
BEGIN;
SET LOCAL lock_timeout = '5s';
CREATE TABLE console_sessions (
  session_id uuid PRIMARY KEY,
  subject uuid NOT NULL,
  authenticated_at timestamptz,
  idle_expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT console_session_authentication CHECK (authenticated_at IS NOT NULL OR revoked_at IS NOT NULL),
  CONSTRAINT console_session_deadline CHECK (authenticated_at IS NULL OR idle_expires_at >= authenticated_at)
);
-- Deliberately no FK/cascade to users or auth.sessions: pre-bootstrap admission
-- and durable revocation must survive ordinary user/session cleanup.
ALTER TABLE console_sessions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON console_sessions FROM PUBLIC;
DO $$
DECLARE target_role text;
BEGIN
  FOREACH target_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = target_role) THEN
      EXECUTE format('REVOKE ALL ON console_sessions FROM %I', target_role);
    END IF;
  END LOOP;
END
$$;
COMMIT;
