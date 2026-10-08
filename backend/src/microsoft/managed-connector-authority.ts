import { createHash, randomUUID } from 'node:crypto'
import type { StoredSecret } from '../secrets/secret-store.service.js'

export const IMMUTABLE_MANAGED_SECRET_PREFIX = 'hawkview-managed-revision:'
const LOCK_KEY = 'hawkview:managed-connector:default:authority:v1'
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export interface AuthorityTransaction {
  $executeRawUnsafe(query: string, ...values: any[]): Promise<number>
  $queryRawUnsafe<T = unknown>(query: string, ...values: any[]): Promise<T>
}
export interface AuthorityDatabase {
  $transaction<T>(work: (tx: AuthorityTransaction) => Promise<T>, options?: { isolationLevel: 'ReadCommitted' }): Promise<T>
}
export interface ManagedAuthority {
  configurationRevision: string
  clientId: string
  homeTenantId: string
  credentialReference: string
}
interface StoredAuthority extends ManagedAuthority {
  operationId: string | null
  fingerprint: string | null
}
export interface PreparedManagedPublication {
  expectedRevision: string | null
  operationId: string
  revision: string
  clientId: string
  homeTenantId: string
  credentialExpiresAt: Date | null
  /** Seal with the canonical lowercase revision name as AES-GCM AAD before entry. */
  sealed: {
    ciphertext: Uint8Array
    initializationVector: Uint8Array
    authenticationTag: Uint8Array
    keyVersion: number
  }
}
export type PublicationResult =
  | { status: 'published' | 'replayed'; authority: ManagedAuthority }
  | { status: 'superseded' | 'conflict' }

function uuid(value: string): string {
  if (typeof value !== 'string' || !UUID.test(value)) throw new Error('INVALID_MANAGED_AUTHORITY_ID')
  return value.toLowerCase()
}
function authority(row: StoredAuthority): ManagedAuthority {
  const { configurationRevision, clientId, homeTenantId, credentialReference } = row
  return { configurationRevision, clientId, homeTenantId, credentialReference }
}
async function lock(tx: AuthorityTransaction, exclusive: boolean): Promise<StoredAuthority | null> {
  // The advisory lock also covers bootstrap, when there is no row to lock.
  await tx.$queryRawUnsafe(
    `SELECT 1 AS locked FROM ${exclusive ? 'pg_advisory_xact_lock' : 'pg_advisory_xact_lock_shared'}(hashtextextended($1, 0))`, LOCK_KEY)
  const rows = await tx.$queryRawUnsafe<StoredAuthority[]>(`
    SELECT configuration_revision::text AS "configurationRevision", client_id::text AS "clientId",
      home_tenant_id::text AS "homeTenantId", credential_reference AS "credentialReference",
      configuration_operation_id::text AS "operationId", publication_fingerprint AS fingerprint
    FROM platform_microsoft_connectors WHERE id = 'default' FOR ${exclusive ? 'UPDATE' : 'SHARE'}`)
  return rows[0] ?? null
}
export async function captureManagedAuthority(db: AuthorityDatabase): Promise<ManagedAuthority | null> {
  return db.$transaction(async tx => {
    const row = await lock(tx, false)
    return row ? authority(row) : null
  }, { isolationLevel: 'ReadCommitted' })
}

/** Upgrade only the additive migration's unpublished legacy authority. Copy the
 * locked, decryptable stored value into a new immutable revision atomically.
 * No provider calls, mutable-credential fallback, tenant writes or scope opt-in. */
