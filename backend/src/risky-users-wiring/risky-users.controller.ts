import { Controller, Get, Header, Inject, Param, Req } from '@nestjs/common'
import { IdentityRiskService } from '../identity-risk/identity-risk.service.js'
import { PrismaService } from '../prisma/prisma.service.js'
import { readLatestRun } from './read-run.js'
import { signalsOf } from './finding-signals-dto.js'
import { recordIdentityDisclosure } from '../workspace/identity-disclosure-audit.js'
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
    const decision = await this.identityRisk.authorizeRiskyUsersRead(request.auth, tenantId)
    if (decision.gate !== null) {
      // Returned rather than thrown. A 403 on a list-level page someone reaches
      // by navigating to Risky Users is indistinguishable from "this tenant is
      // not yours" and renders as a broken page instead of an answer. Only the
      // cross-tenant case throws, and `scope` does that before we get here.
      return { version: RISKY_USERS_RESPONSE_VERSION, available: false, because: decision.gate }
    }
    const tenant = decision.tenant

    const run = await readLatestRun(
      this.prisma as never,
      { organizationId: tenant.organizationId, customerTenantId: tenant.id },
      new Date(),
    )
    if (!run.present) {
      return { version: RISKY_USERS_RESPONSE_VERSION, available: false, because: run.because }
    }

    // WHO THE SUBJECT IS, and only for a role permitted to know.
    //
    // Without this the screen reads `subject:c54eb6ce-…` beside 339 lockouts,
    // which is not actionable — the same dead end as the old engine's literal
    // "Tenant identity" placeholder, reached by a different route. A rebuild
    // more honest than its predecessor and equally unusable is not a rebuild.
    //
    // The named identity is what `evidenceDetailAllowed` gates, rather than a
    // second unrelated rule beside it: every role sees the counts, the coverage
    // and the opaque ref; MSP_OWNER and MSP_ADMIN additionally see who. That is
    // a product statement rather than an arbitrary role check.
    const identities = tenant.evidenceDetailAllowed
      ? await this.discloseSubjects(tenant, run.findings, requestIdOf(request))
      : new Map<string, { displayName: string | null; userPrincipalName: string }>()

    return {
      version: RISKY_USERS_RESPONSE_VERSION,
      available: true,
      /** Whether this response names people. False is not an error — it is the
       * role's answer, and a surface should say so rather than showing blanks. */
      subjectsNamed: tenant.evidenceDetailAllowed,
      run: {
        windowStart: run.windowStart.toISOString(),
        windowEnd: run.windowEnd.toISOString(),
        completedAt: run.completedAt.toISOString(),
      },
      collectors: run.sources,
      count: run.count,
      claim: run.claim,
      coverage: run.streams,
      findings: {
        complete: run.complete,
        items: run.findings.map(finding => ({
          detectorId: finding.detectorId,
          subject: finding.subject,
          // THE NAME SITS BESIDE THE SUBJECT, NOT INSIDE IT, and the reason is
          // about provenance rather than convenience.
          //
          // `finding.subject` is what the DETECTOR produced. The name is an
          // enrichment this controller adds at read time by querying the
          // directory, when the role permits — it is not part of the detection.
          // Folding it into `subject` would present a read-time lookup as
          // something the detector found, and the consumer reads it from the
          // item for exactly that reason.
          //
          // I briefly moved it inside, on the argument that the frontend type
          // modelled it there. That type was evidence about one author's
          // assumption, not about the contract — and the move would have
          // re-broken the screen after the consumer had already fixed its own
          // side. Verified against the consumer directly rather than a
          // description of it: `adaptSubject(item)` reads `item.displayName`.
          //
          // Present only when the role permits AND the directory row exists.
          // Absent, not blank, never an invented placeholder.
          ...(identities.get(subjectRefOf(finding)) ?? {}),
          signals: signalsOf(finding),
        })),
      },
    }
  }

  /** Names the subjects, WITHIN THIS TENANT ONLY, and records that it happened.
   *
   * The scope is the whole safety of it. A lookup that could reach another
   * tenant's `directory_users` would be the cross-tenant exposure avoided
   * everywhere else tonight, arriving through a display-name join — so both
   * scope columns are in the where clause and a test asserts they are.
   *
   * The ref is minted as `subject:<microsoftUserId>`, so the directory id is
   * recovered by stripping that prefix rather than by a second lookup table.
   *
   * THE AUDIT WRITE LIVES HERE, INSIDE THE FUNCTION THAT PRODUCES THE NAMES, and
   * not beside the call to it. If recording the disclosure were a separate step
   * in `assessment()`, a future edit would eventually drop one of the two — and
   * a silently-missing audit trail is worse than no audit trail, because it gets
   * trusted. This is the only place in this controller that turns an opaque ref
   * into a person, so there is no way to obtain a name here without passing
   * through the line that records it.
   *
   * It is renamed from `resolveSubjects` deliberately: the function no longer
   * only resolves, and a name that still said so would invite someone to add a
   * second resolver beside it. */
  private async discloseSubjects(
    tenant: Readonly<{ id: string; organizationId: string; actorUserId: string }>,
    findings: readonly Readonly<{ subject: unknown }>[],
    requestId: string | undefined,
  ) {
    const wanted = new Map<string, string>()
    for (const finding of findings) {
      const ref = subjectRefOf(finding)
      const directoryId = ref.startsWith(SUBJECT_PREFIX) ? ref.slice(SUBJECT_PREFIX.length) : null
      if (directoryId !== null && directoryId !== '') wanted.set(directoryId, ref)
    }
    if (wanted.size === 0) return new Map<string, { displayName: string | null; userPrincipalName: string }>()

    const rows = await this.prisma.directoryUser.findMany({
      where: {
        organizationId: tenant.organizationId,
        customerTenantId: tenant.id,
        microsoftUserId: { in: [...wanted.keys()] },
      },
      select: { microsoftUserId: true, displayName: true, userPrincipalName: true },
    })
    const named = new Map<string, { displayName: string | null; userPrincipalName: string }>()
    for (const row of rows) {
      const ref = wanted.get(row.microsoftUserId)
      if (ref === undefined) continue
      named.set(ref, { displayName: row.displayName ?? null, userPrincipalName: row.userPrincipalName })
    }

    // A DISCLOSURE OF NOBODY IS NOT A DISCLOSURE. The role permits naming, but if
    // no directory row matched then nothing identifying reached the operator, and
    // recording it would fill the log with rows in which nothing was shown. The
    // count is what makes each remaining row mean something.
    if (named.size > 0) {
      // Awaited, so the attempt is part of producing the names rather than a
      // detached promise that may never run. It cannot throw — see
      // recordIdentityDisclosure — so it cannot refuse a technician mid-attack.
      await recordIdentityDisclosure(
        this.prisma,
        { organizationId: tenant.organizationId, userId: tenant.actorUserId },
        {
          customerTenantId: tenant.id,
          namedSubjectCount: named.size,
          surface: 'RISKY_USERS_ASSESSMENT',
          requestId,
        },
      )
    }
    return named
  }
}

/** The correlation id this request already carries, so an audit row can be tied
 * to the response an operator actually received. Read defensively: the audit is
 * not worth failing a read over, and `createWorkspaceAuditOperation` mints a
 * fresh id when this is absent or malformed. */
const requestIdOf = (request: unknown): string | undefined => {
  const candidate = (request as { requestId?: unknown } | null)?.requestId
  return typeof candidate === 'string' ? candidate : undefined
}

const SUBJECT_PREFIX = 'subject:'

const subjectRefOf = (finding: Readonly<{ subject: unknown }>): string => {
  const subject = finding.subject as Record<string, unknown>
  return typeof subject?.userRef === 'string' ? subject.userRef : ''
}
