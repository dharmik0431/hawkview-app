BEGIN;

-- No default or backfill: an old terminal operation has no observed occurrence set.
ALTER TABLE microsoft_consent_attempts ADD COLUMN operation_effects_snapshot JSONB;
ALTER TABLE microsoft_consent_attempts ADD CONSTRAINT consent_effect_snapshot_shape CHECK (
  operation_effects_snapshot IS NULL OR (
    operation_version IS NOT DISTINCT FROM 1
    AND operation_state IN ('SUCCEEDED','FAILED')
    AND jsonb_typeof(operation_effects_snapshot) IS NOT DISTINCT FROM 'object'
    AND operation_effects_snapshot->'version' IS NOT DISTINCT FROM '1'::jsonb
    AND jsonb_typeof(operation_effects_snapshot->'rows') IS NOT DISTINCT FROM 'array'
  )
);

COMMIT;
