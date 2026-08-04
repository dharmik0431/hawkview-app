CREATE TABLE "encrypted_secrets" (
    "id" UUID NOT NULL,
    "name" VARCHAR(200) NOT NULL,
    "ciphertext" BYTEA NOT NULL,
    "initialization_vector" BYTEA NOT NULL,
    "authentication_tag" BYTEA NOT NULL,
    "legacy_reference" VARCHAR(500),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "encrypted_secrets_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "encrypted_secrets_name_key"
ON "encrypted_secrets"("name");

CREATE UNIQUE INDEX "encrypted_secrets_legacy_reference_key"
ON "encrypted_secrets"("legacy_reference");
