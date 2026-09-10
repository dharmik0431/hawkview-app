import { Controller, Get, Header, Inject, Param, Req } from '@nestjs/common'
import { IdentityRiskService } from '../identity-risk/identity-risk.service.js'
import { PrismaService } from '../prisma/prisma.service.js'
import { readLatestRun } from './read-run.js'
import { signalsOf } from './finding-signals-dto.js'
import type { AuthenticatedRequest } from '../auth/auth.types.js'

/** The rebuilt engine's own endpoint.
 *
 * A NEW route rather than a change to `identity-signals/assessment`, and the
 * reason is the deploy topology rather than caution. The frontend currently
 * serving customers is the old one: push auto-deploys the backend while the
 * frontend publishes separately, and that adapter rejects an entire payload if a
 * key it expects is missing. So changing the existing response means the live
 * frontend receives it immediately, and one omitted field breaks Risky Users for
 * real customers on a deploy that otherwise changes nothing for them. A route
 * nothing calls cannot do that.
 *
 * NATIVE SHAPE, NOT THE OLD ENVELOPE. `capability`, `reasonCode`, `freshness`
 * and `selectedSource` are the previous engine's vocabulary. Filling them means
 * mapping a richer vocabulary into a coarser one and inventing the boundaries —
 * which withheld reasons are PARTIAL, which are UNAVAILABLE — for a word a
 * technician reads before they read the reasons. This serves what the engine
 * knows; anything wanting a one-word summary derives it where the full reasons
 * are in the same payload and the derivation is visible.
 *
 * READ-ONLY. It reads one persisted run and shapes it. It never evaluates — an
 * assessment takes seconds, and a request that computes is a request that can
 * time out and a tenant that looks broken under load.
 */

export const RISKY_USERS_RESPONSE_VERSION = 'hawkview-risky-users/v1'

@Controller('api/tenants/:tenantId')
export class RiskyUsersController {
  constructor(
    @Inject(IdentityRiskService) private readonly identityRisk: IdentityRiskService,
    @Inject(PrismaService) private readonly prisma: PrismaService,
  ) {}

  /** Authorization is NOT implemented here. It delegates to the same check every
   * other identity-risk read uses: active membership in an active organization,
   * the tenant resolved only within those organizations, plus the separate pilot
   * gate on who may read this data at all. A second copy of that rule would be
   * two places for a cross-tenant exposure to hide. */
  @Get('risky-users/assessment')
  @Header('Cache-Control', 'no-store')
  async assessment(@Req() request: AuthenticatedRequest, @Param('tenantId') tenantId: string) {
    const tenant = await this.identityRisk.authorizeRiskyUsersRead(request.auth, tenantId)
    if (tenant === null) {
      // Distinct from "not yours", which `scope` has already thrown for, and
      // distinct from "no run yet". Three different answers; an undifferentiated
      // "unavailable" is the defect this vocabulary exists to remove.
      return { version: RISKY_USERS_RESPONSE_VERSION, available: false, because: 'NOT_ENABLED_FOR_TENANT' }
    }

    const run = await readLatestRun(
      this.prisma as never,
      { organizationId: tenant.organizationId, customerTenantId: tenant.id },
      new Date(),
    )
    if (!run.present) {
      // The reader's own reason travels rather than flattening. NO_RUN is a
      // scheduling question, an unreadable record is a data question, and a
      // record from a future version is a deploy-ordering question — they send
      // an investigator to different places.
      return { version: RISKY_USERS_RESPONSE_VERSION, available: false, because: run.because }
    }

    return {
      version: RISKY_USERS_RESPONSE_VERSION,
      available: true,
      /** The run's own timing. `windowEnd` is set at the read moment by the
       * evaluator, so a gap between it and `completedAt` means a stale or
       * replayed run — a fact about the RUN, not about the tenant, and distinct
       * from both the evidence being old and a finding's own horizon. */
      run: {
        windowStart: run.windowStart.toISOString(),
        windowEnd: run.windowEnd.toISOString(),
        completedAt: run.completedAt.toISOString(),
      },
      count: run.count,
      claim: run.claim,
      coverage: run.streams,
      findings: {
        complete: run.complete,
        items: run.findings.map(finding => ({
          detectorId: finding.detectorId,
          subject: finding.subject,
          signals: signalsOf(finding),
        })),
      },
    }
  }
}
