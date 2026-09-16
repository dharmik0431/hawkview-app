SET lock_timeout = '5s';
CREATE TABLE "alert_email_envelopes" (
  "message_id" VARCHAR(400) PRIMARY KEY,
  "activation_id" UUID NOT NULL UNIQUE,
  "organization_id" UUID NOT NULL,
  "owner_user_id" UUID NOT NULL,
  "recipient_hash" VARCHAR(64) NOT NULL,
  "starts_at" TIMESTAMPTZ(6) NOT NULL,
  "expires_at" TIMESTAMPTZ(6) NOT NULL,
  "from_address" VARCHAR(320) NOT NULL,
  "app_origin" VARCHAR(300) NOT NULL,
  "recipient_address" VARCHAR(320),
  "verified_at" TIMESTAMPTZ(6),
  "payload" TEXT,
  "idempotency_key" VARCHAR(80) NOT NULL UNIQUE,
  "provider_id" VARCHAR(200) UNIQUE,
  "stop_code" VARCHAR(50),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "alert_email_envelopes_window_check" CHECK (
    expires_at > starts_at AND expires_at <= starts_at + interval '1 hour'),
  CONSTRAINT "alert_email_envelopes_payload_check" CHECK (
    num_nonnulls(recipient_address, verified_at, payload) IN (0, 3)
    AND (payload IS NULL OR octet_length(payload) <= 8192)),
  CONSTRAINT "alert_email_envelopes_address_check" CHECK (
    recipient_address IS NULL OR recipient_address = lower(btrim(recipient_address)))
);
CREATE INDEX "alert_email_envelopes_organization_id_expires_at_idx" ON "alert_email_envelopes" (organization_id, expires_at);
CREATE TABLE "alert_email_events" (
  "event_id" VARCHAR(200) PRIMARY KEY,
  "provider_id" VARCHAR(200) NOT NULL,
  "kind" VARCHAR(20) NOT NULL CHECK (kind IN ('DELIVERED', 'BOUNCED', 'COMPLAINED')),
  "bounce" VARCHAR(10),
  "occurred_at" TIMESTAMPTZ(6) NOT NULL,
  "recorded_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "alert_email_events_bounce_check" CHECK (
    (kind = 'BOUNCED' AND bounce IS NOT NULL AND bounce IN ('HARD', 'SOFT'))
    OR (kind <> 'BOUNCED' AND bounce IS NULL))
);
CREATE INDEX "alert_email_events_provider_id_idx" ON "alert_email_events" (provider_id);
CREATE FUNCTION guard_alert_email_envelope() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.message_id, NEW.activation_id, NEW.organization_id, NEW.owner_user_id,
         NEW.recipient_hash, NEW.starts_at, NEW.expires_at, NEW.from_address,
         NEW.app_origin, NEW.idempotency_key, NEW.created_at)
     IS DISTINCT FROM
     ROW(OLD.message_id, OLD.activation_id, OLD.organization_id, OLD.owner_user_id,
         OLD.recipient_hash, OLD.starts_at, OLD.expires_at, OLD.from_address,
         OLD.app_origin, OLD.idempotency_key, OLD.created_at)
     OR (OLD.payload IS NOT NULL AND ROW(NEW.payload, NEW.recipient_address, NEW.verified_at)
       IS DISTINCT FROM ROW(OLD.payload, OLD.recipient_address, OLD.verified_at))
     OR (OLD.provider_id IS NOT NULL AND NEW.provider_id IS DISTINCT FROM OLD.provider_id) THEN
    RAISE EXCEPTION 'EMAIL_ENVELOPE_IMMUTABLE';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "alert_email_envelope_immutable" BEFORE UPDATE ON "alert_email_envelopes"
  FOR EACH ROW EXECUTE FUNCTION guard_alert_email_envelope();
ALTER TABLE "alert_email_envelopes" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "alert_email_events" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE "alert_email_envelopes", "alert_email_events" FROM PUBLIC;
REVOKE ALL ON FUNCTION guard_alert_email_envelope() FROM PUBLIC;
DO $$
DECLARE target_role text;
BEGIN
  FOREACH target_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = target_role) THEN
      EXECUTE format('REVOKE ALL ON TABLE public.alert_email_envelopes, public.alert_email_events FROM %I', target_role);
    END IF;
  END LOOP;
END $$;
