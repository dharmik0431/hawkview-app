import { RISK_ENVIRONMENT, RISK_UUID } from './pilot-risk-config.js'
import { riskRuntimeConfig, riskScopeAllowed, isWrappedRiskConfig } from './risk-runtime-config.js'
import type { PseudonymKeyVersion, PseudonymScope } from './identity-risk-pseudonym.js'
import { readRiskWrappingRoot, wrappedRiskName, WRAPPED_RISK_PROVIDER } from './wrapped-risk-crypto.js'
import { withMailboxReadTransaction } from './mailbox-read-transaction.js'
import { WrappedRiskKeyStore } from './wrapped-risk-key-store.js'

type Request = PseudonymScope & { versionId: string; apply: boolean }
type Preflight = { activeVersionId: string | null }
type Dependencies = {
  preflight(request: Request, deadline: number): Promise<Preflight>
  create(scope: PseudonymScope, versionId: string, deadline: number): Promise<PseudonymKeyVersion>
}
const usage = 'node dist/provision-risk-key.js --environment ENV --organization UUID --tenant UUID --version UUID [--apply --confirm-scope ENV/ORG/TENANT/VERSION]'
class OperatorError extends Error {
  constructor(readonly code: 'INVALID_ARGUMENTS' | 'CONFIG_UNAVAILABLE' | 'SCOPE_MISMATCH' | 'SCOPE_UNAVAILABLE' | 'VERSION_UNAVAILABLE') { super(code) }
}

function parse(argv: readonly string[]): Request | null {
  if (argv.length === 1 && argv[0] === '--help') return null
  if (argv.length > 11 || argv.some(arg => arg.length > 256 || /[\u0000-\u001f\u007f]/.test(arg))) throw new OperatorError('INVALID_ARGUMENTS')
  const values = new Map<string, string>()
  let apply = false
  for (let i = 0; i < argv.length; i++) {
    const option = argv[i]!
    if (option === '--apply' && !apply) { apply = true; continue }
    if (!['--environment', '--organization', '--tenant', '--version', '--confirm-scope'].includes(option) || values.has(option)) throw new OperatorError('INVALID_ARGUMENTS')
    const value = argv[++i]
    if (!value || value.startsWith('--')) throw new OperatorError('INVALID_ARGUMENTS')
    values.set(option, value)
  }
  const environment = values.get('--environment') ?? ''
  const organizationId = values.get('--organization') ?? ''
  const customerTenantId = values.get('--tenant') ?? ''
  const versionId = values.get('--version') ?? ''
  if (!RISK_ENVIRONMENT.test(environment) || ![organizationId, customerTenantId, versionId].every(value => RISK_UUID.test(value))) throw new OperatorError('INVALID_ARGUMENTS')
  const confirmation = values.get('--confirm-scope')
  if (apply ? confirmation !== `${environment}/${organizationId}/${customerTenantId}/${versionId}` : confirmation !== undefined) throw new OperatorError('INVALID_ARGUMENTS')
  return { environment, organizationId, customerTenantId, versionId, apply }
}

function validatedConfig(request: Request) {
  const config = riskRuntimeConfig()
  if (!isWrappedRiskConfig(config) || !process.env.DATABASE_URL) throw new OperatorError('CONFIG_UNAVAILABLE')
  if (!riskScopeAllowed(request, config)) throw new OperatorError('SCOPE_MISMATCH')
  try { const root = readRiskWrappingRoot(); root.fill(0) } catch { throw new OperatorError('CONFIG_UNAVAILABLE') }
}

