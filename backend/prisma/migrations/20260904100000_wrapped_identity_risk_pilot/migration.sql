-- Optional code-only pilot provider. No key material, opt-ins, or production activation.
ALTER TABLE identity_risk_pseudonym_key_versions DROP CONSTRAINT identity_risk_pseudonym_key_versions_provider_check;
ALTER TABLE identity_risk_pseudonym_key_versions ADD CONSTRAINT identity_risk_keys_provider_check
  CHECK (provider IN ('AWS_KMS_HMAC_256', 'WRAPPED_AES_GCM_V1'));
ALTER TABLE identity_risk_pseudonym_key_versions ADD COLUMN destroyed_at TIMESTAMPTZ(6);

CREATE TABLE identity_risk_wrapped_keys (
  key_version_id UUID PRIMARY KEY REFERENCES identity_risk_pseudonym_key_versions(id) ON DELETE CASCADE,
  name VARCHAR(256) NOT NULL UNIQUE,
  ciphertext BYTEA NOT NULL CHECK (octet_length(ciphertext)=32),
  iv BYTEA NOT NULL CHECK (octet_length(iv)=12),
  tag BYTEA NOT NULL CHECK (octet_length(tag)=16)
);
CREATE FUNCTION identity_risk_wrapped_key_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE k identity_risk_pseudonym_key_versions;
BEGIN
  IF TG_OP='UPDATE' THEN RAISE EXCEPTION 'Wrapped key is immutable'; END IF;
  IF TG_OP='DELETE' THEN
    UPDATE identity_risk_pseudonym_key_versions SET status='DISABLED', retired_at=COALESCE(retired_at,CURRENT_TIMESTAMP), destroyed_at=CURRENT_TIMESTAMP WHERE id=OLD.key_version_id;
    RETURN OLD;
  END IF;
  SELECT * INTO k FROM identity_risk_pseudonym_key_versions WHERE id=NEW.key_version_id FOR UPDATE;
  IF k.id IS NULL OR k.provider <> 'WRAPPED_AES_GCM_V1' OR k.status <> 'ACTIVE' OR k.destroyed_at IS NOT NULL OR
     NEW.name <> ('risk-wrapped:v1:' || k.environment || ':' || k.organization_id || ':' || k.customer_tenant_id || ':' || k.id) OR NEW.name <> k.immutable_key_id THEN
    RAISE EXCEPTION 'Wrapped key scope unavailable';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER identity_risk_wrapped_key_guard BEFORE INSERT OR UPDATE OR DELETE ON identity_risk_wrapped_keys
  FOR EACH ROW EXECUTE FUNCTION identity_risk_wrapped_key_guard();

CREATE FUNCTION identity_risk_key_no_reactivation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (OLD.status <> 'ACTIVE' AND NEW.status='ACTIVE') OR (OLD.destroyed_at IS NOT NULL AND NEW.destroyed_at IS DISTINCT FROM OLD.destroyed_at) THEN
    RAISE EXCEPTION 'Retired or destroyed key cannot be reactivated';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER identity_risk_key_no_reactivation BEFORE UPDATE ON identity_risk_pseudonym_key_versions
  FOR EACH ROW EXECUTE FUNCTION identity_risk_key_no_reactivation();

-- Bounded, sanitized evidence only: at most one event/kind/version/minute. Not independent KMS audit.
CREATE TABLE identity_risk_key_events (
  key_version_id UUID NOT NULL REFERENCES identity_risk_pseudonym_key_versions(id) ON DELETE CASCADE,
  kind VARCHAR(20) NOT NULL CHECK (kind IN ('CREATED','SESSION_OPENED','SESSION_FAILED','RETIRED','DESTROYED')),
  bucket TIMESTAMPTZ(6) NOT NULL,
  correlation_id UUID NOT NULL,
  expires_at TIMESTAMPTZ(6) NOT NULL,
  PRIMARY KEY (key_version_id,kind,bucket),
  CHECK (expires_at=bucket+INTERVAL '90 days')
);
CREATE INDEX identity_risk_key_events_expiry ON identity_risk_key_events(expires_at);
