// QA PROBE — does `rotationStatus()` OPEN each secret, or does it read the
// version column and believe it?
//
// WHY THE SHIPPED TEST CANNOT ANSWER THIS. In
// `secret-store.database-integration.test.ts` every row is genuinely readable,
// so a `rotationStatus()` that returned `readable: true` from the column alone
// would pass it unchanged. The assertion and the defect are compatible.
//
// The question only becomes answerable with a row that is LABELLED CURRENT and
// CANNOT BE OPENED. That is the exact state a rotation can leave behind, and the
// exact state this function exists to detect — someone reads `complete: true`
// and deletes SECRET_ENCRYPTION_KEY_PREVIOUS, and the bytes are gone. There is no
// backup of a value that only exists sealed.
//
// So: store a secret normally, corrupt its ciphertext in place while leaving
// `key_version` at the current version, and ask.
//
//   opens the rows      -> unreadable 1, complete false
//   reads the column    -> unreadable 0, complete TRUE  <- the dangerous answer
//
// Synthetic keys, disposable database, no production secret is ever touched.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { PrismaService } from '../prisma/prisma.service.js'
import { SecretStoreService } from './secret-store.service.js'
import {
  CURRENT_KEY_VARIABLE,
  KEY_VERSION_VARIABLE,
  PREVIOUS_KEY_VARIABLE,
} from './secret-encryption-keys.js'
import { PLATFORM_OWNED } from './secret-owner.js'

const url = new URL(process.env.DATABASE_URL ?? '')
assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname), 'Disposable loopback DB only')
// The shipped test checks the host but not the database name. Both, here.
assert.match(url.pathname, /test|qa|^\/hawkview_ci$/i, 'Explicit test/QA database only')

const KEY_ONE = '11'.repeat(32)
const run = randomUUID().slice(0, 8)
const intact = `qa-${run}-intact`
const corrupted = `qa-${run}-corrupted`

process.env[CURRENT_KEY_VARIABLE] = KEY_ONE
delete process.env[KEY_VERSION_VARIABLE]
delete process.env[PREVIOUS_KEY_VARIABLE]

const prisma = new PrismaService()
await prisma.$connect()
const client = new pg.Client({ connectionString: url.toString() })
await client.connect()

try {
  const service = new SecretStoreService(prisma)
  await service.store(intact, 'intact-value', PLATFORM_OWNED)
  await service.store(corrupted, 'doomed-value', PLATFORM_OWNED)

  // Corrupt the BYTES ONLY. `key_version` is left exactly as stored, so the row
  // still claims to be sealed with the current key. Nothing about its label is
  // wrong — only its contents, which is the whole point.
  const before = await client.query(
    'SELECT key_version FROM encrypted_secrets WHERE name = $1', [corrupted])
  await client.query(
    `UPDATE encrypted_secrets SET ciphertext = decode(repeat('ab', 48), 'hex') WHERE name = $1`,
    [corrupted])
  const after = await client.query(
    'SELECT key_version FROM encrypted_secrets WHERE name = $1', [corrupted])
  const labelUnchanged = before.rows[0]?.key_version === after.rows[0]?.key_version

  const status = await service.rotationStatus()
  const mine = status.secrets.filter((row) => [intact, corrupted].includes(row.name))
  const intactRow = mine.find((row) => row.name === intact) ?? null
  const corruptedRow = mine.find((row) => row.name === corrupted) ?? null

  // GUARD. Both rows must be present and the intact one must open, or the probe
  // is measuring a setup failure rather than the function under test.
  const inputCanFail =
    mine.length === 2 && intactRow?.readable === true && labelUnchanged

  const caughtIt = corruptedRow?.readable === false && status.complete === false

  console.log(JSON.stringify({
    QA_ROTATION_STATUS: {
      currentVersion: status.currentVersion,
      intact: intactRow,
      corrupted: corruptedRow,
      corruptedRowStillClaimsVersion: after.rows[0]?.key_version ?? null,
      labelUnchangedByCorruption: labelUnchanged,
      unreadable: status.unreadable,
      resealPending: status.resealPending,
      complete: status.complete,
      inputCanFail,
      verdict: !inputCanFail
        ? 'INCONCLUSIVE - setup did not produce one intact and one corrupted row at an unchanged version'
        : caughtIt
          ? 'PASS - rotationStatus OPENS each row: a row labelled current but unopenable is reported unreadable and blocks complete'
          : 'BELIEVES THE LABEL - a row that cannot be opened is reported readable, so complete would authorise deleting the previous key over an unrecoverable secret',
    },
  }, null, 2))
} finally {
  await client.query('DELETE FROM encrypted_secrets WHERE name = ANY($1)', [[intact, corrupted]])
  await client.end()
  await prisma.$disconnect()
}
