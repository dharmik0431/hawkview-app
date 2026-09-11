-- Record WHICH key sealed each stored secret, so the key can be changed.
--
-- Today it cannot be. `SECRET_ENCRYPTION_KEY` is read straight out of the
-- environment and used for every seal and every open, and nothing anywhere
-- records which key a given row was sealed with. So rotating that variable makes
-- every existing row permanently undecryptable, and the failure is indirect: the
-- GCM authentication tag fails, the service reports "the stored credential could
-- not be decrypted", and that message is identical to the one a genuinely
-- corrupt row produces. You would not be able to tell a rotation mistake from
-- data loss, and there would be nothing to roll back to.
--
-- What is at stake is small in row count and large in reach. Two rows exist: the
-- Microsoft client secret that reads all five customer tenants, and the key that
-- signs consent-state tokens. If either is ever exposed, the correct response is
-- to rotate — which is precisely the operation that currently destroys them.
--
-- THIS MIGRATION CANNOT MAKE ANY SECRET UNREADABLE. It adds a column and touches
-- no ciphertext, no initialization vector and no authentication tag. Every
-- existing row is, by definition, sealed with the key that is configured right
-- now, which this records as version 1.
--
-- THE DEFAULT IS ADDED AND THEN IMMEDIATELY DROPPED, and that is the one subtle
-- thing here. The default exists only to label the rows that already exist. If it
-- survived, a future writer that forgot to set the version would silently get a
-- row LABELLED version 1 while its bytes were sealed with version 2 — and a
-- mislabelled row is exactly as unreadable as an unlabelled one, discovered later
-- and with no way to tell which key to try. With no default, such a writer
-- violates NOT NULL and fails immediately and loudly. The Prisma model therefore
-- also declares no default, so the application must state the version on every
-- write.
--
-- No index. The table holds two rows, and rotation status reads all of them.
ALTER TABLE "encrypted_secrets"
  ADD COLUMN "key_version" INTEGER NOT NULL DEFAULT 1;

ALTER TABLE "encrypted_secrets"
  ALTER COLUMN "key_version" DROP DEFAULT;

ALTER TABLE "encrypted_secrets"
  ADD CONSTRAINT "encrypted_secrets_key_version_check" CHECK ("key_version" >= 1);

COMMENT ON COLUMN "encrypted_secrets"."key_version" IS
  'Which SECRET_ENCRYPTION_KEY version sealed this row. Deliberately has no column default: a row whose version is not stated is a row nobody can reliably open, so a writer that omits it must fail rather than be guessed for. Version 1 is the key configured when this column was added.';
