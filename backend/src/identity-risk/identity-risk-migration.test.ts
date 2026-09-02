import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'

const sql = readFileSync(new URL(
  '../../prisma/migrations/20260902090000_add_identity_risk_platform/migration.sql',
  import.meta.url,
), 'utf8')

test('migration enforces compound tenant relationships throughout risk storage', () => {
  assert.match(
    sql,
    /FOREIGN KEY \("customer_tenant_id", "organization_id"\) REFERENCES "customer_tenants"\("id", "organization_id"\)/g,
  )
  assert.match(
    sql,
    /FOREIGN KEY \("evaluation_run_id", "organization_id", "customer_tenant_id"\) REFERENCES "identity_risk_evaluation_runs"/,
  )
  assert.match(
    sql,
    /FOREIGN KEY \("matched_result_id", "organization_id", "customer_tenant_id"\) REFERENCES "identity_risk_matched_results"/,
  )
  assert.match(sql, /identity_risk_evaluation_runs_scope_key/)
  assert.match(sql, /identity_risk_matched_results_scope_key/)
  assert.match(sql, /identity_risk_findings_scope_key/)
})

test('migration locks safety-control semantics and bounded non-negative counts', () => {
  assert.match(
    sql,
    /"control_type" IN \('ALERT_DELIVERY_DISABLED', 'EVALUATION_HARD_DISABLED'\)/,
  )
  assert.match(
    sql,
    /"scope_type" = 'GLOBAL' AND "organization_id" IS NULL AND "customer_tenant_id" IS NULL/,
  )
  assert.match(sql, /"eligible_count" BETWEEN 0 AND 1000000/)
  assert.match(sql, /"not_evaluated_count" BETWEEN 0 AND 1000000/)
  assert.match(sql, /identity_risk_operational_events_event_key/)
  assert.match(sql, /identity_risk_runs_completion_check/)
  assert.match(sql, /identity_risk_finding_state_check/)
  assert.match(sql, /identity_risk_matched_coverage_check/)
})

test('migration stores only bounded structured risk rows and no raw provider payload', () => {
  assert.doesNotMatch(sql, /raw_payload|access_token|refresh_token|password|user_principal_name/i)
  assert.match(sql, /"rule_id" VARCHAR\(150\)/)
  assert.match(sql, /"subject_id" VARCHAR\(128\)/)
  assert.match(sql, /"reason_code" VARCHAR\(80\)/)
})
