-- Preserve disputed evidence without treating it as OPEN or falsely RESOLVED.
-- Additive lifecycle state; legacy read routes exclude UNKNOWN rows.
ALTER TABLE "identity_risk_findings" DROP CONSTRAINT "identity_risk_finding_state_check";
ALTER TABLE "identity_risk_findings" ADD CONSTRAINT "identity_risk_finding_state_check"
  CHECK ("state" IN ('OPEN', 'UPDATED', 'RESOLVED', 'EXPIRED', 'UNKNOWN'));
