-- Admit the rebuilt engine's run status, and give it the completion guarantee the
-- old status already had.
--
-- WHY A NEW STATUS RATHER THAN REUSING 'COMPLETED'. The live reader at
-- identity-risk.service.ts selects the newest run with status = 'COMPLETED' and
-- has NO engineVersion filter. A rebuilt-engine run written as 'COMPLETED' would
-- be served to a customer by the running product, carrying a payload shaped for a
-- different engine. The distinct value is the entire mitigation; widening this
-- constraint is correct, collapsing the status is not.
--
-- WHY BOTH CONSTRAINTS. The live completion_check reads
--   (status = 'COMPLETED' AND completed_at IS NOT NULL) OR status <> 'COMPLETED'
-- so a new status satisfies the second arm trivially and inherits NO completed-at
-- guarantee. That does not crash the reader — read-run.ts correctly returns NO_RUN
-- on a null completedAt — which makes the consequence worse than a crash: a run
-- that completed successfully would be reported as never having run, and a tenant
-- that was evaluated would be indistinguishable from one that never was. That is
-- this feature's central defect, reachable through a constraint gap.
--
-- SAFE ON EXISTING ROWS, checked rather than assumed: production holds 2,008 runs,
-- every one 'COMPLETED', and zero with a null completed_at. Neither constraint can
-- fail on deploy — which matters because the API container runs
-- `db:migrate:deploy && npm start`, so a migration that fails on existing data
-- takes the API down, a worse outcome than the bug it fixes.
ALTER TABLE "identity_risk_evaluation_runs"
  DROP CONSTRAINT "identity_risk_runs_status_check",
  ADD CONSTRAINT "identity_risk_runs_status_check"
    CHECK ("status" IN ('RUNNING', 'COMPLETED', 'FAILED', 'COMPLETED_EVALUATION_CORE'));

ALTER TABLE "identity_risk_evaluation_runs"
  DROP CONSTRAINT "identity_risk_runs_completion_check",
  ADD CONSTRAINT "identity_risk_runs_completion_check"
    CHECK (
      ("status" IN ('COMPLETED', 'COMPLETED_EVALUATION_CORE') AND "completed_at" IS NOT NULL)
      OR "status" NOT IN ('COMPLETED', 'COMPLETED_EVALUATION_CORE')
    );