/** SELECT-only, no audit event or key generation. Connection is READ ONLY and bounded. */
async function preflight(request: Request, deadline: number): Promise<Preflight> {
  return withMailboxReadTransaction(deadline, 4000, async client => {
    const tenant = await client.query('SELECT id FROM customer_tenants WHERE id=$1::uuid AND organization_id=$2::uuid', [request.customerTenantId, request.organizationId])
    if (tenant.rowCount !== 1) throw new OperatorError('SCOPE_UNAVAILABLE')
    const rows = await client.query(`SELECT k.id, k.organization_id AS "organizationId", k.customer_tenant_id AS "customerTenantId",
      k.environment, k.provider, k.immutable_key_id AS "immutableKeyId", k.status,
      (k.destroyed_at IS NULL AND k.retired_at IS NULL AND k.activated_at<=CURRENT_TIMESTAMP) AS usable,
      w.name AS "cipherName"
      FROM identity_risk_pseudonym_key_versions k LEFT JOIN identity_risk_wrapped_keys w ON w.key_version_id=k.id
      WHERE k.id=$1::uuid OR (k.organization_id=$2::uuid AND k.customer_tenant_id=$3::uuid AND k.environment=$4 AND k.status='ACTIVE') LIMIT 3`,
    [request.versionId, request.organizationId, request.customerTenantId, request.environment])
    let activeVersionId: string | null = null
    for (const row of rows.rows) {
      const key: PseudonymKeyVersion = { id: row.id, organizationId: row.organizationId, customerTenantId: row.customerTenantId,
        environment: row.environment, provider: row.provider, immutableKeyId: row.immutableKeyId }
      if (!riskScopeAllowed(key) || row.status !== 'ACTIVE' || !row.usable || key.provider !== WRAPPED_RISK_PROVIDER ||
        wrappedRiskName(key) !== key.immutableKeyId || row.cipherName !== key.immutableKeyId || activeVersionId !== null) throw new OperatorError('VERSION_UNAVAILABLE')
      activeVersionId = key.id
    }
    return { activeVersionId }
  })
}

const live: Dependencies = {
  preflight,
  create: (scope, version, deadline) => new WrappedRiskKeyStore().createVersion(scope, version, deadline),
}

/** No raw arguments, provider errors or secret values are ever echoed. */
export async function runRiskKeyOperator(argv: readonly string[], dependencies: Dependencies = live): Promise<{ exitCode: number; output: string }> {
  let apply = false
  try {
    const request = parse(argv)
    if (!request) return { exitCode: 0, output: JSON.stringify({ schemaVersion: 1, outcome: 'HELP', usage }) }
    apply = request.apply
    validatedConfig(request)
    const deadline = Date.now() + 10000
    const before = await dependencies.preflight(request, deadline)
    validatedConfig(request)
    if (Date.now() >= deadline || (before.activeVersionId !== null && !RISK_UUID.test(before.activeVersionId))) throw new Error('unavailable')
    let activeVersionId = before.activeVersionId
    if (apply) {
      const { environment, organizationId, customerTenantId, versionId } = request
      const key = await dependencies.create({ environment, organizationId, customerTenantId }, versionId, deadline)
      if (!riskScopeAllowed(key) || key.provider !== WRAPPED_RISK_PROVIDER || key.immutableKeyId !== wrappedRiskName(key)) throw new Error('unavailable')
      activeVersionId = key.id
    }
    return { exitCode: 0, output: JSON.stringify({ schemaVersion: 1, outcome: apply ? 'ENSURED' : 'PREFLIGHT_OK',
      mode: apply ? 'apply' : 'dry-run', environment: request.environment, organizationId: request.organizationId,
      customerTenantId: request.customerTenantId, requestedVersionId: request.versionId, activeVersionId,
      action: apply ? 'NO_ACTIVATION_PERFORMED' : activeVersionId ? 'REUSE_ACTIVE_VERSION' : 'WOULD_CREATE' }) }
  } catch (error) {
    // A lost connection can leave commit acknowledgement uncertain: do not claim rollback.
    const code = error instanceof OperatorError ? error.code : apply ? 'APPLY_UNCONFIRMED' : 'PREFLIGHT_UNAVAILABLE'
    return { exitCode: 1, output: JSON.stringify({ schemaVersion: 1, outcome: 'FAILED', code }) }
  }
}
