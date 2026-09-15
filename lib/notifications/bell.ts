/**
 * What the bell shows before anybody opens it.
 *
 * THE PANEL WAS MADE HONEST AND THE BELL WAS NOT. `EmptyInbox` distinguishes
 * four feed states and says, for UNAVAILABLE, "No request has succeeded, so
 * HawkView cannot say whether anything needs you. This is not an empty inbox."
 * That sentence is only ever read by somebody who opened the panel. The bell
 * itself rendered `unreadCount > 0 && <badge>`, and `unreadCount` is derived
 * from the list -- which is empty when nothing has ever loaded. So a failed
 * inbox and a quiet one drew the identical bell, and its aria-label asserted
 * "0 unread" in both.
 *
 * That is the same defect the empty state was built to remove, arriving one
 * level up and as an ABSENCE rather than a sentence: nothing on the bell reads
 * as "nothing needs me", and a reader who trusts it never opens the panel to
 * find out we could not look. The invariant the settings page arrived at --
 * always loading, explaining, or listing, never none of them -- applies here
 * too, and the bell was the "none of them" case.
 *
 * THE RULE IS NOT RESTATED HERE. Whether an empty list may be read as "quiet"
 * is already decided by `emptyMeansQuiet`, and a second copy of that judgement
 * on the bell could drift from the one in the panel -- which would put two
 * different answers to one question on one screen.
 */

import { emptyMeansQuiet, type NotificationFeedState } from './feed-state.ts'

export type BellIndicator =
  /** A number we stand behind. `asOfLastCheck` when the latest refresh failed:
   * the count was true at a known point and anything since is not in it. */
  | { kind: 'COUNT'; unread: number; asOfLastCheck: boolean }
  /** Nothing is waiting, and a read succeeded recently enough to say so. The
   * only state a bare bell is honest in. */
  | { kind: 'QUIET' }
  /** We cannot say. Not zero. Must not render as a bare bell. */
  | { kind: 'UNKNOWN'; because: NotificationFeedState }

/**
 * @param state whether the feed has ever loaded and whether the last read failed
 * @param unread how many unread rows the current list holds, which is zero both
 *   when nothing is unread and when there is no list
 */
export function bellIndicator(
  state: NotificationFeedState,
  unread: number
): BellIndicator {
  // A count we actually have is worth showing whatever the feed state, because
  // those rows were really returned by a read that really succeeded. STALE only
  // qualifies it: the number was true as of the last successful check.
  if (unread > 0) {
    return { kind: 'COUNT', unread, asOfLastCheck: state === 'STALE' }
  }
  // ZERO IS THE DANGEROUS VALUE, and it is where the two meanings collapse.
  // Only a state that may be read as "quiet" gets to render as quiet; every
  // other zero is a statement about HawkView rather than about the tenant.
  return emptyMeansQuiet(state)
    ? { kind: 'QUIET' }
    : { kind: 'UNKNOWN', because: state }
}

/**
 * What a screen reader is told the bell means.
 *
 * Separate from the visual because the old aria-label was the more explicit
 * version of the same lie: it interpolated the count unconditionally and so
 * announced "Notifications (0 unread)" over an inbox nobody had managed to
 * read. A sighted reader at least saw an unmarked bell; this asserted the zero.
 */
export function bellLabel(indicator: BellIndicator): string {
  if (indicator.kind === 'COUNT') {
    return indicator.asOfLastCheck
      ? `Notifications (${indicator.unread} unread as of the last successful check)`
      : `Notifications (${indicator.unread} unread)`
  }
  if (indicator.kind === 'QUIET') return 'Notifications (none unread)'
  return indicator.because === 'LOADING'
    ? 'Notifications (still checking)'
    : 'Notifications (unread count unavailable)'
}