export async function upgradeLegacyManagedAuthority(db: AuthorityDatabase,
  prepare: (revision: string, source: StoredSecret) => PreparedManagedPublication['sealed']
): Promise<{ status: 'current' | 'upgraded' | 'unavailable' }> {
  return db.$transaction(async tx => {
    const current = await lock(tx, true)
    if (!current) return { status: 'unavailable' }
    if (current.credentialReference === `encrypted-secret:${current.configurationRevision}`) return { status: 'current' }
    // A malformed published authority is not an old configuration to adopt.
    if (current.operationId !== null || current.fingerprint !== null) return { status: 'unavailable' }
    const reference = current.credentialReference
    const secretId = reference.startsWith('encrypted-secret:') ? uuid(reference.slice('encrypted-secret:'.length)) : null
    if (secretId === null && !/^projects\/[^/]+\/secrets\/[^/]+\/versions\/[^/]+$/.test(reference)) return { status: 'unavailable' }
    const rows = await tx.$queryRawUnsafe<(StoredSecret & { credentialExpiresAt: Date | null })[]>(
      `/* managed:legacy-secret */ SELECT s.id::text AS id,s.name,s.ciphertext,
        s.initialization_vector AS "initializationVector",s.authentication_tag AS "authenticationTag",s.key_version AS "keyVersion",
        p.credential_expires_at AS "credentialExpiresAt"
      FROM encrypted_secrets s CROSS JOIN platform_microsoft_connectors p
      WHERE p.id='default' AND (s.id=$1::uuid OR s.legacy_reference=$2)
      FOR SHARE OF s`, secretId, secretId === null ? reference : null)
    const source = rows[0]
    if (rows.length !== 1 || source.name.startsWith(IMMUTABLE_MANAGED_SECRET_PREFIX)) return { status: 'unavailable' }
    const revision = randomUUID()
    const sealed = prepare(revision, source)
    // Reuse the same transaction/locks: a second caller sees the committed
    // immutable revision, and a queued old secret writer cannot alter this copy.
    const publication = await publishManagedAuthority({ $transaction: work => work(tx) }, {
      expectedRevision: current.configurationRevision, operationId: randomUUID(), revision,
      clientId: current.clientId, homeTenantId: current.homeTenantId,
      credentialExpiresAt: source.credentialExpiresAt, sealed,
    })
    if (publication.status !== 'published') throw new Error('MANAGED_LEGACY_UPGRADE_CONFLICT')
    return { status: 'upgraded' }
  }, { isolationLevel: 'ReadCommitted' })
}
/** Global authority lock comes first. Work must be bounded DB work, never provider/network I/O. */
export async function withManagedAuthority<T>(db: AuthorityDatabase, expectedRevision: string,
  work: (tx: AuthorityTransaction, current: ManagedAuthority) => Promise<T>
): Promise<{ status: 'current'; value: T } | { status: 'superseded' }> {
  const expected = uuid(expectedRevision)
  return db.$transaction(async tx => {
    const row = await lock(tx, false)
    if (!row || row.configurationRevision !== expected) return { status: 'superseded' }
    return { status: 'current', value: await work(tx, authority(row)) }
  }, { isolationLevel: 'ReadCommitted' })
}
/** Unwired prerequisite. Old writers must be drained before consumers can trust this revision. */
export async function publishManagedAuthority(db: AuthorityDatabase, input: PreparedManagedPublication): Promise<PublicationResult> {
  const expectedRevision = input.expectedRevision === null ? null : uuid(input.expectedRevision)
  const operationId = uuid(input.operationId), revision = uuid(input.revision)
  const clientId = uuid(input.clientId), homeTenantId = uuid(input.homeTenantId)
  const sealed = input.sealed
  if (!(sealed.ciphertext instanceof Uint8Array) || sealed.ciphertext.length < 1 || sealed.ciphertext.length > 65536 ||
      !(sealed.initializationVector instanceof Uint8Array) || sealed.initializationVector.length !== 12 ||
      !(sealed.authenticationTag instanceof Uint8Array) || sealed.authenticationTag.length !== 16 ||
      !Number.isInteger(sealed.keyVersion) || sealed.keyVersion < 1 || sealed.keyVersion > 2147483647 ||
      (input.credentialExpiresAt !== null && (!(input.credentialExpiresAt instanceof Date) || !Number.isFinite(input.credentialExpiresAt.getTime())))) {
    throw new Error('INVALID_MANAGED_PUBLICATION')
  }
  // Copy mutable caller buffers before the first await so the fingerprint describes inserted bytes.
  const ciphertext = Buffer.from(sealed.ciphertext), iv = Buffer.from(sealed.initializationVector)
  const tag = Buffer.from(sealed.authenticationTag), keyVersion = sealed.keyVersion
  const expiry = input.credentialExpiresAt?.toISOString() ?? null
  const name = IMMUTABLE_MANAGED_SECRET_PREFIX + revision
  const reference = 'encrypted-secret:' + revision
  const fingerprint = createHash('sha256').update(JSON.stringify([
    expectedRevision, operationId, revision, clientId, homeTenantId, expiry,
    keyVersion, ciphertext.toString('base64'), iv.toString('base64'), tag.toString('base64')
  ])).digest('hex')
  return db.$transaction(async tx => {
    const current = await lock(tx, true)
    if (current?.operationId === operationId) {
      return current.fingerprint === fingerprint
        ? { status: 'replayed', authority: authority(current) } : { status: 'conflict' }
    }
    if ((current?.configurationRevision ?? null) !== expectedRevision) return { status: 'superseded' }
    const used = await tx.$queryRawUnsafe<{ id: string }[]>(
      'SELECT id FROM encrypted_secrets WHERE id = $1::uuid OR name = $2 UNION ALL SELECT revision AS id FROM managed_connector_authority_revisions WHERE revision = $1::uuid', revision, name)
    if (revision === expectedRevision || used.length) return { status: 'conflict' }
    if (current) await tx.$executeRawUnsafe(
      'INSERT INTO managed_connector_authority_revisions (revision) VALUES ($1::uuid) ON CONFLICT DO NOTHING', current.configurationRevision)
    await tx.$executeRawUnsafe('INSERT INTO managed_connector_authority_revisions (revision) VALUES ($1::uuid)', revision)
    await tx.$executeRawUnsafe(`INSERT INTO encrypted_secrets
      (id, name, ciphertext, initialization_vector, authentication_tag, key_version, created_at, updated_at)
      VALUES ($1::uuid, $2, $3, $4, $5, $6, clock_timestamp(), clock_timestamp())`,
      revision, name, ciphertext, iv, tag, keyVersion)
    await tx.$executeRawUnsafe(`INSERT INTO platform_microsoft_connectors
      (id, client_id, home_tenant_id, credential_reference, credential_expires_at, configured_at, updated_at,
       configuration_revision, configuration_operation_id, publication_fingerprint)
      VALUES ('default', $1::uuid, $2::uuid, $3, $4::timestamptz, clock_timestamp(), clock_timestamp(), $5::uuid, $6::uuid, $7)
      ON CONFLICT (id) DO UPDATE SET client_id = EXCLUDED.client_id, home_tenant_id = EXCLUDED.home_tenant_id,
      credential_reference = EXCLUDED.credential_reference, credential_expires_at = EXCLUDED.credential_expires_at,
      configured_at = EXCLUDED.configured_at, updated_at = EXCLUDED.updated_at,
      configuration_revision = EXCLUDED.configuration_revision,
      configuration_operation_id = EXCLUDED.configuration_operation_id, publication_fingerprint = EXCLUDED.publication_fingerprint`,
      clientId, homeTenantId, reference, expiry, revision, operationId, fingerprint)
    return { status: 'published', authority: { configurationRevision: revision, clientId, homeTenantId, credentialReference: reference } }
  }, { isolationLevel: 'ReadCommitted' })
}
