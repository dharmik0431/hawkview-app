/**
 * What the alert settings page shows, as one decision instead of four.
 *
 * The page previously computed this inline: an `empty` ternary, a `discarded`
 * ternary, a `because` ternary, and `rows.length > 0` on the list. Each was
 * right, and the property that matters is not a property of any one of them --
 * it is that THE EMPTY-STATE CARD AND THE LIST ARE NEVER BOTH ON SCREEN. Spread
 * across four expressions that invariant is emergent, held up by the fact that
 * `emptinessCopy` happens to return null for HAS_ITEMS. Nothing stated it and
 * nothing could fail if an edit broke it.
 *
 * That matters here specifically because the endpoint does not exist yet, so
 * the state this page ships in is the empty one. The first time it renders rows
 * will be the first time anybody sees the transition, and "the empty copy is
 * still there under the list" is the kind of thing that survives a demo.
 */

import { emptinessCopy, type AlertDispositionRow } from './dispositions.ts'
import { emptinessOf, type DispositionsRead } from './read-dispositions.ts'

export type SettingsPhase =
  | { phase: 'LOADING' }
  | { phase: 'READ'; read: DispositionsRead }

export type SettingsView = {
  /** No read has completed. Not a claim about the organisation. */
  loading: boolean
  /** The empty-state card, or null when there is a list to show instead. */
  empty: { title: string; detail: string } | null
  /** Why the read failed, when it did. Shown beside the empty card. */
  because: string | null
  /** Rows the response carried that this build could not read. */
  discarded: number
  /** The rows to render. Empty whenever `empty` is set. */
  rows: AlertDispositionRow[]
}

/**
 * @param state whether a read has completed, and what it produced
 * @param rows the rows currently held, which the page mutates as settings are
 *   saved -- so emptiness is decided from these rather than from the rows the
 *   read originally carried
 */
export function settingsView(
  state: SettingsPhase,
  rows: AlertDispositionRow[]
): SettingsView {
  if (state.phase === 'LOADING') {
    return { loading: true, empty: null, because: null, discarded: 0, rows: [] }
  }

  const { read } = state
  const emptiness = emptinessOf(
    read.outcome === 'LOADED' ? { ...read, rows } : read
  )
  const empty = emptinessCopy(emptiness)

  return {
    loading: false,
    empty,
    because: read.outcome === 'LOADED' ? null : read.because,
    discarded: read.outcome === 'LOADED' ? read.discarded : 0,
    // THE INVARIANT, WRITTEN DOWN RATHER THAN ARRIVED AT. An empty-state card
    // claims there is nothing to show; a list beside it says otherwise. Rather
    // than trusting that the two conditions stay complementary, one of them is
    // derived from the other.
    rows: empty === null ? rows : [],
  }
}
