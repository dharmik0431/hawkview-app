-- Persist the coverage vector a claim rests on: how many events applied, and
-- where the rest went, by reason.
--
-- NULLABLE, AND DELIBERATELY WITHOUT A DEFAULT.
--
-- Every run written before this column existed has no accounting, and that is a
-- different fact from a run that assessed nothing. A DEFAULT '{}' — the shape
-- the neighbouring "aggregate" column uses — would silently convert every
-- pre-existing row into "we assessed nothing and found nothing", which reads as
-- a clean tenant. That is the confident-zero defect this work exists to remove,
-- written into storage where it is permanent and indistinguishable after the
-- fact: nothing later can tell a backfilled default from a recorded measurement.
--
-- NULL therefore means "no accounting recorded" and decodes to its own case.
-- See decodeCoverage in backend/src/evaluation-core/coverage-record.ts, which
-- refuses to read absence as zero.
--
-- One JSONB object rather than a column per reason, for two reasons:
--   1. The reason vocabulary is still growing. A column per reason means a
--      migration every time it changes, which guarantees it stops changing.
--   2. Named buckets keep the partition visible. Adjacent integer columns
--      invite a SUM that adds could-not-process to does-not-apply, and never
--      summing those is the constraint the whole coverage vector protects.
--
-- The object carries its own version tag inside it; readers refuse a version
-- they do not recognise rather than reading it optimistically.
ALTER TABLE "identity_risk_evaluation_runs"
  ADD COLUMN "evaluation_coverage" JSONB;

COMMENT ON COLUMN "identity_risk_evaluation_runs"."evaluation_coverage" IS
  'Coverage vector for the run. NULL means no accounting was recorded, which is not the same as accounting that recorded zero. Never defaulted.';
