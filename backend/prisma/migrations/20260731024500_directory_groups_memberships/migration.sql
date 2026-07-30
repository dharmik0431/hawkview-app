ALTER TYPE "SyncResourceType" ADD VALUE 'GROUPS';

CREATE TABLE "directory_groups" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "customer_tenant_id" UUID NOT NULL,
    "microsoft_group_id" UUID NOT NULL,
    "display_name" VARCHAR(256) NOT NULL,
    "description" TEXT,
    "mail" VARCHAR(320),
    "mail_nickname" VARCHAR(256),
    "mail_enabled" BOOLEAN NOT NULL DEFAULT false,
    "security_enabled" BOOLEAN NOT NULL DEFAULT false,
    "group_types" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "visibility" VARCHAR(50),
    "first_seen_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "directory_groups_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "directory_group_memberships" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "customer_tenant_id" UUID NOT NULL,
    "directory_group_id" UUID NOT NULL,
    "directory_user_id" UUID NOT NULL,
    "first_seen_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "directory_group_memberships_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "directory_groups_customer_tenant_id_microsoft_group_id_key"
ON "directory_groups"("customer_tenant_id", "microsoft_group_id");

CREATE UNIQUE INDEX "directory_groups_id_customer_tenant_id_organization_id_key"
ON "directory_groups"("id", "customer_tenant_id", "organization_id");

CREATE INDEX "directory_groups_organization_id_customer_tenant_id_idx"
ON "directory_groups"("organization_id", "customer_tenant_id");

CREATE INDEX "directory_groups_customer_tenant_id_display_name_idx"
ON "directory_groups"("customer_tenant_id", "display_name");

CREATE UNIQUE INDEX "directory_group_memberships_directory_group_id_directory_user_id_key"
ON "directory_group_memberships"("directory_group_id", "directory_user_id");

CREATE UNIQUE INDEX "directory_users_id_customer_tenant_id_organization_id_key"
ON "directory_users"("id", "customer_tenant_id", "organization_id");

CREATE INDEX "directory_group_memberships_organization_id_customer_tenant_id_idx"
ON "directory_group_memberships"("organization_id", "customer_tenant_id");

CREATE INDEX "directory_group_memberships_customer_tenant_id_directory_user_id_idx"
ON "directory_group_memberships"("customer_tenant_id", "directory_user_id");

ALTER TABLE "directory_groups"
ADD CONSTRAINT "directory_groups_organization_id_fkey"
FOREIGN KEY ("organization_id") REFERENCES "organizations"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "directory_groups"
ADD CONSTRAINT "directory_groups_customer_tenant_id_organization_id_fkey"
FOREIGN KEY ("customer_tenant_id", "organization_id")
REFERENCES "customer_tenants"("id", "organization_id")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "directory_group_memberships"
ADD CONSTRAINT "directory_group_memberships_organization_id_fkey"
FOREIGN KEY ("organization_id") REFERENCES "organizations"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "directory_group_memberships"
ADD CONSTRAINT "directory_group_memberships_customer_tenant_id_organization_id_fkey"
FOREIGN KEY ("customer_tenant_id", "organization_id")
REFERENCES "customer_tenants"("id", "organization_id")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "directory_group_memberships"
ADD CONSTRAINT "directory_group_memberships_directory_group_id_fkey"
FOREIGN KEY ("directory_group_id", "customer_tenant_id", "organization_id")
REFERENCES "directory_groups"("id", "customer_tenant_id", "organization_id")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "directory_group_memberships"
ADD CONSTRAINT "directory_group_memberships_directory_user_id_fkey"
FOREIGN KEY ("directory_user_id", "customer_tenant_id", "organization_id")
REFERENCES "directory_users"("id", "customer_tenant_id", "organization_id")
ON DELETE CASCADE ON UPDATE CASCADE;
