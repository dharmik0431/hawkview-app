CREATE TYPE "SyncResourceType" AS ENUM ('USERS');
CREATE TYPE "SyncStateStatus" AS ENUM ('IDLE', 'RUNNING', 'SUCCEEDED', 'FAILED');

CREATE TABLE "directory_users" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "customer_tenant_id" UUID NOT NULL,
    "microsoft_user_id" UUID NOT NULL,
    "display_name" VARCHAR(256) NOT NULL,
    "user_principal_name" VARCHAR(320) NOT NULL,
    "mail" VARCHAR(320),
    "account_enabled" BOOLEAN NOT NULL DEFAULT true,
    "user_type" VARCHAR(50),
    "first_seen_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    CONSTRAINT "directory_users_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "sync_states" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "customer_tenant_id" UUID NOT NULL,
    "resource_type" "SyncResourceType" NOT NULL,
    "status" "SyncStateStatus" NOT NULL DEFAULT 'IDLE',
    "delta_link" TEXT,
    "last_attempt_at" TIMESTAMPTZ(6),
    "last_successful_at" TIMESTAMPTZ(6),
    "last_error_code" VARCHAR(100),
    "last_error_message" TEXT,
    "consecutive_failures" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    CONSTRAINT "sync_states_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "directory_users_customer_tenant_id_microsoft_user_id_key"
ON "directory_users"("customer_tenant_id", "microsoft_user_id");

CREATE INDEX "directory_users_organization_id_customer_tenant_id_deleted_at_idx"
ON "directory_users"("organization_id", "customer_tenant_id", "deleted_at");

CREATE INDEX "directory_users_customer_tenant_id_user_principal_name_idx"
ON "directory_users"("customer_tenant_id", "user_principal_name");

CREATE UNIQUE INDEX "sync_states_customer_tenant_id_resource_type_key"
ON "sync_states"("customer_tenant_id", "resource_type");

CREATE INDEX "sync_states_organization_id_status_idx"
ON "sync_states"("organization_id", "status");

ALTER TABLE "directory_users"
ADD CONSTRAINT "directory_users_organization_id_fkey"
FOREIGN KEY ("organization_id") REFERENCES "organizations"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "directory_users"
ADD CONSTRAINT "directory_users_customer_tenant_id_organization_id_fkey"
FOREIGN KEY ("customer_tenant_id", "organization_id")
REFERENCES "customer_tenants"("id", "organization_id")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "sync_states"
ADD CONSTRAINT "sync_states_organization_id_fkey"
FOREIGN KEY ("organization_id") REFERENCES "organizations"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "sync_states"
ADD CONSTRAINT "sync_states_customer_tenant_id_organization_id_fkey"
FOREIGN KEY ("customer_tenant_id", "organization_id")
REFERENCES "customer_tenants"("id", "organization_id")
ON DELETE CASCADE ON UPDATE CASCADE;
