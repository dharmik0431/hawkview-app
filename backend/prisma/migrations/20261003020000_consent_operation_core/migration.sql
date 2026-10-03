-- Unwired prerequisite only. Existing rows and old-shaped inserts stay untrusted.
-- All new columns are nullable without defaults. Existing nonce/FKs/RLS/grants stay intact.
BEGIN;
ALTER TABLE microsoft_consent_attempts
  ADD COLUMN operation_version integer,
  ADD COLUMN operation_state varchar(16),
  ADD COLUMN expected_configuration uuid,
  ADD COLUMN expected_connection uuid,
  ADD COLUMN expected_microsoft_tenant uuid,
  ADD COLUMN expected_client_id uuid,
  ADD COLUMN expected_home_tenant_id uuid,
  ADD COLUMN expected_credential_reference varchar(500),
  ADD COLUMN operation_claim_id uuid,
  ADD COLUMN operation_claimed_at timestamptz(6),
  ADD COLUMN operation_final_deadline timestamptz(6),
  ADD COLUMN operation_terminal_at timestamptz(6),
  ADD COLUMN operation_result_connection uuid,
  ADD COLUMN operation_result_digest varchar(64);
ALTER TABLE microsoft_consent_attempts
  ADD CONSTRAINT consent_operation_shape CHECK ((
    num_nonnulls(operation_version, operation_state, expected_configuration, expected_connection, expected_microsoft_tenant, expected_client_id, expected_home_tenant_id, expected_credential_reference, operation_claim_id, operation_claimed_at, operation_final_deadline, operation_terminal_at, operation_result_connection, operation_result_digest) = 0 OR (
      operation_version = 1 AND operation_state IN ('ISSUED','CLAIMED','SUCCEEDED','FAILED','SUPERSEDED','EXPIRED')
      AND flow = 'EXISTING_TENANT' AND customer_tenant_id IS NOT NULL
      AND num_nonnulls(expected_configuration,expected_connection,expected_microsoft_tenant,
        expected_client_id,expected_home_tenant_id,expected_credential_reference) = 6
      AND expected_credential_reference = 'encrypted-secret:' || expected_configuration::text
      AND state_hash ~ '^[a-f0-9]{64}$'
      AND isfinite(created_at) AND isfinite(expires_at)
      AND created_at = date_trunc('milliseconds',created_at)
      AND expires_at = created_at + interval '15 minutes'
      AND (
        (operation_claim_id IS NULL AND operation_claimed_at IS NULL AND operation_final_deadline IS NULL
          AND consumed_at IS NULL AND operation_state IN ('ISSUED','EXPIRED'))
        OR (num_nonnulls(operation_claim_id,operation_claimed_at,operation_final_deadline,consumed_at) = 4
          AND isfinite(operation_claimed_at) AND isfinite(operation_final_deadline)
          AND operation_claimed_at = date_trunc('milliseconds',operation_claimed_at)
          AND operation_claimed_at >= created_at AND operation_claimed_at < expires_at
          AND operation_final_deadline = operation_claimed_at + interval '5 minutes'
          AND consumed_at = operation_claimed_at AND operation_state <> 'ISSUED')
      )
      AND (
        (operation_state IN ('ISSUED','CLAIMED') AND operation_terminal_at IS NULL
          AND operation_result_connection IS NULL AND operation_result_digest IS NULL
          AND ((operation_state = 'ISSUED' AND result_code IS NULL)
            OR (operation_state = 'CLAIMED' AND result_code = 'CALLBACK_RECEIVED')))
        OR (operation_state IN ('SUCCEEDED','FAILED','SUPERSEDED','EXPIRED')
          AND operation_terminal_at IS NOT NULL AND isfinite(operation_terminal_at)
          AND operation_terminal_at = date_trunc('milliseconds',operation_terminal_at)
          AND operation_terminal_at >= COALESCE(operation_claimed_at,created_at)
          AND (
            (operation_state IN ('SUPERSEDED','EXPIRED') AND result_code = operation_state
              AND operation_result_connection IS NULL AND operation_result_digest IS NULL)
            OR (operation_state IN ('SUCCEEDED','FAILED')
              AND operation_result_connection IS NOT NULL AND operation_result_digest ~ '^[a-f0-9]{64}$'
              AND operation_terminal_at < operation_final_deadline
              AND ((operation_state = 'SUCCEEDED' AND result_code = 'CONNECTED')
                OR (operation_state = 'FAILED' AND result_code IN ('CONSENT_DENIED','TENANT_MISMATCH','VERIFICATION_FAILED','MISSING_PERMISSIONS'))))
          ))
      )
    )
  ) IS TRUE);
COMMIT;
