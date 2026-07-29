-- AlterTable
ALTER TABLE "users"
ADD COLUMN "identity_platform_user_id" VARCHAR(128);

-- CreateIndex
CREATE UNIQUE INDEX "users_identity_platform_user_id_key"
ON "users"("identity_platform_user_id");
