-- Additive candidate only; deployment and writer cutover are separate operations.
BEGIN;
SET LOCAL lock_timeout = '5s';
ALTER TABLE platform_microsoft_connectors
  ADD COLUMN configuration_revision uuid NOT NULL DEFAULT gen_random_uuid(),
  ADD COLUMN configuration_operation_id uuid,
  ADD COLUMN publication_fingerprint varchar(64),
  ADD CONSTRAINT managed_connector_publication_shape CHECK (
    (configuration_operation_id IS NULL AND publication_fingerprint IS NULL) OR
    (configuration_operation_id IS NOT NULL AND publication_fingerprint IS NOT NULL
      AND publication_fingerprint ~ '^[a-f0-9]{64}$')
  );

CREATE TABLE managed_connector_authority_revisions (revision uuid PRIMARY KEY);
INSERT INTO managed_connector_authority_revisions (revision)
  SELECT configuration_revision FROM platform_microsoft_connectors;

-- Match the existing backend-only, owner-access security boundary.
ALTER TABLE managed_connector_authority_revisions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON managed_connector_authority_revisions FROM PUBLIC;
DO $$
DECLARE target_role text;
BEGIN
  FOREACH target_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = target_role) THEN
      EXECUTE format('REVOKE ALL ON managed_connector_authority_revisions FROM %I', target_role);
    END IF;
  END LOOP;
END
$$;
COMMIT;
