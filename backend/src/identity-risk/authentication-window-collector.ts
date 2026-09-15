import type { Prisma } from '../generated/prisma/client.js'
import type { PrismaService } from '../prisma/prisma.service.js'
import { enforceRiskUtcTransaction } from './risk-utc-session.js'
import { authenticationWindow, mergeAuthenticationWindow } from './authentication-source-readiness.js'
import type { AuthSource } from '../risky-users-auth/contract.js'

/** Called only after the complete primary page chain and successful bounded
 * persistence. This metadata contains no events/identities. Partial, failed or
 * capped collections MUST NOT call this function. Generic SIGN_INS freshness
 * alone does not establish which source or window was actually collected. */
export async function persistCompletedAuthenticationWindow(prisma: PrismaService,
  scope: { organizationId: string; customerTenantId: string }, source: AuthSource, start: Date, end: Date,
  completedPageChain: boolean,
  /** WHAT THIS PASS ACTUALLY SAW, beside what it asked for. Required rather than
   * optional: a default would let a caller record 'observed nothing' by saying
   * nothing, which is the collapse this whole change removes, and the compiler
   * naming every call site is the point. */
  observed: { events: number; latestEventAt: string | null }) {
  if (completedPageChain !== true) throw new Error('IDENTITY_AUTH_WINDOW_INCOMPLETE')
  await prisma.$transaction(async (transaction: Prisma.TransactionClient) => {
    await enforceRiskUtcTransaction(transaction)
    await transaction.$executeRawUnsafe('SELECT pg_advisory_xact_lock(hashtext($1))', `hawkview:snapshot:${scope.customerTenantId}:SIGN_INS`)
    const previous = await transaction.$queryRawUnsafe<Array<{ payload: unknown; observedAt: Date }>>(`SELECT
      CASE WHEN octet_length(payload::text)<=8192 THEN payload ELSE NULL END AS payload, observed_at AS "observedAt"
      FROM tenant_entra_snapshots WHERE organization_id=$1::uuid AND customer_tenant_id=$2::uuid AND resource_type='SIGN_INS' FOR UPDATE`,
    scope.organizationId, scope.customerTenantId)
    const prior = previous.length === 1 ? authenticationWindow(previous[0]!.payload) : null
    const window = mergeAuthenticationWindow(prior, source, start, end, true, observed)
    const observedAt = new Date()
    await transaction.tenantEntraSnapshot.upsert({
      where: { customerTenantId_resourceType: { customerTenantId: scope.customerTenantId, resourceType: 'SIGN_INS' } },
      create: { organizationId:scope.organizationId, customerTenantId:scope.customerTenantId, resourceType: 'SIGN_INS', payload: window, observedAt },
      update: { payload: window, observedAt },
    })
  }, { timeout: 6000, maxWait: 1000 })
}
