BEGIN;
-- Source-only candidate. Execution and production collection are separately held.
-- No retention lifetime, deletion job, DIRECTORY_ROLES alias or shared snapshot writes.
CREATE TYPE pim_schedule_plane AS ENUM ('ACTIVE', 'ELIGIBLE');
CREATE TYPE pim_attempt_outcome AS ENUM ('COMMITTED', 'FAILED', 'ABANDONED');

CREATE TABLE pim_schedule_scopes (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  customer_tenant_id uuid NOT NULL,
  microsoft_tenant_id uuid NOT NULL,
  plane pim_schedule_plane NOT NULL,
  scope_incarnation uuid NOT NULL,
  scope_version text NOT NULL,
  endpoint_descriptor text NOT NULL,
  projection_identity text NOT NULL,
  is_current boolean NOT NULL DEFAULT false,
  created_at timestamptz(6) NOT NULL DEFAULT clock_timestamp(),
  retired_at timestamptz(6),
  CONSTRAINT pim_scope_tenant FOREIGN KEY (customer_tenant_id,organization_id)
    REFERENCES customer_tenants(id,organization_id) ON DELETE CASCADE,
  CONSTRAINT pim_scope_id_plane UNIQUE (id,plane),
  CONSTRAINT pim_scope_current_shape CHECK (NOT is_current OR retired_at IS NULL)
);
CREATE UNIQUE INDEX pim_scope_one_current ON pim_schedule_scopes(customer_tenant_id,plane) WHERE is_current;
CREATE INDEX pim_scope_tenant_history ON pim_schedule_scopes(organization_id,customer_tenant_id,plane);

CREATE TABLE pim_schedule_attempts (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  customer_tenant_id uuid NOT NULL,
  microsoft_tenant_id uuid NOT NULL,
  plane pim_schedule_plane NOT NULL,
  configuration_revision uuid NOT NULL,
  connection_incarnation uuid NOT NULL,
  scope_id uuid NOT NULL,
  scope_incarnation uuid NOT NULL,
  scope_version text NOT NULL,
  endpoint_descriptor text NOT NULL,
  projection_identity text NOT NULL,
  started_at timestamptz(6) NOT NULL,
  expires_at timestamptz(6) NOT NULL,
  committed_at timestamptz(6),
  terminal_at timestamptz(6),
  content_changed_at timestamptz(6),
  outcome pim_attempt_outcome,
  failure_kind text,
  traversal_outcome text NOT NULL,
  observed_row_count integer,
  assurance_state text NOT NULL DEFAULT 'UNKNOWN',
  coverage_state text NOT NULL DEFAULT 'NOT_ESTABLISHED',
  content_digest text,
  is_current boolean NOT NULL DEFAULT false,
  retention_class text,
  eligible_for_deletion_at timestamptz(6),
  CONSTRAINT pim_attempt_tenant FOREIGN KEY (customer_tenant_id,organization_id)
    REFERENCES customer_tenants(id,organization_id) ON DELETE CASCADE,
  CONSTRAINT pim_attempt_scope FOREIGN KEY (scope_id,plane) REFERENCES pim_schedule_scopes(id,plane),
  CONSTRAINT pim_attempt_id_plane UNIQUE (id,plane),
  CONSTRAINT pim_attempt_clock CHECK (expires_at>started_at),
  CONSTRAINT pim_attempt_count CHECK (observed_row_count IS NULL OR observed_row_count>=0),
  CONSTRAINT pim_attempt_traversal CHECK (traversal_outcome IN ('IN_FLIGHT','EXHAUSTED','TRUNCATED_BUDGET','TRUNCATED_DEADLINE','ERRORED')),
  CONSTRAINT pim_assurance_bounded CHECK (assurance_state='UNKNOWN'),
  CONSTRAINT pim_coverage_bounded CHECK (coverage_state='NOT_ESTABLISHED'),
  CONSTRAINT pim_state_shape CHECK (CASE
    WHEN outcome IS NULL THEN terminal_at IS NULL AND committed_at IS NULL AND content_digest IS NULL
      AND observed_row_count IS NULL AND is_current IS FALSE AND traversal_outcome='IN_FLIGHT'
    WHEN outcome='COMMITTED' THEN terminal_at IS NOT NULL AND committed_at IS NOT NULL AND content_digest IS NOT NULL
      AND observed_row_count IS NOT NULL AND traversal_outcome='EXHAUSTED' AND content_changed_at IS NOT NULL
    ELSE terminal_at IS NOT NULL AND committed_at IS NULL AND is_current IS FALSE AND traversal_outcome<>'IN_FLIGHT'
  END)
);
CREATE UNIQUE INDEX pim_attempt_one_inflight ON pim_schedule_attempts(customer_tenant_id,plane) WHERE terminal_at IS NULL;
CREATE UNIQUE INDEX pim_attempt_one_current ON pim_schedule_attempts(customer_tenant_id,plane) WHERE is_current;
CREATE INDEX pim_attempt_tenant_history ON pim_schedule_attempts(organization_id,customer_tenant_id,plane,started_at DESC,id DESC);
CREATE INDEX pim_attempt_scope_idx ON pim_schedule_attempts(scope_id,plane);

