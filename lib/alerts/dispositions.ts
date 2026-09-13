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
}

/* -------------------------------------------------------------------------- */
/* What each tier actually delivers, as data                                  */
/* -------------------------------------------------------------------------- */

export type DeliveryChannel = 'PHONE' | 'EMAIL' | 'IN_APP'

export type ChannelState = {
  channel: DeliveryChannel
  /**
   * Whether this channel can carry anything today.
   *
   * SMS is deferred: the channel was shelved and the tier kept, so ACT_NOW will
   * keep meaning "phone" in the routing table long after nothing can dial. A
   * label derived from the tier's name would promise a call until somebody
   * remembered to edit a string; a label derived from THIS stops promising it
   * the moment the channel goes dark.
   */
  live: boolean
  /** Why it cannot carry anything, when it cannot. */
  deferredBecause?: string
}

/**
 * The channels behind each tier, and whether each one works.
 *
 * Carried as data rather than derived from the tier name. That is the whole
 * point: the tier is a property of the finding, the channel is a property of
 * how we can reach somebody today, and exactly one of those has changed.
 */
export type TierChannels = Readonly<
  Record<AlertDisposition, readonly ChannelState[]>
>

export const TIER_CHANNELS: TierChannels = {
  ACT_NOW: [
    {
      channel: 'PHONE',
      live: false,
      deferredBecause:
        'Phone delivery is not available yet — carrier registration, consent and retention obligations are outstanding.',
    },
    { channel: 'EMAIL', live: true },
    { channel: 'IN_APP', live: true },
  ],
  ACT_TODAY: [
    { channel: 'EMAIL', live: true },
    { channel: 'IN_APP', live: true },
  ],
  RECORD_ONLY: [{ channel: 'IN_APP', live: true }],
}

const CHANNEL_NAMES: Record<DeliveryChannel, string> = {
  PHONE: 'phone',
  EMAIL: 'email',
  IN_APP: 'in-app',
}

export const DISPOSITION_LABELS: Record<AlertDisposition, string> = {
  ACT_NOW: 'Act now',
  ACT_TODAY: 'Act today',
  RECORD_ONLY: 'Record only',
}

export type DeliveryDescription = {
  /** What an MSP gets today. Never mentions a channel that is not live. */
  today: string
  /** What is not available and why. Empty when nothing is deferred. */
  deferred: string[]
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
  // Taken as a parameter rather than read from the module so the derivation can
  // be demonstrated against a table where a channel is dark, without mutating
  // shared state to do it. A test that had to reach in and change the real
  // table would be testing its own mutation as much as the function.
  channelTable: TierChannels = TIER_CHANNELS
): DeliveryDescription {
  const channels = channelTable[disposition]
  const live = channels.filter((entry) => entry.live)
  const deferred = channels.filter((entry) => !entry.live)

  const names = live.map((entry) => CHANNEL_NAMES[entry.channel])
  const joined =
    names.length === 0
      ? null
      : names.length === 1
        ? names[0]
        : names.slice(0, -1).join(', ') + ' and ' + names[names.length - 1]

  const today =
    joined === null
      ? 'Nothing can be delivered for this tier today. It is recorded and visible here only.'
      : disposition === 'RECORD_ONLY'
        ? 'Recorded and visible here. Not delivered.'
        : `Delivered by ${joined}, marked ${DISPOSITION_LABELS[disposition].toLowerCase()}.`

  return {
    today,
    deferred: deferred.map(
      (entry) =>
        entry.deferredBecause ??
        `${CHANNEL_NAMES[entry.channel]} delivery is not available yet.`
    ),
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
 */
export const SAVED_APPLIES_FROM =
  'Saved. This applies from the next evaluation run — a run already in progress is not affected.'
