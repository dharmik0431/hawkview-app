-- Additive sustained admission; no preferences or existing envelope bytes are changed.
SET lock_timeout = '5s';
CREATE TABLE alert_email_regular_epochs (
  activation_id UUID PRIMARY KEY,
  organization_id UUID NOT NULL,
  owner_user_id UUID NOT NULL,
  recipient_hash VARCHAR(64) NOT NULL,
  from_address VARCHAR(320) NOT NULL,
  app_origin VARCHAR(300) NOT NULL,
  declared_cutoff TIMESTAMPTZ(6) NOT NULL,
  effective_cutoff TIMESTAMPTZ(6) NOT NULL,
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),
  closed_at TIMESTAMPTZ(6),
  CHECK (effective_cutoff >= declared_cutoff AND effective_cutoff >= created_at),
  CHECK (closed_at IS NULL OR closed_at >= created_at)
);
CREATE UNIQUE INDEX alert_email_regular_epochs_one_active_org
  ON alert_email_regular_epochs (organization_id) WHERE closed_at IS NULL;
CREATE INDEX alert_email_regular_epochs_org_cutoff
  ON alert_email_regular_epochs (organization_id, effective_cutoff);
CREATE FUNCTION guard_alert_email_regular_epoch() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.activation_id, NEW.organization_id, NEW.owner_user_id, NEW.recipient_hash,
         NEW.from_address, NEW.app_origin, NEW.declared_cutoff, NEW.effective_cutoff, NEW.created_at)
     IS DISTINCT FROM
     ROW(OLD.activation_id, OLD.organization_id, OLD.owner_user_id, OLD.recipient_hash,
         OLD.from_address, OLD.app_origin, OLD.declared_cutoff, OLD.effective_cutoff, OLD.created_at)
     OR (OLD.closed_at IS NOT NULL AND NEW.closed_at IS DISTINCT FROM OLD.closed_at) THEN
    RAISE EXCEPTION 'EMAIL_EPOCH_IMMUTABLE';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER alert_email_regular_epoch_immutable BEFORE UPDATE ON alert_email_regular_epochs
  FOR EACH ROW EXECUTE FUNCTION guard_alert_email_regular_epoch();

ALTER TABLE alert_email_envelopes
  ADD COLUMN release_mode VARCHAR(10) NOT NULL DEFAULT 'controlled',
  ADD COLUMN regular_epoch_id UUID REFERENCES alert_email_regular_epochs(activation_id),
  ADD CONSTRAINT alert_email_envelopes_mode_check CHECK (
    (release_mode = 'controlled' AND regular_epoch_id IS NULL)
    OR (release_mode = 'regular' AND regular_epoch_id IS NOT NULL AND regular_epoch_id = activation_id));
ALTER TABLE alert_email_envelopes DROP CONSTRAINT alert_email_envelopes_activation_id_key;
CREATE UNIQUE INDEX alert_email_envelopes_controlled_activation_key
  ON alert_email_envelopes (activation_id) WHERE release_mode = 'controlled';
CREATE INDEX alert_email_envelopes_org_created_idx ON alert_email_envelopes (organization_id, created_at);
CREATE INDEX alert_send_attempts_started_at_email_idx ON alert_send_attempts (started_at);
ALTER TABLE alert_send_jobs ADD COLUMN email_stop_code VARCHAR(50);

-- The original one-hour envelope window, message/key/provider uniqueness, payload
-- size, recipient provenance and immutable frozen bytes remain enforced.
CREATE OR REPLACE FUNCTION guard_alert_email_envelope() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.message_id, NEW.activation_id, NEW.organization_id, NEW.owner_user_id,
         NEW.recipient_hash, NEW.starts_at, NEW.expires_at, NEW.from_address,
         NEW.app_origin, NEW.idempotency_key, NEW.created_at, NEW.release_mode, NEW.regular_epoch_id)
     IS DISTINCT FROM
     ROW(OLD.message_id, OLD.activation_id, OLD.organization_id, OLD.owner_user_id,
         OLD.recipient_hash, OLD.starts_at, OLD.expires_at, OLD.from_address,
         OLD.app_origin, OLD.idempotency_key, OLD.created_at, OLD.release_mode, OLD.regular_epoch_id)
     OR (OLD.payload IS NOT NULL AND ROW(NEW.payload, NEW.recipient_address, NEW.verified_at)
       IS DISTINCT FROM ROW(OLD.payload, OLD.recipient_address, OLD.verified_at))
     OR (OLD.provider_id IS NOT NULL AND NEW.provider_id IS DISTINCT FROM OLD.provider_id) THEN
    RAISE EXCEPTION 'EMAIL_ENVELOPE_IMMUTABLE';
  END IF;
  RETURN NEW;
END $$;
CREATE FUNCTION guard_regular_email_envelope_scope() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.release_mode = 'regular' AND NOT EXISTS (
    SELECT 1 FROM alert_email_regular_epochs e
    WHERE e.activation_id = NEW.regular_epoch_id AND e.organization_id = NEW.organization_id
      AND e.owner_user_id = NEW.owner_user_id AND e.recipient_hash = NEW.recipient_hash
      AND e.from_address = NEW.from_address AND e.app_origin = NEW.app_origin
      AND NEW.starts_at >= e.effective_cutoff
      AND (TG_OP <> 'INSERT' OR e.closed_at IS NULL)
  ) THEN RAISE EXCEPTION 'EMAIL_EPOCH_SCOPE_MISMATCH'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER alert_email_regular_envelope_scope BEFORE INSERT OR UPDATE ON alert_email_envelopes
  FOR EACH ROW EXECUTE FUNCTION guard_regular_email_envelope_scope();
ALTER TABLE alert_email_regular_epochs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE alert_email_regular_epochs FROM PUBLIC;
REVOKE ALL ON FUNCTION guard_alert_email_regular_epoch(), guard_regular_email_envelope_scope() FROM PUBLIC;
DO $$
DECLARE target_role text;
BEGIN
  FOREACH target_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = target_role) THEN
      EXECUTE format('REVOKE ALL ON TABLE public.alert_email_regular_epochs FROM %I', target_role);
    END IF;
  END LOOP;
END $$;
