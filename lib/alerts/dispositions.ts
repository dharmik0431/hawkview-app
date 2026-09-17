import type { NotificationCapabilities } from '../notifications/preferences-contract.ts'

/**
 * The organisation's answer to "what counts as urgent here".
 *
 * A different grain from the per-user notification preferences page, which
 * answers "how and when I hear about it". Two people in one MSP must not
 * disagree about whether a privileged role grant is urgent, so the tier is a
 * property of the organisation; the channel and the quiet hours are properties
 * of the person. This module never writes user preferences.
 */

/**
 * The tier, in the vocabulary the alerting catalogue already uses.
 *
 * THREE VALUES, NOT TWO. An earlier draft of the contract collapsed ACT_NOW and
 * ACT_TODAY into one "urgent", which reads like a cosmetic choice about radio
 * buttons and is not: the two route to different channels, so a two-valued
 * disposition makes "wake me for a disconnected tenant, queue a failing
 * collector for the morning" unsayable by the person the product is for.
 *
 * The disposition IS the tier rather than a flag layered over one. The
 * catalogue declares a default and the organisation's choice replaces it.
 */
export type AlertDisposition = 'ACT_NOW' | 'ACT_TODAY' | 'RECORD_ONLY'

export type AlertDispositionRow = {
  alertTypeId: string
  title: string
  category: string
  /** What HawkView's own judgement is, so a departure from it is visible. */
  catalogueSeverity: AlertDisposition
  /** What this organisation has chosen. Equal to the catalogue when untouched. */
  disposition: AlertDisposition
  /**
   * Whether any detector currently feeds this alert type.
   *
   * False is shown rather than hidden. Several rules are deliberately unmapped,
   * and an MSP setting a disposition on a type nothing can raise should be able
   * to see that they have configured something that will never fire.
   */
  mapped: boolean
  /**
   * Server-evaluated capability. `mapped` is retained for backwards-compatible
   * diagnostics only and must never enable a write.
   */
  capability: {
    intakeWiring: 'MAPPED' | 'UNMAPPED'
    producerSupport: 'PROVEN' | 'NOT_ESTABLISHED'
    observedInput: 'OPEN_FINDING_PRESENT' | 'NO_OPEN_FINDING'
    editable: boolean
    reason:
      | 'READY'
      | 'OWNER_REQUIRED'
      | 'PRODUCER_NOT_ESTABLISHED'
      | 'INTAKE_UNMAPPED'
  }
  /**
   * A stored value outside the vocabulary, verbatim, when there is one.
   *
   * Reported rather than defaulted away. `disposition` says what the product
   * will actually do and that is true; without this the row would look like
   * nobody had chosen, when in fact somebody chose and is being ignored.
   */
  storedValueIgnored?: string
}

export const DISPOSITION_LABELS: Record<AlertDisposition, string> = {
  ACT_NOW: 'Act now',
  ACT_TODAY: 'Act today',
  RECORD_ONLY: 'Record only',
}

export type DeliveryDescription = {
  today: string
  limitation: string | null
}

/**
 * What choosing this tier actually does, computed from the channel states.
 *
 * If PHONE goes live, this sentence changes with no edit here. If EMAIL went
 * dark, the sentence would stop claiming email — which is the property that
 * makes this worth more than a hand-written string per tier.
 */
export function deliveryDescription(
  disposition: AlertDisposition,
  capabilities: NotificationCapabilities
): DeliveryDescription {
  const label = DISPOSITION_LABELS[disposition]
  if (disposition === 'RECORD_ONLY') {
    return {
      today:
        'Evidence stays with the risky user. No notification, unread count, or email is created.',
      limitation: null,
    }
  }

  const email = capabilities.channels.email
  const limitation =
    email.availability === 'DISABLED'
      ? 'Email sending is currently off. A saved personal email opt-in does not activate it.'
      : email.availability === 'CONTROLLED'
        ? 'Email delivery is controlled separately by recipient eligibility and release status.'
        : 'Email delivery is unavailable. This policy does not enable it.'
  return {
    today: `Future alerts are marked ${label}. In-app delivery is available.`,
    limitation,
  }
}

export function rowDeliveryDescription(
  row: AlertDispositionRow,
  capabilities: NotificationCapabilities
): DeliveryDescription {
  if (
    row.capability.intakeWiring !== 'MAPPED' ||
    row.capability.producerSupport !== 'PROVEN'
  ) {
    return {
      today:
        'This saved urgency is inactive because HawkView has not established a working producer and intake path for this alert type.',
      limitation: 'No notification delivery is promised for this alert type.',
    }
  }
  return deliveryDescription(row.disposition, capabilities)
}

