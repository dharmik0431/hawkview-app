-- Unwired expansion only: no success backfill or volatile column default/table rewrite.
-- Existing table RLS/ACLs remain in force. Constraint validation may scan tables;
-- lock_timeout only bounds lock acquisition, not total execution. Production is separate.
BEGIN;
SET LOCAL lock_timeout = '5s';
ALTER TABLE tenant_connections ADD COLUMN collection_incarnation uuid;
ALTER TABLE tenant_entra_snapshots ADD COLUMN role_publication_attempt_id uuid,
  ADD CONSTRAINT role_snapshot_only CHECK (resource_type = 'DIRECTORY_ROLES' OR role_publication_attempt_id IS NULL);
ALTER TABLE sync_states
  ADD COLUMN role_scope_version varchar(100),
  ADD COLUMN role_scope_incarnation uuid,
  ADD COLUMN role_attempt_id uuid,
  ADD COLUMN role_attempt_connection uuid,
  ADD COLUMN role_attempt_configuration uuid,
  ADD COLUMN role_attempt_scope uuid,
  ADD COLUMN role_attempt_started_at timestamptz(6),
  ADD COLUMN role_attempt_expires_at timestamptz(6),
  ADD COLUMN role_attempt_outcome varchar(16),
  ADD COLUMN role_attempt_terminal_at timestamptz(6),
  ADD COLUMN role_complete_id uuid,
  ADD COLUMN role_complete_connection uuid,
  ADD COLUMN role_complete_configuration uuid,
  ADD COLUMN role_complete_scope uuid,
  ADD COLUMN role_complete_scope_version varchar(100),
  ADD COLUMN role_complete_microsoft_tenant_id uuid,
  ADD COLUMN role_complete_checked_at timestamptz(6),
  ADD COLUMN role_complete_digest varchar(64),
  ADD COLUMN role_complete_count integer,
  ADD CONSTRAINT role_fields_only CHECK (resource_type = 'DIRECTORY_ROLES' OR num_nonnulls(role_scope_version, role_scope_incarnation, role_attempt_id, role_attempt_connection, role_attempt_configuration, role_attempt_scope, role_attempt_started_at, role_attempt_expires_at, role_attempt_outcome, role_attempt_terminal_at, role_complete_id, role_complete_connection, role_complete_configuration, role_complete_scope, role_complete_scope_version, role_complete_microsoft_tenant_id, role_complete_checked_at, role_complete_digest, role_complete_count) = 0),
  ADD CONSTRAINT role_scope_shape CHECK ((num_nonnulls(role_scope_version, role_scope_incarnation) = 0 OR (num_nonnulls(role_scope_version, role_scope_incarnation) = 2 AND length(role_scope_version) > 0)) IS TRUE),
  ADD CONSTRAINT role_attempt_shape CHECK ((
    (num_nonnulls(role_attempt_id, role_attempt_connection, role_attempt_configuration, role_attempt_scope, role_attempt_started_at, role_attempt_expires_at, role_attempt_outcome, role_attempt_terminal_at) = 0) OR
    (num_nonnulls(role_attempt_id, role_attempt_connection, role_attempt_configuration, role_attempt_scope, role_attempt_started_at, role_attempt_expires_at, role_attempt_outcome) = 7 AND role_scope_incarnation IS NOT NULL
      AND role_attempt_scope = role_scope_incarnation
      AND isfinite(role_attempt_started_at) AND isfinite(role_attempt_expires_at)
      AND role_attempt_expires_at > role_attempt_started_at
      AND role_attempt_started_at = date_trunc('milliseconds', role_attempt_started_at)
      AND ((role_attempt_outcome = 'RUNNING' AND role_attempt_terminal_at IS NULL)
        OR (role_attempt_outcome IN ('COMPLETE','FAILED','PARTIAL','EXPIRED') AND role_attempt_terminal_at IS NOT NULL
          AND isfinite(role_attempt_terminal_at) AND role_attempt_terminal_at >= role_attempt_started_at)))
  ) IS TRUE),
  ADD CONSTRAINT role_complete_shape CHECK ((num_nonnulls(role_complete_id, role_complete_connection, role_complete_configuration, role_complete_scope, role_complete_scope_version, role_complete_microsoft_tenant_id, role_complete_checked_at, role_complete_digest, role_complete_count) = 0 OR
    (num_nonnulls(role_complete_id, role_complete_connection, role_complete_configuration, role_complete_scope, role_complete_scope_version, role_complete_microsoft_tenant_id, role_complete_checked_at, role_complete_digest, role_complete_count) = 9 AND role_complete_count BETWEEN 0 AND 1000
      AND role_complete_digest ~ '^[0-9a-f]{64}$' AND length(role_complete_scope_version) > 0
      AND isfinite(role_complete_checked_at) AND role_complete_checked_at = date_trunc('milliseconds',role_complete_checked_at))) IS TRUE),
  ADD CONSTRAINT role_complete_attempt_binding CHECK ((role_attempt_outcome IS DISTINCT FROM 'COMPLETE' OR
    (role_complete_id = role_attempt_id AND role_complete_connection = role_attempt_connection
      AND role_complete_configuration = role_attempt_configuration AND role_complete_scope = role_attempt_scope
      AND role_complete_checked_at = role_attempt_terminal_at)) IS TRUE);
COMMIT;
