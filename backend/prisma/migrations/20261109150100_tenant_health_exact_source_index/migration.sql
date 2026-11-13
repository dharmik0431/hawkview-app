-- HAW-70 inactive foundation, phase 2/6. This migration intentionally has
-- one statement and no transaction: Prisma Migrate v7 PostgreSQL SQL files
-- are not automatically transaction-wrapped. Concurrent builds avoid a
-- long ACCESS EXCLUSIVE lock on historical snapshots.
-- If this fails and leaves an INVALID index, stop; do not retry or deploy
-- until disposable-PostgreSQL CI and a reviewed recovery path prove it safe.
CREATE UNIQUE INDEX CONCURRENTLY "tenant_health_snapshots_exact_source_key"
  ON "tenant_health_snapshots"
    ("id", "organization_id", "customer_tenant_id",
     "source_incarnation", "source_revision", "observation_sequence");
