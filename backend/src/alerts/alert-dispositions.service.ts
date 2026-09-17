import { BadRequestException, ForbiddenException, Inject, Injectable } from '@nestjs/common'
import { PrismaService } from '../prisma/prisma.service.js'
import type { AuthenticatedIdentity } from '../auth/auth.types.js'
import { ALERT_CATALOG, type AlertTypeId } from './alert-catalog.js'
import { type Severity } from './alert-type.js'
import { UUID } from './email-release-config.js'
import {
  alertPolicyCapability, alertPreferenceCapabilities, hasProvenAlertProducer,
  dispositionIsConsulted, settingDoesSomething, typesWithProducerInput, type AlertPolicyCapability,
} from './alert-type-reach.js'

/**
 * WHAT AN MSP CONSIDERS URGENT, READ AND WRITTEN.
 *
 * **THE DISPOSITION IS THE TIER, NOT THE CHANNEL.** The organisation answers *what counts as
 * urgent here*; the product answers *how we reach you about something that urgent*. The column
 * held `RING | EMAIL | DIGEST | RECORD_ONLY` — the second question — which left the first
 * unsayable and made the catalogue's declared severity and the stored value two spellings of one
 * judgement with a mapping between them.
 *
 * NOTHING IS SEEDED. Absence of a row means the catalogue's declared severity, so the default
 * cannot drift from the tiering the catalogue states, and the table is empty on day one by
 * design rather than by a failed seed.
 */

/** The closed vocabulary, and it is the catalogue's `Severity` rather than a parallel list.
 *
 * A SECOND LIST HERE WOULD BE THE DEFECT THIS FEATURE KEEPS FIXING. Typed as `Severity` so
 * adding a tier to the catalogue is a compile error here rather than a value the endpoint
 * silently refuses. */
export const DISPOSITIONS: readonly Severity[] = ['ACT_NOW', 'ACT_TODAY', 'RECORD_ONLY']

export interface DispositionRow {
  readonly alertTypeId: AlertTypeId
  readonly title: string
  readonly category: string
  /** What the product judges this type to be, for a reader to see whether they have departed. */
  readonly catalogueSeverity: Severity
  /** **WHAT WILL ACTUALLY HAPPEN**, which is the stored value when it is readable and the
   * catalogue's judgement when there is no row. */
  readonly disposition: Severity
  /** Whether a setting here does anything **for this organisation**: a producer is wired to the
   * type AND this organisation has findings for it to carry. Derived — see
   * `alert-type-reach.ts` — so the answer moves when the wiring does and when the data does,
   * without anybody editing a list.
   *
   * It was the first half alone, which was true about the wiring and wrong about the question:
   * two types reported a working setting while the pipeline behind them had never been handed a
   * finding. */
  readonly mapped: boolean
  /** Separate proof, observed input, and caller authorization. */
  readonly capability: AlertPolicyCapability
  /** A stored value outside the vocabulary, verbatim.
   *
   * **REPORTED, NEVER DEFAULTED AWAY.** `disposition` above already says what the product will
   * do — the default, because an unreadable value never reaches the lookup — and that is true.
   * What would not be true is letting the row look like nobody had chosen. This is a setting
   * somebody made that is being ignored, and it must be visible on the row where they made it. */
  readonly storedValueIgnored?: string
}

