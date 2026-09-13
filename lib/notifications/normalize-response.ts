import { readTier, type ReadTier } from './tier.ts'

export type NotificationCategory = 'success' | 'info' | 'warning' | 'error'

/**
 * The severity a notification row actually arrives with.
 *
 * THIS IS THE WIRE'S VOCABULARY, NOT THE CATALOGUE'S. An earlier version of this
 * type was `ACT_NOW | ACT_TODAY | RECORD_ONLY` -- the alerting catalogue's
 * tiers -- written while the backend notification write was assumed not to be
 * landed. It was landed. `finding-pipeline.ts` translates the tier into this
 * vocabulary on the way in (`ACT_NOW -> critical`, `ACT_TODAY -> high`,
 * `RECORD_ONLY -> info`) and `notifications.service.ts` passes
 * `row.severity` straight through. So every alert-backed row arrived as
 * `critical`, `high` or `info`, matched none of the three tiers, and was
 * dropped here -- visible in no badge, which is indistinguishable from alerting
 * not working. The backend's own comment warns against exactly this, about a
 * second producer; it arrived from the reader instead.
 *
 * THE TIER NOW TRAVELS AS ITS OWN FIELD, AND IS STILL NOT REBUILT HERE. When
 * this comment was written the list response sent no tier and no alert type id;
 * b5e2c79 added both, deriving the tier server-side through the catalogue. It is
 * read by `./tier.ts` and never reconstructed, because `severity` cannot be
 * inverted into a tier: `tenant-sync.service.ts` publishes collector rows at
 * `critical` too (a lost Microsoft connection), so `critical -> ACT_NOW` would
 * label a disconnected tenant an ACT_NOW alert. That is a correctness argument,
 * not a preference about deriving twice.
 *
 * `severity` is still sent and still read, because a row that is not an alert has
 * no tier and its severity IS its urgency.
 *
 * Optional because most notifications say nothing about urgency, and absent
 * means "this row did not say" rather than "nothing is urgent".
 */
export const NOTIFICATION_SEVERITIES = [
  'info',
  'low',
  'medium',
  'high',
  'critical',
] as const

export type NotificationSeverity = (typeof NOTIFICATION_SEVERITIES)[number]

export interface NotificationItem {
  id: string
  category: NotificationCategory
  title: string
  description: string
  timestamp: string
  read: boolean
  actionUrl?: string
  actionLabel?: string
  occurrenceCount?: number
  resolved?: boolean
  /** Present only on alert-backed rows. Absent is "not said", not "not urgent". */
  severity?: NotificationSeverity
  /** Which alert type raised this, when one did. */
  alertTypeId?: string
  /**
   * The urgency tier, as the API sends it.
   *
   * ALWAYS PRESENT, unlike `severity`, because its NOT_STATED arm already
   * carries "the API did not say". A conditional key here would give absence
   * two spellings -- a missing key and a NOT_STATED value -- and a reader
   * checking one of them would miss the other.
   */
  tier: ReadTier
}

export interface NotificationRefreshResult {
  items: NotificationItem[]
  shouldReplace: boolean
}

interface NotificationDiagnostics {
  error: (message: string, context?: unknown) => void
  warn: (message: string, context?: unknown) => void
}

