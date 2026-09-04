-- Internal registry only. No keys, identities or fabricated legacy versions are inserted.
CREATE TABLE "identity_risk_pseudonym_key_versions" (
  "id" UUID NOT NULL,
  "organization_id" UUID NOT NULL,
  "customer_tenant_id" UUID NOT NULL,
  "environment" VARCHAR(40) NOT NULL,
  "provider" VARCHAR(40) NOT NULL CHECK ("provider" = 'AWS_KMS_HMAC_256'),
  "immutable_key_id" VARCHAR(2048) NOT NULL,
  "status" VARCHAR(20) NOT NULL CHECK ("status" IN ('ACTIVE', 'RETIRED', 'DISABLED')),
  "activated_at" TIMESTAMPTZ(6),
  "retired_at" TIMESTAMPTZ(6),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "identity_risk_pseudonym_key_versions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "identity_risk_keys_org_fk" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE,
  CONSTRAINT "identity_risk_keys_tenant_fk" FOREIGN KEY ("customer_tenant_id", "organization_id") REFERENCES "customer_tenants"("id", "organization_id") ON DELETE CASCADE,
  CONSTRAINT "identity_risk_keys_scope_id" UNIQUE ("id", "organization_id", "customer_tenant_id")
);
CREATE INDEX "identity_risk_keys_scope_status" ON "identity_risk_pseudonym_key_versions" ("organization_id", "customer_tenant_id", "environment", "status");
CREATE UNIQUE INDEX "identity_risk_keys_one_active" ON "identity_risk_pseudonym_key_versions" ("organization_id", "customer_tenant_id", "environment") WHERE "status" = 'ACTIVE';
-- No implicit shared-key exception across tenants/environments or fake rotation of the same physical key.
CREATE UNIQUE INDEX "identity_risk_keys_physical_key" ON "identity_risk_pseudonym_key_versions" ("provider", "immutable_key_id");
-- Physical key identity/version/scope are immutable, including after retirement.
CREATE FUNCTION identity_risk_key_identity_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(OLD.id, OLD.organization_id, OLD.customer_tenant_id, OLD.environment, OLD.provider, OLD.immutable_key_id)
     IS DISTINCT FROM ROW(NEW.id, NEW.organization_id, NEW.customer_tenant_id, NEW.environment, NEW.provider, NEW.immutable_key_id) THEN
    RAISE EXCEPTION 'Identity risk key identity is immutable';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER identity_risk_key_identity_immutable BEFORE UPDATE ON "identity_risk_pseudonym_key_versions" FOR EACH ROW EXECUTE FUNCTION identity_risk_key_identity_immutable();
ALTER TABLE "identity_risk_evaluation_runs" ADD COLUMN "pseudonym_key_version_id" UUID, ADD COLUMN "source_observed_at" TIMESTAMPTZ(6);
ALTER TABLE "identity_risk_evaluation_runs" ADD CONSTRAINT "identity_risk_run_key_scope_fk"
  FOREIGN KEY ("pseudonym_key_version_id", "organization_id", "customer_tenant_id")
  REFERENCES "identity_risk_pseudonym_key_versions" ("id", "organization_id", "customer_tenant_id") ON DELETE NO ACTION;
CREATE INDEX "identity_risk_runs_key_version" ON "identity_risk_evaluation_runs" ("pseudonym_key_version_id", "organization_id", "customer_tenant_id");
