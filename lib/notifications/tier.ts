/**
 * The urgency tier of a notification, as the API sends it.
 *
 * READ, NOT DERIVED. The tier is computed server-side from the row's
 * `alert_type_id` through the catalogue and sent as its own field. Rebuilding it
 * here would be one fact in two places with a network hop between them -- and it
 * is not merely redundant, it is impossible: `critical` is not exclusive to
 * alerts, because `tenant-sync.service.ts` publishes a lost Microsoft connection
 * at `critical` through the same `publishIncident`. Anything inverting severity
 * back to a tier badges a disconnected tenant as ACT_NOW, on rows that exist in
 * production today.
 *
 * FOUR ARMS HERE WHERE THE API HAS THREE, and the fourth is the reason this file
 * exists rather than a cast. The API's union says TIER, NOT_AN_ALERT or
 * UNKNOWN_ALERT_TYPE -- all three are the API SAYING something. A response with
 * no `tier` field at all is the API saying NOTHING, which happens against a
 * backend older than the field and against any row this build cannot read.
 * Collapsing that into NOT_AN_ALERT would turn "we were not told" into "this is
 * not an alert", which is the same merge the empty inbox made and the same one
 * the settings page had to be built around.
 */

/** The tiers, which are the catalogue's vocabulary and the same three the
 * organisation's alert settings page offers. Not the wire's severity words. */
export const NOTIFICATION_TIERS = ['ACT_NOW', 'ACT_TODAY', 'RECORD_ONLY'] as const

export type NotificationTierName = (typeof NOTIFICATION_TIERS)[number]

export type ReadTier =
  /** The API gave a tier. */
  | { kind: 'TIER'; tier: NotificationTierName }
  /** The API said this row is not an alert. A collector row, a sync failure. */
  | { kind: 'NOT_AN_ALERT' }
  /** The API had an alert type id its catalogue does not contain. A fact about
   * the data, reported rather than defaulted into a tier. */
  | { kind: 'UNKNOWN_ALERT_TYPE'; alertTypeId: string }
  /** The API did not say. NOT a claim that this is not an alert. */
  | { kind: 'NOT_STATED' }

function isTierName(value: unknown): value is NotificationTierName {
  return (NOTIFICATION_TIERS as readonly unknown[]).includes(value)
}

/**
 * One row's `tier` field.
 *
 * Anything that is not one of the three shapes the API documents reaches
 * NOT_STATED rather than being coerced. A malformed tier is not evidence about
 * the row, and the mildest tier is the one a coercion would reach for.
 */
export function readTier(value: unknown): ReadTier {
  if (typeof value !== 'object' || value === null) return { kind: 'NOT_STATED' }
  const carried = value as Record<string, unknown>

  if (carried.kind === 'TIER') {
    return isTierName(carried.tier)
      ? { kind: 'TIER', tier: carried.tier }
      : // The API claimed a tier and named one this build does not have. Not
        // NOT_AN_ALERT -- it plainly is an alert -- and not a guess either.
        { kind: 'NOT_STATED' }
  }
  if (carried.kind === 'NOT_AN_ALERT') return { kind: 'NOT_AN_ALERT' }
  if (carried.kind === 'UNKNOWN_ALERT_TYPE') {
    return typeof carried.alertTypeId === 'string' && carried.alertTypeId !== ''
      ? { kind: 'UNKNOWN_ALERT_TYPE', alertTypeId: carried.alertTypeId }
      : { kind: 'NOT_STATED' }
  }
  return { kind: 'NOT_STATED' }
}

/**
 * Whether this row's own severity should be shown instead of a tier.
 *
 * Exactly one vocabulary per row. A row showing "Critical" and "Act now"
 * together is the two-vocabularies problem rendered: they are the same fact
 * under two names, and a reader comparing the inbox with the settings page
 * cannot tell whether they are looking at one alert or two things.
 *
 * A collector row has no tier and its severity IS its urgency, so it keeps it.
 * An alert row has a tier, and the tier is the word the settings page uses.
 */
export function showsSeverityInstead(tier: ReadTier): boolean {
  return tier.kind !== 'TIER'
}

/**
 * Whether this row is shown regardless of the reader's in-app switch.
 *
 * A FACT ABOUT `severity`, NOT ABOUT THE TIER, and that is the whole reason it
 * lives here as its own function. `visibilityFilter` in
 * `notifications.service.ts` admits `severity: 'critical'` rows whatever the
 * user's in-app preference says, and it matches on `severity` -- so the rule
 * covers an ACT_NOW alert (which the pipeline writes as `critical`) exactly as
 * it covers a lost Microsoft connection.
 *
 * The note explaining it was previously read off the severity copy table, so it
 * disappeared the moment a row started showing its tier instead -- silently
 * dropping the explanation from the rows where somebody is most likely to ask
 * why they are seeing this after muting. Found by rendering the two side by
 * side. Nothing could have failed, because the note was still correct wherever
 * it did appear.
 */
export function shownDespiteMuting(severity: string | undefined): boolean {
  return severity === 'critical'
}
