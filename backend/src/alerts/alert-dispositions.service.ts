import { BadRequestException, ForbiddenException, Inject, Injectable } from '@nestjs/common'
import { PrismaService } from '../prisma/prisma.service.js'
import type { AuthenticatedIdentity } from '../auth/auth.types.js'
import { ALERT_CATALOG, type AlertTypeId } from './alert-catalog.js'
import { type Severity } from './alert-type.js'
import { dispositionIsConsulted } from './alert-type-reach.js'

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
  /** Whether a setting here is consulted by anything. Derived — see `alert-type-reach.ts` — so
   * the answer moves when the wiring does, without anybody editing a list. */
  readonly mapped: boolean
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
    const organisation = await this.organisationFor(identity, organizationId)
    const stored = await this.prisma.alertRuleDisposition.findMany({
      where: { organizationId: organisation },
      select: { alertTypeId: true, disposition: true },
    })
    const byType = new Map(stored.map((row) => [row.alertTypeId, row.disposition]))

    const dispositions = ALERT_CATALOG.map((type): DispositionRow => {
      const raw = byType.get(type.id)
      const readable = raw !== undefined && isDisposition(raw)
      return {
        alertTypeId: type.id,
        title: type.summary,
        category: type.category,
        catalogueSeverity: type.severity,
        disposition: readable ? raw : type.severity,
        mapped: dispositionIsConsulted(type.id),
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

    return { organizationId: organisation, dispositions, unrecognisedKeys }
  }

  /** Set one type's disposition for this organisation.
   *
   * AN UNKNOWN TYPE AND AN UNKNOWN VALUE ARE BOTH REFUSED, and neither writes. A settings page
   * that accepts a value the pipeline will never read is the defect the column rename closed —
   * the row exists, the write succeeds, the MSP sees their choice saved, and nothing changes. */
  async set(
    identity: AuthenticatedIdentity,
    alertTypeId: string,
    body: unknown,
    organizationId?: string,
  ) {
    const organisation = await this.organisationFor(identity, organizationId)
    const type = ALERT_CATALOG.find((each) => each.id === alertTypeId)
    if (type === undefined) {
      throw new BadRequestException(`No alert type is declared with the id ${alertTypeId}.`)
    }
    const disposition = (body as { disposition?: unknown } | null)?.disposition
    if (typeof disposition !== 'string' || !isDisposition(disposition)) {
      throw new BadRequestException(
        `disposition must be one of ${DISPOSITIONS.join(', ')}.`)
    }

    const setByUserId = (await this.context(identity)).userId
    await this.prisma.alertRuleDisposition.upsert({
      where: { organizationId_alertTypeId: { organizationId: organisation, alertTypeId: type.id } },
      create: { organizationId: organisation, alertTypeId: type.id, disposition, setByUserId },
      update: { disposition, setByUserId },
    })
    return this.list(identity, organisation)
  }

  /** The organisation this request is about, refusing one the caller is not a member of.
   *
   * SHAPED LIKE `NotificationsService.preferences`, deliberately: the same question answered two
   * ways in one product is how one of them ends up not checking membership. */
  private async organisationFor(identity: AuthenticatedIdentity, requested?: string) {
    const { organizationIds } = await this.context(identity)
    const selected = requested ?? organizationIds[0]
    if (selected === undefined || !organizationIds.includes(selected)) {
      throw new ForbiddenException('Workspace is not available.')
    }
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
          select: { organizationId: true },
        },
      },
    })
    if (!user || user.disabledAt) {
      throw new ForbiddenException('This HawkView account cannot access alert settings.')
    }
    return { userId: user.id, organizationIds: user.memberships.map((each) => each.organizationId) }
  }
}

/** The only door from a string to a disposition. */
function isDisposition(value: string): value is Severity {
  return (DISPOSITIONS as readonly string[]).includes(value)
}
