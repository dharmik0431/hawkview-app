ALTER TABLE "users"
  RENAME COLUMN "identity_platform_user_id" TO "auth_provider_user_id";

ALTER INDEX "users_identity_platform_user_id_key"
  RENAME TO "users_auth_provider_user_id_key";
