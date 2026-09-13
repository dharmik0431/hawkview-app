/**
 * Reading the organisation's alert settings, and being honest about what came
 * back.
 *
 * THE DISTINCTION THIS FILE EXISTS FOR: an empty list and a failed read are not
 * the same screen, and `items.length === 0` cannot tell them apart. This product
 * already shipped that merge twice -- a source reporting READY and CURRENT
 * having observed nothing, and a notification bell saying "You're all caught up"
 * about a request that never succeeded. The settings page is where an MSP
 * decides what wakes them up, so a confident "nothing is configured" over a
 * request that failed is the most expensive place left to make it.
 *
 * There is a third case, and it is the one that gets missed: a response that
 * ARRIVED but that this build cannot read. It has a body, it has a 200, and
 * every row in it was discarded. That is not an empty result -- it is a failed
 * read wearing an empty result's clothes, and it resolves to NEVER_OBSERVED
 * here rather than to NOTHING_MATCHED.
 */

import {
  type AlertDisposition,
  type AlertDispositionRow,
  type Emptiness,
} from './dispositions.ts'

const DISPOSITIONS: readonly AlertDisposition[] = [
  'ACT_NOW',
  'ACT_TODAY',
  'RECORD_ONLY',
]

/**
 * What one read produced.
 *
 * `UNREADABLE` and `FAILED` are kept apart even though both render the same
 * empty state, because they are different facts about where the problem is and
 * a log that merges them cannot tell an outage from a contract change.
 */
export type DispositionsRead =
  | {
      outcome: 'LOADED'
      rows: AlertDispositionRow[]
      /**
       * Stored settings whose alert type id the catalogue does not declare.
       *
       * THESE HAVE NO ROW TO APPEAR ON. `list()` walks the catalogue, so a
       * stored row keyed to an id that is no longer declared is invisible to it
       * -- seven rows come back and none mentions it. The endpoint lists them at
       * the envelope instead, and dropping them here would put the page back
       * where it was before `storedValueIgnored`: a setting somebody made,
       * doing nothing, with nothing on screen saying so.
       *
       * This is the second field of this kind I would have discarded by reading
       * only what I expected. Both were surfaced deliberately by the producer.
       */
      unrecognisedKeys: string[]
      /**
       * Rows the response carried that this build could not read.
       *
       * Surfaced rather than swallowed. A list quietly one row short is a list
       * an MSP will trust completely, and the missing row is the alert type
       * nobody has configured.
       */
      discarded: number
    }
  | { outcome: 'UNREADABLE'; because: string }
  | { outcome: 'FAILED'; because: string }

function isDisposition(value: unknown): value is AlertDisposition {
  return DISPOSITIONS.includes(value as AlertDisposition)
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null
}

/**
 * One row, or null when it cannot be read as a setting.
 *
 * A row whose `disposition` or `catalogueSeverity` is unrecognised is dropped
 * WHOLE rather than rendered with the field missing. Everywhere else in this
 * codebase an unreadable field is dropped and the row kept, and that is right
 * where the field is an embellishment. Here the disposition IS the row: a
 * settings line that cannot say what the setting is would be a control with no
 * state, and a reader would take the first radio button's position as the
 * answer.
 *
 * `mapped` is required rather than defaulted. Defaulting it to true would
 * quietly promise that something feeds this alert type, which is the assurance
 * a person would rely on when they set it.
 */
