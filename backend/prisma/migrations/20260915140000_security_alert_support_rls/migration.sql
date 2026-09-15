-- Restore the existing deny-all public-schema boundary for these later tables.
-- The backend table owner keeps access: ENABLE, not FORCE, and no policies.
SET lock_timeout = '5s';

ALTER TABLE "public"."alert_delivery_outcomes" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."alert_webhook_rejections" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."alert_withheld_notices" ENABLE ROW LEVEL SECURITY;

REVOKE ALL PRIVILEGES ON TABLE
  "public"."alert_delivery_outcomes",
  "public"."alert_webhook_rejections",
  "public"."alert_withheld_notices"
FROM PUBLIC;

DO $$
DECLARE
  target_role text;
BEGIN
  FOREACH target_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = target_role) THEN
      EXECUTE format(
        'REVOKE ALL PRIVILEGES ON TABLE public.alert_delivery_outcomes, public.alert_webhook_rejections, public.alert_withheld_notices FROM %I',
        target_role);
    END IF;
  END LOOP;
END
$$;
