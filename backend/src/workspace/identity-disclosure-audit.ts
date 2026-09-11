import { Logger } from '@nestjs/common'
import type { PrismaService } from '../prisma/prisma.service.js'
import { createWorkspaceAuditOperation, writeWorkspaceAudit } from './workspace-audit.js'

/** Records that identifying information about a customer's users was shown to an
 * operator.
 *
 * WHAT THIS IS FOR. The role gate already decides correctly who may see named
 * users, and then forgets that it happened. Nothing records which operator viewed
 * which customer's people — which is what an MSP's own client eventually asks
 * for, and the only thing that answers "what did they see?" after one of your
 * operator accounts is compromised.
 *
 * THE ROW MUST NOT CONTAIN THE NAMES. An audit log of who saw which identities
 * must never become a second, longer-lived copy of those identities — it would be
 * the largest identity store in the product, kept for a year, justified as a
 * control. So this records a COUNT and the tenant: how many of that customer's
 * people were named, to whom, and when. Never a display name, never a UPN.
 *
 * Three things enforce that rather than one:
 *   1. This function's parameters cannot carry a name. There is nowhere to put
 *      one.
 *   2. `writeWorkspaceAudit` hardcodes `actorEmail: null` and `targetEmail: null`.
 *   3. `safeWorkspaceAuditMetadata` drops any key not on its allowlist, so a
 *      later edit that adds a name to metadata writes nothing rather than
 *      leaking. Adding a key there is a deliberate act, and the two keys this
 *      uses are a bounded integer and a fixed enum.
 *
 * A DISCLOSURE OF ZERO PEOPLE IS NOT A DISCLOSURE. `subjectsNamed` can be true
 * while no subject is actually named — a tenant with no findings, or with no
 * matching directory rows. Recording those would fill the log with rows in which
 * nothing was shown, and a log that is mostly noise is one nobody reads when it
 * matters. Callers record the disclosure, not the request.
 */

export const IDENTITY_DISCLOSURE_ACTION = 'CUSTOMER_IDENTITY_DISCLOSED'
export const IDENTITY_DISCLOSURE_STAGE = 'DISCLOSED'

/** Where the disclosure happened. A closed set, and typed as one so that a
 * caller cannot pass free text into an audit row. */
export type DisclosureSurface = 'RISKY_USERS_ASSESSMENT'

export interface IdentityDisclosure {
  /** The customer tenant whose people were named. */
  readonly customerTenantId: string
  /** How many distinct subjects were actually named in the response. */
  readonly namedSubjectCount: number
  readonly surface: DisclosureSurface
  /** Correlates the audit row with the request that produced it. */
  readonly requestId?: string
}

export interface DisclosureActor {
  readonly organizationId: string
  readonly userId: string
}

const logger = new Logger('IdentityDisclosureAudit')

/** Writes the disclosure row. NEVER THROWS.
 *
 * THE AUDIT WRITE MUST NOT BE ABLE TO FAIL THE READ. A technician investigating
 * a live attack must not be blocked because an audit insert failed — the same
 * rule the secret store's re-seal follows. So this swallows its own failure and
 * logs it.
 *
 * That puts two requirements in tension, and it is worth being exact about which
 * one wins. "Impossible to serve names without writing the row" cannot be
 * absolute at the same time as "the write can never fail the read". What is
 * guaranteed is that the ATTEMPT is inseparable from the naming — the same
 * function that produces the names makes it, and there is no path to one without
 * the other. A failure is then visible as `identity_disclosure_audit_failed` in
 * the logs rather than as a silently missing row, which is the distinction that
 * keeps the trail trustworthy: absent rows have a loud cause.
 */
export async function recordIdentityDisclosure(
  client: Pick<PrismaService, 'workspaceAdminAuditLog'>,
  actor: DisclosureActor,
  disclosure: IdentityDisclosure,
): Promise<void> {
  try {
    await writeWorkspaceAudit(client, actor, {
      ...createWorkspaceAuditOperation(disclosure.requestId),
      action: IDENTITY_DISCLOSURE_ACTION,
      outcome: 'SUCCEEDED',
      stage: IDENTITY_DISCLOSURE_STAGE,
      targetType: 'CUSTOMER_TENANT',
      // The tenant, not a person. This is the only identifier on the row that
      // points at the customer, and it is one HawkView already stores openly.
      targetOpaqueId: disclosure.customerTenantId,
      targetUserId: null,
      metadata: {
        namedSubjectCount: disclosure.namedSubjectCount,
        surface: disclosure.surface,
      },
    })
  } catch (error) {
    logger.error(JSON.stringify({
      event: 'identity_disclosure_audit_failed',
      customerTenantId: disclosure.customerTenantId,
      namedSubjectCount: disclosure.namedSubjectCount,
      surface: disclosure.surface,
      reason: error instanceof Error ? error.name : 'UNKNOWN',
    }))
  }
}