export function readDispositionRow(value: unknown): AlertDispositionRow | null {
  if (typeof value !== 'object' || value === null) return null
  const row = value as Record<string, unknown>

  const alertTypeId = text(row.alertTypeId)
  const title = text(row.title)
  const category = text(row.category)
  if (!alertTypeId || !title || !category) return null
  if (!isDisposition(row.disposition)) return null
  if (!isDisposition(row.catalogueSeverity)) return null
  if (typeof row.mapped !== 'boolean') return null

  // A STORED VALUE THE BACKEND COULD NOT READ, CARRIED RATHER THAN DROPPED.
  // The endpoint reports it deliberately: `disposition` already says what the
  // product will do, and that is true, but without this the row would look like
  // nobody had chosen. It is a setting somebody made that is being ignored, and
  // it belongs on the row where they made it.
  const storedValueIgnored = text(row.storedValueIgnored)

  return {
    alertTypeId,
    title,
    category,
    catalogueSeverity: row.catalogueSeverity,
    disposition: row.disposition,
    mapped: row.mapped,
    ...(storedValueIgnored ? { storedValueIgnored } : {}),
  }
}

/**
 * The whole response.
 *
 * Presence-based: the body must carry an array where the array is expected. A
 * body that is not that shape is UNREADABLE, not an empty organisation.
 */
export function readDispositions(body: unknown): DispositionsRead {
  // THE KEY IS `dispositions`, WHICH I LEARNED BY READING THE ENDPOINT RATHER
  // THAN BY ASSUMING. This accepted a bare array or `{ items }` -- both guesses,
  // written before the endpoint existed. The real response is
  // `{ organizationId, dispositions }`, so the page would have reported the
  // live API as UNREADABLE and shown "no request has succeeded" over a perfectly
  // good response. `items` is kept because nothing costs less and a reader that
  // accepts more shapes is not the risk here; a reader that accepts FEWER than
  // the producer sends is.
  const fromKey = (key: string): unknown[] | null => {
    if (typeof body !== 'object' || body === null) return null
    const value = (body as Record<string, unknown>)[key]
    return Array.isArray(value) ? (value as unknown[]) : null
  }
  const container = Array.isArray(body)
    ? body
    : fromKey('dispositions') ?? fromKey('items')

  if (container === null) {
    return {
      outcome: 'UNREADABLE',
      because: 'The alert settings response did not contain a list of alert types.',
    }
  }

  // Read from the envelope rather than the array, because that is where the
  // endpoint puts them -- they have no row.
  const unrecognisedKeys =
    typeof body === 'object' && body !== null
      ? ((body as Record<string, unknown>).unrecognisedKeys ?? [])
      : []
  const keys = Array.isArray(unrecognisedKeys)
    ? unrecognisedKeys
        .map((each) => (typeof each === 'string' && each.trim() ? each : null))
        .filter((each): each is string => each !== null)
    : []

  const rows: AlertDispositionRow[] = []
  for (const entry of container) {
    const row = readDispositionRow(entry)
    if (row) rows.push(row)
  }
  const discarded = container.length - rows.length

  // A RESPONSE WHOSE EVERY ROW WAS DISCARDED IS NOT AN EMPTY ORGANISATION.
  // Without this the two are indistinguishable downstream: both arrive as a
  // zero-length array, and the page would say "HawkView asked and the catalogue
  // returned nothing" about a contract it simply could not read. That sentence
  // is a claim about the organisation, and it would be false.
  if (container.length > 0 && rows.length === 0) {
    return {
      outcome: 'UNREADABLE',
      because:
        'The alert settings response carried ' +
        container.length +
        ' alert ' +
        (container.length === 1 ? 'type' : 'types') +
        ', and this version of HawkView could not read any of them.',
    }
  }

  return { outcome: 'LOADED', rows, discarded, unrecognisedKeys: keys }
}

/**
 * Which empty state a read earns.
 *
 * The only mapping that may produce NOTHING_MATCHED is a read that succeeded
 * AND was understood. Both failure outcomes go to NEVER_OBSERVED, because
 * neither is a statement about the organisation.
 */
export function emptinessOf(read: DispositionsRead): Emptiness {
  if (read.outcome !== 'LOADED') return { kind: 'NEVER_OBSERVED' }
  return read.rows.length === 0
    ? { kind: 'NOTHING_MATCHED' }
    : { kind: 'HAS_ITEMS' }
}
