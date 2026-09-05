-- Physical eligibility is original run.created_at + 2160 hours, independent
-- of expires_at (current-read/source validity). No age/expiry data rewrite:
-- existing day-8 no-source rows remain unavailable but retained through day 90.
CREATE INDEX identity_risk_runs_history_scope ON identity_risk_evaluation_runs
  (organization_id,customer_tenant_id,created_at,id);
CREATE INDEX identity_risk_runs_history_scan ON identity_risk_evaluation_runs (created_at,id);
CREATE INDEX identity_risk_findings_matched_parent ON identity_risk_findings (matched_result_id,id);

CREATE TABLE identity_risk_history_cursors (
  scope_key VARCHAR(64) PRIMARY KEY,
  after_tenant_id UUID,
  lease_id UUID,
  lease_expires_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
ALTER TABLE identity_risk_history_cursors ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON identity_risk_history_cursors FROM PUBLIC;

CREATE TABLE identity_risk_history_tenant_cursors (
  organization_id UUID NOT NULL,
  customer_tenant_id UUID NOT NULL,
  after_created_at TIMESTAMPTZ,
  after_run_id UUID,
  PRIMARY KEY (organization_id,customer_tenant_id),
  FOREIGN KEY (customer_tenant_id,organization_id) REFERENCES customer_tenants(id,organization_id) ON DELETE CASCADE
);
ALTER TABLE identity_risk_history_tenant_cursors ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON identity_risk_history_tenant_cursors FROM PUBLIC;

-- No implicit graph cascades from a retention DELETE. Account/tenant deletion
-- semantics remain on their separate organization/tenant foreign keys.
ALTER TABLE identity_risk_rule_coverage DROP CONSTRAINT identity_risk_rule_coverage_evaluation_run_id_organization_fkey;
ALTER TABLE identity_risk_rule_coverage ADD CONSTRAINT identity_risk_rule_coverage_evaluation_run_id_organization_fkey
 FOREIGN KEY (evaluation_run_id,organization_id,customer_tenant_id) REFERENCES identity_risk_evaluation_runs(id,organization_id,customer_tenant_id) ON DELETE NO ACTION;
ALTER TABLE identity_risk_matched_results DROP CONSTRAINT identity_risk_matched_results_evaluation_run_id_organizati_fkey;
ALTER TABLE identity_risk_matched_results ADD CONSTRAINT identity_risk_matched_results_evaluation_run_id_organizati_fkey
 FOREIGN KEY (evaluation_run_id,organization_id,customer_tenant_id) REFERENCES identity_risk_evaluation_runs(id,organization_id,customer_tenant_id) ON DELETE NO ACTION;
ALTER TABLE identity_risk_findings DROP CONSTRAINT identity_risk_findings_matched_result_id_organization_id_c_fkey;
ALTER TABLE identity_risk_findings ADD CONSTRAINT identity_risk_findings_matched_result_id_organization_id_c_fkey
 FOREIGN KEY (matched_result_id,organization_id,customer_tenant_id) REFERENCES identity_risk_matched_results(id,organization_id,customer_tenant_id) ON DELETE NO ACTION;
