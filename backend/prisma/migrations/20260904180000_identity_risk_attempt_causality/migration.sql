-- One current causal head per tenant/environment. No clock-based ordering.
-- No historical-success backfill: unlinked evidence must await a fresh attempt.
CREATE TABLE identity_risk_attempt_heads (
  organization_id UUID NOT NULL,
  customer_tenant_id UUID NOT NULL,
  environment VARCHAR(40) NOT NULL CHECK (environment ~ '^[a-z][a-z0-9-]{0,39}$'),
  attempt_id UUID NOT NULL,
  completed_run_id UUID,
  PRIMARY KEY (organization_id, customer_tenant_id, environment),
  FOREIGN KEY (customer_tenant_id, organization_id)
    REFERENCES customer_tenants(id, organization_id) ON DELETE CASCADE
);
-- No run/event FK: prior finite retention remains independent. Missing/expired
-- referenced runs read unavailable. No existing data is deleted or backfilled.
ALTER TABLE identity_risk_attempt_heads ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON identity_risk_attempt_heads FROM PUBLIC;
