-- One durable position for the authenticated scheduled tenant scan. The ID is
-- a position only, not a foreign key: deleting a tenant must not reset the scan.
CREATE TABLE scheduled_sync_cursors (
  scope_key VARCHAR(40) PRIMARY KEY,
  after_tenant_id UUID,
  revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
  updated_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
ALTER TABLE scheduled_sync_cursors ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON scheduled_sync_cursors FROM PUBLIC;
