-- Persist the findings a run produced, each signal carrying its own count, its
-- own recency, and whether that count is a floor.
--
-- NULLABLE, AND DELIBERATELY WITHOUT A DEFAULT — the same shape as
-- evaluation_coverage beside it, for the same reason. A DEFAULT '[]' would
-- convert every run written before this column existed into "this run found
-- nothing", which reads as a clean tenant, permanently and with nothing later
-- able to tell a backfilled default from a recorded measurement. That is the
-- confident-zero defect written into storage.
--
-- NULL therefore means "no findings record was written" and decodes to its own
-- case. See decodeRunFindings, which refuses to read absence as an empty list.
--
-- JSONB rather than relational columns, and NOT the existing
-- identity_risk_matched_results table. That table requires severity, confidence
-- and coverage as NOT NULL strings, and this engine computes none of the three;
-- filling them to satisfy a constraint would put three fabricated values per
-- finding into the tables an MSP acts from. A nullable JSONB column has no
-- field to satisfy, so there is nothing to invent and no later pressure to
-- invent it.
--
-- Named for what it holds rather than for the engine that writes it: the column
-- outlives the engine version, and evaluation_coverage set that precedent on
-- this row.
ALTER TABLE "identity_risk_evaluation_runs"
  ADD COLUMN "evaluation_findings" JSONB;

COMMENT ON COLUMN "identity_risk_evaluation_runs"."evaluation_findings" IS
  'Findings for the run, each signal carrying its own count, recency and ceiling. NULL means no findings record was written, which is not the same as a run that found nothing. Never defaulted.';
