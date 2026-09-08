-- Add only the reviewed authentication v2 tuple; keep all legacy v1 checks.
-- No widening to arbitrary future rule versions or alteration of existing rows.
ALTER TABLE "identity_risk_rule_coverage" DROP CONSTRAINT "identity_risk_coverage_rule_check";
ALTER TABLE "identity_risk_rule_coverage" ADD CONSTRAINT "identity_risk_coverage_rule_check"
  CHECK ("rule_id" ~ '^HV-ID-(EXP|CHG|APP|MBX|AUTH)-[0-9]{3}\.v1$' OR "rule_id" = 'HV-ID-AUTH-005.v2');
ALTER TABLE "identity_risk_matched_results" DROP CONSTRAINT "identity_risk_matched_rule_check";
ALTER TABLE "identity_risk_matched_results" ADD CONSTRAINT "identity_risk_matched_rule_check"
  CHECK ("rule_id" ~ '^HV-ID-(EXP|CHG|APP|MBX|AUTH)-[0-9]{3}\.v1$' OR "rule_id" = 'HV-ID-AUTH-005.v2');
ALTER TABLE "identity_risk_findings" DROP CONSTRAINT "identity_risk_finding_rule_check";
ALTER TABLE "identity_risk_findings" ADD CONSTRAINT "identity_risk_finding_rule_check"
  CHECK (("rule_id" ~ '^HV-ID-(EXP|CHG|APP|MBX|AUTH)-[0-9]{3}\.v1$' AND "rule_version" = 'v1')
    OR ("rule_id" = 'HV-ID-AUTH-005.v2' AND "rule_version" = 'v2'));
-- Align storage with the existing bounded confidence contract (not severity).
ALTER TABLE "identity_risk_matched_results" DROP CONSTRAINT "identity_risk_matched_confidence_check";
ALTER TABLE "identity_risk_matched_results" ADD CONSTRAINT "identity_risk_matched_confidence_check"
  CHECK ("confidence" IN ('LOW', 'MEDIUM', 'HIGH'));
ALTER TABLE "identity_risk_findings" DROP CONSTRAINT "identity_risk_finding_confidence_check";
ALTER TABLE "identity_risk_findings" ADD CONSTRAINT "identity_risk_finding_confidence_check"
  CHECK ("confidence" IN ('LOW', 'MEDIUM', 'HIGH'));
