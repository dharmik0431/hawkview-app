-- Internal scheduler position only. No user identifiers, credentials, or sources.
-- Deliberately not a tenant FK: deletion must not reset a fair scan to its prefix.
CREATE TABLE identity_risk_scheduler_cursors (
  environment VARCHAR(40) PRIMARY KEY CHECK (environment ~ '^[a-z][a-z0-9-]{0,39}$'),
  after_tenant_id UUID,
  lease_id UUID,
  lease_expires_at TIMESTAMPTZ(6),
  CHECK ((lease_id IS NULL) = (lease_expires_at IS NULL)),
  updated_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
ALTER TABLE identity_risk_scheduler_cursors ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON identity_risk_scheduler_cursors FROM PUBLIC;
