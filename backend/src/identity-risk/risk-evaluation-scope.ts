/** Shared database eligibility for automatic admission and native publication.
 * Call inside one READ COMMITTED transaction. Locks remain held until commit;
 * no source collection or detector work belongs in this critical section.
 */
type Scope = Readonly<{ organizationId: string; customerTenantId: string }>
type Transaction = {
  lock: (key: string) => Promise<void>
  query: (sql: string, values: readonly string[]) => Promise<readonly unknown[]>
}
export async function lockRiskEvaluationScope(
  transaction: Transaction, scope: Scope,
  tenantLock: 'SHARE' | 'UPDATE' = 'SHARE',
  revalidate?: () => void,
): Promise<'ELIGIBLE' | 'STOPPED' | 'INELIGIBLE'> {
  // Match IdentityRiskSafetyService and the primary evaluator exactly. The
  // advisory locks also guard absent stop rows against concurrent insertion.
  const keys = ['GLOBAL', `${scope.organizationId}:${scope.customerTenantId}`]
    .map(key => `hawkview:identity-risk-control:EVALUATION_HARD_DISABLED:${key}`).sort()
  for (const key of keys) await transaction.lock(key)
  revalidate?.()
  const stop = await transaction.query(`SELECT id FROM identity_risk_operational_controls
    WHERE state='ACTIVE' AND control_type='EVALUATION_HARD_DISABLED' AND
    ((scope_type='GLOBAL' AND scope_key='GLOBAL') OR
     (scope_type='TENANT' AND scope_key=$3 AND organization_id=$1::uuid AND customer_tenant_id=$2::uuid)) LIMIT 1`,
  [scope.organizationId, scope.customerTenantId, `${scope.organizationId}:${scope.customerTenantId}`])
  if (stop.length) return 'STOPPED'
  const owner = await transaction.query("SELECT id FROM organizations WHERE id=$1::uuid AND status='ACTIVE' FOR SHARE", [scope.organizationId])
  if (owner.length !== 1) return 'INELIGIBLE'
  // Publication requests UPDATE from the outset: SHARE-then-upgrade can
  // deadlock concurrent publishers. Admission only needs SHARE.
  const tenant = await transaction.query(`SELECT id FROM customer_tenants
    WHERE id=$1::uuid AND organization_id=$2::uuid AND status='ACTIVE' FOR ${tenantLock}`, [scope.customerTenantId, scope.organizationId])
  if (tenant.length !== 1) return 'INELIGIBLE'
  const connection = await transaction.query(`SELECT id FROM tenant_connections
    WHERE customer_tenant_id=$1::uuid AND organization_id=$2::uuid AND status='CONNECTED' FOR SHARE`, [scope.customerTenantId, scope.organizationId])
  return connection.length === 1 ? 'ELIGIBLE' : 'INELIGIBLE'
}
