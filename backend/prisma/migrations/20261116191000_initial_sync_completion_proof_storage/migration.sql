-- Inactive expansion: no proof defaults/backfill and no writer or reader cutover.
-- Existing scope keys, DIRECTORY_ROLES receipts, RLS and grants remain unchanged.
-- NOT VALID checks enforce new writes immediately. Validation still scans; both
-- lock acquisition and statement execution fail within bounded time. This is not
-- a zero-downtime or post-activation rollback-safety claim.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

ALTER TABLE tenant_connections
  ADD COLUMN initial_sync_epoch_id uuid,
  ADD COLUMN initial_sync_epoch_started_at timestamptz(6),
  ADD CONSTRAINT initial_sync_epoch_pair CHECK (
    (initial_sync_epoch_id IS NULL) = (initial_sync_epoch_started_at IS NULL)
  ) NOT VALID,
  ADD CONSTRAINT initial_sync_epoch_non_nil CHECK (
    initial_sync_epoch_id IS NULL OR
    initial_sync_epoch_id <> '00000000-0000-0000-0000-000000000000'::uuid
  ) NOT VALID,
  ADD CONSTRAINT initial_sync_epoch_finite CHECK (
    initial_sync_epoch_started_at IS NULL OR isfinite(initial_sync_epoch_started_at)
  ) NOT VALID;

ALTER TABLE sync_states
  ADD COLUMN initial_sync_attempt_epoch_id uuid,
  ADD COLUMN initial_sync_attempt_id uuid,
  ADD COLUMN initial_sync_persisted_attempt_id uuid,
  ADD COLUMN initial_sync_completed_attempt_id uuid,
  ADD COLUMN initial_sync_persisted_kind varchar(32),
  ADD CONSTRAINT initial_sync_attempt_pair CHECK (
    (initial_sync_attempt_epoch_id IS NULL) = (initial_sync_attempt_id IS NULL)
  ) NOT VALID,
  ADD CONSTRAINT initial_sync_receipt_non_nil CHECK (
    (initial_sync_attempt_epoch_id IS NULL OR
      initial_sync_attempt_epoch_id <> '00000000-0000-0000-0000-000000000000'::uuid)
    AND (initial_sync_attempt_id IS NULL OR
      initial_sync_attempt_id <> '00000000-0000-0000-0000-000000000000'::uuid)
    AND (initial_sync_persisted_attempt_id IS NULL OR
      initial_sync_persisted_attempt_id <> '00000000-0000-0000-0000-000000000000'::uuid)
    AND (initial_sync_completed_attempt_id IS NULL OR
      initial_sync_completed_attempt_id <> '00000000-0000-0000-0000-000000000000'::uuid)
  ) NOT VALID,
  ADD CONSTRAINT initial_sync_persisted_attempt_match CHECK (
    (initial_sync_persisted_attempt_id IS NULL OR
      (initial_sync_attempt_id IS NOT NULL
        AND initial_sync_persisted_attempt_id = initial_sync_attempt_id)) IS TRUE
  ) NOT VALID,
  ADD CONSTRAINT initial_sync_persisted_kind_pair CHECK (
    (initial_sync_persisted_attempt_id IS NULL) = (initial_sync_persisted_kind IS NULL)
  ) NOT VALID,
  ADD CONSTRAINT initial_sync_persisted_kind_resource CHECK (
    (initial_sync_persisted_kind IS NULL OR
      (resource_type = 'SIGN_INS' AND initial_sync_persisted_kind = 'GRAPH_SIGN_INS') OR
      (resource_type IN ('USERS', 'LICENSES', 'DOMAINS', 'GROUPS', 'AUTH_REGISTRATIONS',
        'CONDITIONAL_ACCESS', 'AUTHENTICATION_STRENGTHS', 'APPLICATIONS',
        'SERVICE_PRINCIPALS', 'AUDIT_LOGS', 'M365_AUDIT', 'SHAREPOINT_SITES')
        AND initial_sync_persisted_kind = 'FULL_RESOURCE')) IS TRUE
  ) NOT VALID,
  ADD CONSTRAINT initial_sync_required_resource_only CHECK (
    (resource_type IN ('USERS', 'LICENSES', 'DOMAINS', 'GROUPS', 'AUTH_REGISTRATIONS',
      'CONDITIONAL_ACCESS', 'AUTHENTICATION_STRENGTHS', 'APPLICATIONS',
      'SERVICE_PRINCIPALS', 'AUDIT_LOGS', 'M365_AUDIT', 'SIGN_INS', 'SHAREPOINT_SITES') OR
      (initial_sync_attempt_epoch_id IS NULL AND initial_sync_attempt_id IS NULL
        AND initial_sync_persisted_attempt_id IS NULL
        AND initial_sync_completed_attempt_id IS NULL
        AND initial_sync_persisted_kind IS NULL)) IS TRUE
  ) NOT VALID,
  ADD CONSTRAINT initial_sync_completed_attempt_match CHECK (
    (initial_sync_completed_attempt_id IS NULL OR
      (initial_sync_attempt_id IS NOT NULL AND initial_sync_persisted_attempt_id IS NOT NULL
        AND initial_sync_completed_attempt_id = initial_sync_attempt_id
        AND initial_sync_completed_attempt_id = initial_sync_persisted_attempt_id
        AND status = 'SUCCEEDED'
        AND last_error_code IS NULL AND last_error_message IS NULL)) IS TRUE
  ) NOT VALID,
  ADD CONSTRAINT initial_sync_attempt_time CHECK (
    (initial_sync_attempt_id IS NULL OR
      (last_attempt_at IS NOT NULL AND isfinite(last_attempt_at))) IS TRUE
  ) NOT VALID,
  ADD CONSTRAINT initial_sync_completed_time CHECK (
    (initial_sync_completed_attempt_id IS NULL OR
      (last_attempt_at IS NOT NULL AND last_successful_at IS NOT NULL
        AND isfinite(last_attempt_at) AND isfinite(last_successful_at)
        AND last_successful_at >= last_attempt_at)) IS TRUE
  ) NOT VALID;

ALTER TABLE tenant_connections
  VALIDATE CONSTRAINT initial_sync_epoch_pair,
  VALIDATE CONSTRAINT initial_sync_epoch_non_nil,
  VALIDATE CONSTRAINT initial_sync_epoch_finite;
ALTER TABLE sync_states
  VALIDATE CONSTRAINT initial_sync_attempt_pair,
  VALIDATE CONSTRAINT initial_sync_receipt_non_nil,
  VALIDATE CONSTRAINT initial_sync_persisted_attempt_match,
  VALIDATE CONSTRAINT initial_sync_persisted_kind_pair,
  VALIDATE CONSTRAINT initial_sync_persisted_kind_resource,
  VALIDATE CONSTRAINT initial_sync_required_resource_only,
  VALIDATE CONSTRAINT initial_sync_completed_attempt_match,
  VALIDATE CONSTRAINT initial_sync_attempt_time,
  VALIDATE CONSTRAINT initial_sync_completed_time;
COMMIT;
