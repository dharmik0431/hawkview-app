-- HAW-70 inactive reconciliation receipt. This migration creates no receipt
-- and performs no historical repair. A future ordinary transaction must insert
-- a receipt only after its authority repair and invariants succeed. Existence
-- alone does not certify complete writer coverage or authorize a health reader.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '15s';

CREATE TABLE public.tenant_health_reconciliation_generations (
  generation varchar(120) PRIMARY KEY,
  protocol_fingerprint char(64) NOT NULL,
  completed_at timestamptz(6) NOT NULL DEFAULT transaction_timestamp(),
  CONSTRAINT tenant_health_reconciliation_generation_format
    CHECK (generation ~ '^[a-z0-9][a-z0-9._-]{0,119}$'),
  CONSTRAINT tenant_health_reconciliation_fingerprint_format
    CHECK (protocol_fingerprint ~ '^[0-9a-f]{64}$'),
  CONSTRAINT tenant_health_reconciliation_completed_at_finite
    CHECK (isfinite(completed_at))
);

COMMENT ON TABLE public.tenant_health_reconciliation_generations IS
  'Private immutable historical reconciliation receipts; never a standalone activation gate';
COMMENT ON COLUMN public.tenant_health_reconciliation_generations.completed_at IS
  'Transaction timestamp, not commit time or a source freshness watermark';

-- Retain receipts across ordinary retries and tenant/organization lifecycle.
-- There is no UPDATE completion state: insertion and authority repair must
-- commit together. Even zero-row UPDATE/DELETE and TRUNCATE are refused.
CREATE FUNCTION public.tenant_health_preserve_reconciliation_generation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  RAISE EXCEPTION 'TENANT_HEALTH_RECONCILIATION_GENERATION_IMMUTABLE'
    USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER tenant_health_preserve_reconciliation_generation
BEFORE UPDATE OR DELETE OR TRUNCATE
ON public.tenant_health_reconciliation_generations
FOR EACH STATEMENT
EXECUTE FUNCTION public.tenant_health_preserve_reconciliation_generation();

ALTER TABLE public.tenant_health_reconciliation_generations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.tenant_health_reconciliation_generations FROM PUBLIC;
REVOKE ALL ON FUNCTION public.tenant_health_preserve_reconciliation_generation() FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON public.tenant_health_reconciliation_generations FROM anon;
    REVOKE ALL ON FUNCTION public.tenant_health_preserve_reconciliation_generation() FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON public.tenant_health_reconciliation_generations FROM authenticated;
    REVOKE ALL ON FUNCTION public.tenant_health_preserve_reconciliation_generation() FROM authenticated;
  END IF;
END $$;
COMMIT;
