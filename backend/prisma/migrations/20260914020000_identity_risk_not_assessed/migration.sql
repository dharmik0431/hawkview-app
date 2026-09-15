-- A NATIVE FINDING MUST BE ABLE TO SAY IT DID NOT ASSESS SOMETHING.
--
-- severity, confidence and coverage are NOT NULL on both identity_risk_findings and
-- identity_risk_matched_results, and every permitted member of all three vocabularies asserts
-- something. A detector that does not compute them therefore had no way to write a row at all --
-- six values across two tables, none of which it determined.
--
-- confidence is the one that matters most: it is confidence OF COMPROMISE, and the accepted
-- mapping for the native detector says that claim is not made. Writing 'LOW' would make the
-- claim in the row while the document beside it says the claim is not made.
--
-- WHY A NAMED MEMBER RATHER THAN NULLABLE COLUMNS. A null says nothing, and the next reader has
-- to guess between "never assessed", "not applicable" and "lost on the way in". NOT_ASSESSED
-- says which. That distinction is the same one this release spent a unit separating for absent
-- versus explicitly-null directory properties, and collapsing it here would be that defect in a
-- new place.
--
-- MONOTONICALLY WIDENING. Every previously permitted value stays permitted, so no existing row
-- can violate the new constraint and no backfill is required. The pattern follows
-- alert_send_jobs_state_check, which went 5 -> 6 -> 7 members the same way.

DO $$
BEGIN
  ALTER TABLE "identity_risk_findings" DROP CONSTRAINT IF EXISTS "identity_risk_finding_severity_check";
  ALTER TABLE "identity_risk_findings" ADD CONSTRAINT "identity_risk_finding_severity_check"
    CHECK ("severity" IN ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL', 'NOT_ASSESSED'));

  ALTER TABLE "identity_risk_findings" DROP CONSTRAINT IF EXISTS "identity_risk_finding_confidence_check";
  ALTER TABLE "identity_risk_findings" ADD CONSTRAINT "identity_risk_finding_confidence_check"
    CHECK ("confidence" IN ('LOW', 'MEDIUM', 'HIGH', 'NOT_ASSESSED'));

  ALTER TABLE "identity_risk_findings" DROP CONSTRAINT IF EXISTS "identity_risk_finding_coverage_check";
  ALTER TABLE "identity_risk_findings" ADD CONSTRAINT "identity_risk_finding_coverage_check"
    CHECK ("coverage" IN ('FULL', 'PARTIAL', 'NOT_ASSESSED'));

  ALTER TABLE "identity_risk_matched_results" DROP CONSTRAINT IF EXISTS "identity_risk_matched_severity_check";
  ALTER TABLE "identity_risk_matched_results" ADD CONSTRAINT "identity_risk_matched_severity_check"
    CHECK ("severity" IN ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL', 'NOT_ASSESSED'));

  ALTER TABLE "identity_risk_matched_results" DROP CONSTRAINT IF EXISTS "identity_risk_matched_confidence_check";
  ALTER TABLE "identity_risk_matched_results" ADD CONSTRAINT "identity_risk_matched_confidence_check"
    CHECK ("confidence" IN ('LOW', 'MEDIUM', 'HIGH', 'NOT_ASSESSED'));

  ALTER TABLE "identity_risk_matched_results" DROP CONSTRAINT IF EXISTS "identity_risk_matched_coverage_check";
  ALTER TABLE "identity_risk_matched_results" ADD CONSTRAINT "identity_risk_matched_coverage_check"
    CHECK ("coverage" IN ('FULL', 'PARTIAL', 'NOT_ASSESSED'));
END $$;