export function canEditDisposition(
  row: AlertDispositionRow,
  canManagePolicy: boolean
) {
  return (
    canManagePolicy &&
    row.capability.editable &&
    row.capability.reason === 'READY' &&
    row.capability.intakeWiring === 'MAPPED' &&
    row.capability.producerSupport === 'PROVEN'
  )
}

export function capabilityCopy(row: AlertDispositionRow): {
  label: string
  detail: string
  tone: 'ready' | 'quiet' | 'warning'
} {
  if (row.capability.reason === 'READY') {
    return {
      label: 'Configurable',
      detail:
        row.capability.observedInput === 'OPEN_FINDING_PRESENT'
          ? 'A proven producer is wired to intake and currently has open findings.'
          : 'A proven producer is wired to intake. No open finding is present; the policy is still configurable.',
      tone: 'ready',
    }
  }
  if (row.capability.reason === 'OWNER_REQUIRED') {
    return {
      label: 'Owner required',
      detail: 'Only an MSP owner can change this workspace policy.',
      tone: 'warning',
    }
  }
  if (row.capability.reason === 'INTAKE_UNMAPPED') {
    return {
      label: 'Not available',
      detail: 'No intake mapping exists for this alert type, so changing it would have no effect.',
      tone: 'quiet',
    }
  }
  return {
    label: 'Not available',
    detail:
      'Intake wiring exists, but a producer for this alert type has not been established. The policy is read-only.',
    tone: 'quiet',
  }
}

/* -------------------------------------------------------------------------- */
/* Whether an empty list is a result                                          */
/* -------------------------------------------------------------------------- */

/**
 * Why there is nothing to show.
 *
 * A union rather than `items.length === 0`, because an empty array cannot say
 * which of two very different things happened. Production holds zero findings
 * today, so an empty screen is what every MSP sees on day one — and this
 * codebase already ships a source reporting READY and CURRENT having observed
 * no events. Deciding from the length would repeat that defect in the first
 * place anybody looks.
 */
export type Emptiness =
  | { kind: 'HAS_ITEMS' }
  /** We looked and the answer is genuinely nothing. */
  | { kind: 'NOTHING_MATCHED' }
  /** We have never been able to look. Not a statement about the tenant. */
  | { kind: 'NEVER_OBSERVED' }

export function emptinessCopy(emptiness: Emptiness): {
  title: string
  detail: string
} | null {
  if (emptiness.kind === 'HAS_ITEMS') return null
  if (emptiness.kind === 'NOTHING_MATCHED') {
    return {
      title: 'No alert types are configured for this organisation',
      detail:
        'HawkView asked and the catalogue returned nothing. This is an empty result rather than a missing one.',
    }
  }
  return {
    title: 'Alert settings could not be loaded',
    detail:
      'No request has succeeded, so HawkView cannot say what this organisation has configured. This is not the same as having configured nothing, and nothing here should be read as a setting.',
  }
}

/* -------------------------------------------------------------------------- */
/* When a saved change takes effect                                           */
/* -------------------------------------------------------------------------- */

/**
 * What "saved" means for a disposition, which is not what it usually means.
 *
 * Intake reads dispositions once per run, which is correct and should not
 * change. But a control saying "Saved" while meaning "from the next run" has
 * promised something the pipeline does not keep: a change made while a run is
 * in flight does not touch that run, and an MSP who silenced an alert and then
 * received it would reasonably conclude the setting is broken.
 *
 * SECOND CLAUSE, AND IT BECAME TRUE RATHER THAN HAVING ALWAYS BEEN. The tick
 * used to rewrite an existing notification on every pass, so raising or
 * lowering a tier restyled alerts already on the bell. It now records one
 * decision per finding and never revisits it, so a row keeps the urgency it
 * was raised with. That is the better behaviour — the row says what was true
 * when the alert fired — but it is not what this sentence promised, and an MSP
 * who raises a tier and watches yesterday's alerts stay calm would read it as
 * the setting having failed.
 */
export const SAVED_APPLIES_FROM =
  'Saved. This applies to alerts raised from the next evaluation run — a run already in '
  + 'progress is not affected, and alerts already raised keep the urgency they were raised with.'
