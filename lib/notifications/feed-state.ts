/**
 * Whether the inbox can be believed when it is empty.
 *
 * An empty list has two causes and the panel used to render one sentence for
 * both: "You're all caught up" appeared whether nothing had happened or nothing
 * had ever been fetched. `requestNotifications` returns
 * `{ items: [], shouldReplace: false }` for a thrown request AND for a response
 * this build cannot read, so the provider keeps the list it had -- which on a
 * first load is empty -- and the screen reassures the reader about a request
 * that never succeeded.
 *
 * That is the defect this product exists to remove, appearing in its own
 * notification bell: a confident nothing standing where the truth is that we
 * could not look. It matters most on day one, when production holds zero
 * findings and every MSP sees an empty inbox for real reasons.
 *
 * Lives here rather than inside the provider so the rule has ONE definition.
 * A copy in the test would agree with itself by construction and could not fail
 * when the provider's copy changed.
 */
export type NotificationFeedState =
  /** No read has completed yet. Not a claim about the tenant. */
  | 'LOADING'
  /** At least one read succeeded and this list is what it returned. */
  | 'LOADED'
  /** No read has EVER succeeded. Nothing here describes the tenant. */
  | 'UNAVAILABLE'
  /** A read succeeded before; the most recent one did not. The list may be old. */
  | 'STALE'

/**
 * @param everLoaded whether any read has ever replaced the list
 * @param lastReadFailed whether the most recent read told us nothing
 */
export function notificationFeedState(
  everLoaded: boolean,
  lastReadFailed: boolean
): NotificationFeedState {
  if (!everLoaded) return lastReadFailed ? 'UNAVAILABLE' : 'LOADING'
  return lastReadFailed ? 'STALE' : 'LOADED'
}

/**
 * Whether an empty list in this state may be read as "the tenant is quiet".
 *
 * True for exactly one state. Every other state is a statement about HawkView
 * rather than about the tenant, and the panel must not reassure from any of
 * them.
 */
export function emptyMeansQuiet(state: NotificationFeedState): boolean {
  return state === 'LOADED'
}
