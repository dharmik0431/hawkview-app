export type NotificationCategory = 'success' | 'info' | 'warning' | 'error'

/**
 * How urgently an alert-backed notification needs somebody, in the vocabulary
 * the alerting catalogue already uses.
 *
 * Optional because most notifications are not alerts, and because the backend
 * write that carries it is not landed. Absent means "this row did not say",
 * which is not the same as RECORD_ONLY -- a row with no severity is not a
 * declaration that nothing is urgent.
 */
export type NotificationSeverity = 'ACT_NOW' | 'ACT_TODAY' | 'RECORD_ONLY'

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
  // Rendering an unknown tier as the mildest one would be the reassuring
  // direction of the same error the inbox already made.
  const alertTypeId = optionalString(value.alertTypeId)
  const severity =
    value.severity === 'ACT_NOW' ||
    value.severity === 'ACT_TODAY' ||
    value.severity === 'RECORD_ONLY'
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