CREATE TABLE pim_schedule_envelopes (
  id uuid PRIMARY KEY,
  attempt_id uuid NOT NULL REFERENCES pim_schedule_attempts(id) ON DELETE CASCADE,
  page_index integer NOT NULL CHECK (page_index>=0),
  requested_token text NOT NULL,
  envelope jsonb NOT NULL,
  byte_length integer NOT NULL CHECK (byte_length>=0),
  CONSTRAINT pim_envelope_page UNIQUE (attempt_id,page_index)
);
CREATE TABLE pim_schedule_observation_rows (
  id uuid PRIMARY KEY,
  attempt_id uuid NOT NULL,
  plane pim_schedule_plane NOT NULL,
  occurrence_ordinal integer NOT NULL CHECK (occurrence_ordinal>=0),
  instance_id text,
  raw jsonb NOT NULL,
  observations jsonb NOT NULL,
  diagnostics jsonb NOT NULL,
  provider_start_date_time timestamptz(6),
  provider_end_date_time timestamptz(6),
  CONSTRAINT pim_row_parent_plane FOREIGN KEY (attempt_id,plane) REFERENCES pim_schedule_attempts(id,plane) ON DELETE CASCADE,
  CONSTRAINT pim_row_occurrence UNIQUE (attempt_id,occurrence_ordinal)
);
CREATE INDEX pim_row_instance_idx ON pim_schedule_observation_rows(attempt_id,instance_id);
CREATE TABLE pim_schedule_wire_failures (
  id uuid PRIMARY KEY,
  attempt_id uuid NOT NULL REFERENCES pim_schedule_attempts(id) ON DELETE CASCADE,
  page_index integer NOT NULL CHECK (page_index>=0),
  byte_length integer NOT NULL CHECK (byte_length>=0),
  failure_kind text NOT NULL CHECK (failure_kind='INVALID_JSON'),
  CONSTRAINT pim_wire_failure_page UNIQUE (attempt_id,page_index)
);

-- Server database boundary only. No Supabase Data API read/write policy is granted.
ALTER TABLE pim_schedule_scopes ENABLE ROW LEVEL SECURITY;
ALTER TABLE pim_schedule_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE pim_schedule_envelopes ENABLE ROW LEVEL SECURITY;
ALTER TABLE pim_schedule_observation_rows ENABLE ROW LEVEL SECURITY;
ALTER TABLE pim_schedule_wire_failures ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON pim_schedule_scopes,pim_schedule_attempts,pim_schedule_envelopes,
  pim_schedule_observation_rows,pim_schedule_wire_failures FROM PUBLIC;
DO $$ DECLARE target_role text; BEGIN
  FOREACH target_role IN ARRAY ARRAY['anon','authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname=target_role) THEN
      EXECUTE format('REVOKE ALL ON pim_schedule_scopes,pim_schedule_attempts,pim_schedule_envelopes,pim_schedule_observation_rows,pim_schedule_wire_failures FROM %I',target_role);
    END IF;
  END LOOP;
END $$;

COMMIT;