@Injectable()
export class AlertDispositionsService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  /** Every catalogue type, with what this organisation has chosen for it. */
  async list(identity: AuthenticatedIdentity, organizationId?: string) {
    const context = await this.context(identity)
    const organisation = this.organisationFor(context.organizationIds, organizationId)
    const canManagePolicy = context.memberships.some(member => member.organizationId === organisation && member.role === 'MSP_OWNER')
    const stored = await this.prisma.alertRuleDisposition.findMany({
      where: { organizationId: organisation },
      select: { alertTypeId: true, disposition: true },
    })
    const byType = new Map(stored.map((row) => [row.alertTypeId, row.disposition]))

    // WHAT THIS ORGANISATION HAS FOR THE PIPELINE TO CARRY, scoped to it because the reader's
    // question is about THEIR switch. The intake's own filter is `state = 'OPEN'`, so this asks
    // the same thing it asks; distinct on the rule, because the mapping is per rule and a
    // thousand findings of one rule say exactly what one does.
    const carrying = await this.prisma.identityRiskFinding.findMany({
      where: { organizationId: organisation, state: 'OPEN' },
      select: { ruleId: true },
      distinct: ['ruleId'],
    })
    const fedTypes = typesWithProducerInput(carrying.map((row) => row.ruleId))

    const dispositions = ALERT_CATALOG.map((type): DispositionRow => {
      const raw = byType.get(type.id)
      const readable = raw !== undefined && isDisposition(raw)
      return {
        alertTypeId: type.id,
        title: type.summary,
        category: type.category,
        catalogueSeverity: type.severity,
        disposition: readable ? raw : type.severity,
        mapped: settingDoesSomething(type.id, fedTypes),
        capability: alertPolicyCapability(type.id, fedTypes, canManagePolicy),
        ...(raw !== undefined && !readable ? { storedValueIgnored: raw } : {}),
      }
    })
    // **KEYS THE CATALOGUE DOES NOT DECLARE, NAMED RATHER THAN SKIPPED.** This method walks the
    // catalogue, so a stored row whose `alert_type_id` is not a declared id is invisible to it —
    // seven rows come back and none mentions it. That is exactly what this column held before it
    // was renamed, so the rows most likely to be here are real settings real people made.
    //
    // The distinction the endpoint now makes at both ends: an unreadable VALUE appears on its
    // row as `storedValueIgnored`; an unreadable KEY has no row to appear on, so it is listed
    // here. Neither silences anything — the catalogue default applies either way — and the harm
    // in both is that somebody believes their choice took effect.
    const declared = new Set<string>(ALERT_CATALOG.map((type) => type.id))
    const unrecognisedKeys = stored
      .map((row) => row.alertTypeId)
      .filter((id) => !declared.has(id))
      .sort()

    return {
      organizationId: organisation, dispositions, unrecognisedKeys, canManagePolicy,
      capabilities: alertPreferenceCapabilities(organisation, context.userId),
    }
  }

  /** Set one type's disposition for this organisation.
   *
   * AN UNKNOWN TYPE AND AN UNKNOWN VALUE ARE BOTH REFUSED, and neither writes. A settings page
   * that accepts a value the pipeline will never read is the defect the column rename closed —
   * the row exists, the write succeeds, the MSP sees their choice saved, and nothing changes. */
  async set(identity: AuthenticatedIdentity, alertTypeId: string, body: unknown, organizationId?: string) {
    const context = await this.context(identity)
    const organisation = this.organisationFor(context.organizationIds, organizationId)
    if (!context.memberships.some(member => member.organizationId === organisation && member.role === 'MSP_OWNER')) {
      throw new ForbiddenException('Only MSP_OWNER can manage workspace alert policy.')
    }
    const type = ALERT_CATALOG.find(each => each.id === alertTypeId)
    if (type === undefined) throw new BadRequestException(`No alert type is declared with the id ${alertTypeId}.`)
    if (!dispositionIsConsulted(type.id) || !hasProvenAlertProducer(type.id)) {
      throw new BadRequestException('This alert type does not have an established producer and cannot be edited.')
    }
    const disposition = (body as { disposition?: unknown } | null)?.disposition
    if (typeof disposition !== 'string' || !isDisposition(disposition)) {
      throw new BadRequestException(`disposition must be one of ${DISPOSITIONS.join(', ')}.`)
    }
    await this.prisma.$transaction(async tx => {
      // The mutation checks and locks identity, membership, role, and organization until commit.
      const eligible = await tx.$queryRaw<{ id: string }[]>`SELECT u.id FROM users u
        JOIN memberships m ON m.user_id = u.id
        JOIN organizations o ON o.id = m.organization_id
        WHERE u.id = ${context.userId}::uuid AND u.auth_provider_user_id = ${identity.subject}
          AND u.disabled_at IS NULL AND m.organization_id = ${organisation}::uuid
          AND m.status = 'ACTIVE' AND m.role = 'MSP_OWNER' AND o.status = 'ACTIVE'
        FOR SHARE OF u, m, o`
      if (eligible.length !== 1) throw new ForbiddenException('Workspace policy authorization is no longer available.')
      await tx.alertRuleDisposition.upsert({
        where: { organizationId_alertTypeId: { organizationId: organisation, alertTypeId: type.id } },
        create: { organizationId: organisation, alertTypeId: type.id, disposition, setByUserId: context.userId },
        update: { disposition, setByUserId: context.userId },
      })
    })
    return this.list(identity, organisation)
  }

  private organisationFor(organizationIds: string[], requested?: string): string {
    if (requested !== undefined && (typeof requested !== 'string' || !UUID.test(requested))) {
      throw new BadRequestException('A valid organizationId is required.')
    }
    if (requested === undefined && organizationIds.length > 1) {
      throw new BadRequestException('Select an explicit organizationId.')
    }
    const selected = requested ?? organizationIds[0]
    if (!selected || !organizationIds.includes(selected)) throw new ForbiddenException('Workspace is not available.')
    return selected
  }

  private async context(identity: AuthenticatedIdentity) {
    const user = await this.prisma.user.findUnique({
      where: { authProviderUserId: identity.subject },
      select: {
        id: true,
        disabledAt: true,
        memberships: {
          where: { status: 'ACTIVE', organization: { status: 'ACTIVE' } },
          select: { organizationId: true, role: true },
        },
      },
    })
    if (!user || user.disabledAt) {
      throw new ForbiddenException('This HawkView account cannot access alert settings.')
    }
    return { userId: user.id, memberships: user.memberships, organizationIds: user.memberships.map((each) => each.organizationId) }
  }
}

/** The only door from a string to a disposition. */
function isDisposition(value: string): value is Severity {
  return (DISPOSITIONS as readonly string[]).includes(value)
}
