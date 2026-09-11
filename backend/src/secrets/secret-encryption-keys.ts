import { ServiceUnavailableException } from '@nestjs/common'

/** The encryption keys this service can open stored secrets with.
 *
 * WHY THERE IS MORE THAN ONE. Rotating `SECRET_ENCRYPTION_KEY` used to destroy
 * every stored secret, because nothing recorded which key had sealed which row
 * and the only key available was the new one. Rotation therefore needs a window
 * in which BOTH keys are readable: rows sealed with the old key can still be
 * opened, and each one is re-sealed with the new key the next time it is read.
 * When no row remains at the old version the old key can be removed.
 *
 * The version number is the join between a row and a key. It is stated in
 * configuration rather than derived from the key material, because deriving it —
 * a fingerprint, say — would mean a row could name a key nobody has a copy of,
 * with no way to say which one it was. A small integer is legible in a database
 * row, in an error message and in a runbook.
 *
 * DELIBERATELY NOT A NEST PROVIDER. It reads the environment on each call, so an
 * operator can complete a rotation with a restart rather than a deploy, and so
 * that a test can change keys without rebuilding an injector.
 */

export const CURRENT_KEY_VARIABLE = 'SECRET_ENCRYPTION_KEY'
export const PREVIOUS_KEY_VARIABLE = 'SECRET_ENCRYPTION_KEY_PREVIOUS'
export const KEY_VERSION_VARIABLE = 'SECRET_ENCRYPTION_KEY_VERSION'

/** The version existing rows carry. The migration that added the column labelled
 * them 1, because they were sealed by the key configured at that moment. */
export const FIRST_KEY_VERSION = 1

export interface EncryptionKeyRing {
  /** The version every new and re-sealed row is written with. */
  readonly currentVersion: number
  /** The key for `currentVersion`. Always present — its absence is a refusal. */
  readonly current: Buffer
  /** The key for `version`, or null when this service does not hold it. Null is a
   * real answer and must be reported as such, never as a decryption failure. */
  key(version: number): Buffer | null
}

/** Accepts the two encodings the original implementation accepted — 64 hex
 * characters, or base64 — so an existing deployment's value keeps working
 * unchanged. Anything that is not exactly 32 bytes is not an AES-256 key. */
function parseKey(configured: string): Buffer | null {
  const trimmed = configured.trim()
  if (trimmed === '') return null
  const key = /^[a-f\d]{64}$/i.test(trimmed)
    ? Buffer.from(trimmed, 'hex')
    : Buffer.from(trimmed, 'base64')
  return key.length === 32 ? key : null
}

function parseVersion(configured: string | undefined): number | null {
  const trimmed = configured?.trim() ?? ''
  if (trimmed === '') return FIRST_KEY_VERSION
  if (!/^\d+$/.test(trimmed)) return null
  const version = Number(trimmed)
  return Number.isSafeInteger(version) && version >= FIRST_KEY_VERSION ? version : null
}

export function encryptionKeyRing(
  environment: NodeJS.ProcessEnv = process.env,
): EncryptionKeyRing {
  const current = parseKey(environment[CURRENT_KEY_VARIABLE] ?? '')
  if (current === null) {
    // The same message the original implementation used, so an existing
    // deployment's failure mode reads the same way.
    throw new ServiceUnavailableException(
      'Secure credential encryption is not configured.'
    )
  }

  const currentVersion = parseVersion(environment[KEY_VERSION_VARIABLE])
  if (currentVersion === null) {
    // Refused rather than defaulted. Treating an unparseable version as 1 would
    // seal new rows as version 1 with a version 2 key — rows that look readable
    // and are not, which is the failure this module exists to prevent.
    throw new ServiceUnavailableException(
      `${KEY_VERSION_VARIABLE} must be a whole number of at least ${FIRST_KEY_VERSION}.`
    )
  }

  const previous = parseKey(environment[PREVIOUS_KEY_VARIABLE] ?? '')
  // The previous key is, by construction, the one before the current version.
  // There is no way to configure a key for an arbitrary older version, and that
  // is intentional: a rotation that is two versions behind has left rows
  // stranded, and inventing a slot for them would hide that rather than surface
  // it. Such a row reports its own version and stops.
  const previousVersion = currentVersion - 1

  return {
    currentVersion,
    current,
    key(version: number) {
      if (version === currentVersion) return current
      if (previous !== null && version === previousVersion) return previous
      return null
    },
  }
}