const categories = new Set<NotificationCategory>([
  'success',
  'info',
  'warning',
  'error',
])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function parseNotificationItem(value: unknown): NotificationItem | null {
  if (!isRecord(value)) return null

  const { id, category, title, description, timestamp, read } = value
  if (
    typeof id !== 'string' ||
    id.length === 0 ||
    typeof category !== 'string' ||
    !categories.has(category as NotificationCategory) ||
    typeof title !== 'string' ||
    typeof description !== 'string' ||
    typeof timestamp !== 'string' ||
    Number.isNaN(Date.parse(timestamp)) ||
    typeof read !== 'boolean'
  ) {
    return null
  }

  const occurrenceCount =
    typeof value.occurrenceCount === 'number' &&
    Number.isInteger(value.occurrenceCount) &&
    value.occurrenceCount >= 0
      ? value.occurrenceCount
      : undefined
  const resolved =
    typeof value.resolved === 'boolean' ? value.resolved : undefined
  // A severity this build does not recognise is dropped rather than guessed.
  // Rendering an unknown severity as the mildest one would be the reassuring
  // direction of the same error the inbox already made. Checked against the list
  // the backend declares, so a value added there fails a test here rather than
  // disappearing from the screen.
  const alertTypeId = optionalString(value.alertTypeId)
  // NOT DERIVED FROM `severity` OR FROM `alertTypeId`. The API computes the tier
  // from the row's alert type through the catalogue and sends it; rebuilding it
  // here would need a copy of the catalogue on the client, and inverting
  // `severity` is not merely redundant but wrong -- `critical` is also what a
  // lost Microsoft connection is published at.
  const tier = readTier(value.tier)
  const severity = (NOTIFICATION_SEVERITIES as readonly string[]).includes(
    value.severity as string
  )
    ? (value.severity as NotificationSeverity)
    : undefined

  return {
    id,
    category: category as NotificationCategory,
    title,
    description,
    timestamp,
    read,
    actionUrl: optionalString(value.actionUrl),
    actionLabel: optionalString(value.actionLabel),
    occurrenceCount,
    resolved,
    // Spread conditionally so an absent severity is an ABSENT KEY rather than a
    // key holding undefined. The two are equal to a reader and not to a deep
    // comparison, and "this row said nothing about urgency" is better carried
    // by the field not being there.
    tier,
    ...(severity ? { severity } : {}),
    ...(alertTypeId ? { alertTypeId } : {}),
  }
}

function extractItems(value: unknown): unknown[] | null {
  if (Array.isArray(value)) return value
  if (!isRecord(value)) return null
  if (Array.isArray(value.items)) return value.items

  const data = value.data
  if (isRecord(data) && Array.isArray(data.items)) return data.items
  return null
}

function responseShape(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  if (isRecord(value)) return `object(${Object.keys(value).join(', ') || 'empty'})`
  return typeof value
}

export function normalizeNotificationResponse(
  value: unknown
): {
  items: NotificationItem[]
  validShape: boolean
  sourceCount: number
  invalidItemCount: number
} {
  const sourceItems = extractItems(value)
  if (!sourceItems) {
    return {
      items: [],
      validShape: false,
      sourceCount: 0,
      invalidItemCount: 0,
    }
  }

  const items = sourceItems
    .map(parseNotificationItem)
    .filter((item): item is NotificationItem => item !== null)

  return {
    items,
    validShape: true,
    sourceCount: sourceItems.length,
    invalidItemCount: sourceItems.length - items.length,
  }
}

export async function requestNotifications(
  request: () => Promise<unknown>,
  diagnostics: NotificationDiagnostics = console
): Promise<NotificationRefreshResult> {
  try {
    const response = await request()
    const normalized = normalizeNotificationResponse(response)

    if (!normalized.validShape) {
      diagnostics.error(
        'Notification API returned an unsupported response shape; preserving the previous notification list.',
        { responseShape: responseShape(response) }
      )
      return { items: [], shouldReplace: false }
    }

    if (normalized.invalidItemCount > 0) {
      diagnostics.warn(
        'Notification API returned invalid notification entries; invalid entries were discarded.',
        {
          received: normalized.sourceCount,
          accepted: normalized.items.length,
          discarded: normalized.invalidItemCount,
        }
      )
    }

    if (normalized.sourceCount > 0 && normalized.items.length === 0) {
      diagnostics.error(
        'Notification API returned no valid notification entries; preserving the previous notification list.'
      )
      return { items: [], shouldReplace: false }
    }

    return { items: normalized.items, shouldReplace: true }
  } catch (error) {
    diagnostics.error(
      'Notification API request failed; preserving the previous notification list.',
      error
    )
    return { items: [], shouldReplace: false }
  }
}
