import assert from 'node:assert/strict'
import test from 'node:test'
import { type AlertDispositionRow } from './dispositions.ts'
import { readDispositions, type DispositionsRead } from './read-dispositions.ts'
import { settingsView, type SettingsPhase } from './settings-view.ts'

const row: AlertDispositionRow = {
  alertTypeId: 'security.suspected_credential_attack',
  title: 'Suspected credential attack',
  category: 'Security',
  catalogueSeverity: 'ACT_NOW',
  disposition: 'ACT_NOW',
  mapped: true,
}

const wire = (over: Record<string, unknown> = {}) => ({ ...row, ...over })

/** Every state the page can actually be in, built through the real reader
 * rather than by constructing DispositionsRead values by hand -- a hand-built
 * union member can be a shape the reader never produces, and then the sweep
 * below would be over states that cannot occur. */
const STATES: { name: string; state: SettingsPhase; rows: AlertDispositionRow[] }[] =
  [
    { name: 'loading', state: { phase: 'LOADING' }, rows: [] },
    {
      name: 'loaded with rows',
      state: { phase: 'READ', read: readDispositions({ items: [wire()] }) },
      rows: [row],
    },
    {
      name: 'loaded, genuinely empty',
      state: { phase: 'READ', read: readDispositions({ items: [] }) },
      rows: [],
    },
    {
      name: 'unreadable shape',
      state: { phase: 'READ', read: readDispositions({ nope: true }) },
      rows: [],
    },
    {
      name: 'every row discarded',
      state: {
        phase: 'READ',
        read: readDispositions({ items: [{ alertTypeId: 'a' }] }),
      },
      rows: [],
    },
    {
      name: 'request failed',
      state: {
        phase: 'READ',
        read: { outcome: 'FAILED', because: 'HawkView API returned 404.' },
      },
      rows: [],
    },
    // THE TWO STATES WHERE `rows` DIVERGES FROM WHAT THE READ CARRIED, and the
    // only ones that can kill the guard. Without them every fixture passed rows
    // equal to the read's own, so `rows: empty === null ? rows : []` could be
    // deleted outright and nothing failed -- a sweep that looked exhaustive and
    // never built the one input it exists for.
    {
      // A read that failed while the page still holds rows from an earlier one.
      // Not reachable today because the page fetches once, and one retry away
      // from being reachable: the screen would then carry a list beside 'no
      // request has succeeded', which is the STALE-versus-UNAVAILABLE confusion
      // the notification feed already had to be rebuilt around.
      name: 'failed read, rows still held from before',
      state: {
        phase: 'READ',
        read: { outcome: 'FAILED', because: 'The connection dropped.' },
      },
      rows: [row],
    },
    {
      // A read this build could not parse, with rows still on screen.
      name: 'unreadable response, rows still held',
      state: { phase: 'READ', read: readDispositions({ nope: true }) },
      rows: [row],
    },
    {
      // A LOADED read whose rows are gone from the live list. Emptiness must
      // follow the LIVE rows, not the ones the response carried, or the page
      // shows an empty list with no explanation of why it is empty.
      name: 'loaded, but the live rows are empty',
      state: { phase: 'READ', read: readDispositions({ items: [wire()] }) },
      rows: [],
    },
    {
      name: 'partly readable',
      state: {
        phase: 'READ',
        read: readDispositions({
          items: [wire(), wire({ alertTypeId: 'b', disposition: 'NONSENSE' })],
        }),
      },
      rows: [row],
    },
  ]

test('the empty card and the list are never both on screen', () => {
  // THE INVARIANT THE PAGE USED TO HOLD BY ACCIDENT. It was spread across four
  // inline ternaries and rested on emptinessCopy returning null for HAS_ITEMS.
  // Nothing stated it, so nothing could fail if an edit broke it -- and the
  // state this page ships in is the empty one, which means the first time
  // anybody sees the transition is the first time it renders rows.
  for (const { name, state, rows } of STATES) {
    const view = settingsView(state, rows)
    assert.ok(
      !(view.empty && view.rows.length > 0),
      name + ' showed an empty-state card above a list of ' + view.rows.length
    )
    assert.ok(
      !(view.loading && (view.empty || view.rows.length > 0)),
      name + ' claimed to be loading while showing a result'
    )
  }

  // AND THE PAGE ALWAYS SAYS SOMETHING. Every state must be loading, or carry
  // an explanation, or carry rows -- never none of the three. This is the half
  // the first version missed: deciding emptiness from the rows the RESPONSE
  // carried rather than the rows on screen produces a view with no rows and no
  // empty card, which renders as a heading over blank space. A reader takes a
  // blank page for 'nothing here', which is the same false reassurance the
  // empty states exist to prevent, arriving as an absence instead of a
  // sentence. Deleting that derivation killed no test until this assertion.
  for (const { name, state, rows } of STATES) {
    const view = settingsView(state, rows)
    assert.ok(
      view.loading || view.empty !== null || view.rows.length > 0,
      name + ' rendered a heading over blank space: no rows, and nothing saying why'
    )
  }

  // CONTROLS. The sweep above is satisfied by a view that shows nothing at all,
  // so both halves have to be demonstrated reachable: some state must produce
  // rows, and some state must produce an empty card.
  const withRows = STATES.filter(
    (each) => settingsView(each.state, each.rows).rows.length > 0
  )
  const withEmpty = STATES.filter(
    (each) => settingsView(each.state, each.rows).empty !== null
  )
  assert.ok(withRows.length >= 2, 'no state rendered any rows')
  assert.ok(withEmpty.length >= 3, 'no state rendered an empty card')
})

test('the empty copy is replaced by the list, not merely hidden behind it', () => {
  // The page holds rows in state and mutates them as settings save, so
  // emptiness is decided from the LIVE rows rather than from the ones the read
  // originally carried. This is the transition that ships: empty today,
  // populated the first time the endpoint answers.
  const read = readDispositions({ items: [wire()] })
  const before = settingsView({ phase: 'LOADING' }, [])
  const after = settingsView({ phase: 'READ', read }, [row])

  assert.equal(before.loading, true)
  assert.equal(before.rows.length, 0)
  assert.equal(after.loading, false)
  assert.equal(after.empty, null, 'the empty card survived the arrival of rows')
  assert.equal(after.rows.length, 1)
})

test('a failed read carries its reason and claims nothing about the organisation', () => {
  const failed: DispositionsRead = {
    outcome: 'FAILED',
    because: 'HawkView API returned 404.',
  }
  const view = settingsView({ phase: 'READ', read: failed }, [])
  assert.match(view.because ?? '', /404/)
  assert.ok(view.empty, 'a failed read rendered no explanation at all')
  assert.match(view.empty!.detail, /No request has succeeded/)
  assert.ok(
    !/empty result/.test(view.empty!.detail),
    'a failed read was described as an empty result'
  )

  // A successful read has no `because` to show, or the page would render an
  // error line under a perfectly good list.
  const fine = settingsView(
    { phase: 'READ', read: readDispositions({ items: [wire()] }) },
    [row]
  )
  assert.equal(fine.because, null)
})

test('the discarded count belongs to a read that succeeded', () => {
  // On a failed read there is no denominator: "1 alert type could not be read"
  // beside "no request has succeeded" would be two different stories about the
  // same request.
  const partial = settingsView(
    {
      phase: 'READ',
      read: readDispositions({
        items: [wire(), wire({ alertTypeId: 'b', disposition: 'NONSENSE' })],
      }),
    },
    [row]
  )
  assert.equal(partial.discarded, 1)
  assert.equal(partial.empty, null)

  const failed = settingsView(
    { phase: 'READ', read: { outcome: 'FAILED', because: 'gone' } },
    []
  )
  assert.equal(failed.discarded, 0)
})

test('unrecognised keys survive the view, and are not merged with discarded rows', () => {
  // THE READER CARRYING THEM IS NOT THE PAGE SEEING THEM. A mutation zeroing
  // this field in settingsView killed nothing: the reader tests covered the
  // reader and no test looked at the layer between it and the screen. Same gap
  // as the wiring checks, one module in.
  const read = readDispositions({
    organizationId: 'org-1',
    dispositions: [wire(), wire({ alertTypeId: 'b', disposition: 'NONSENSE' })],
    unrecognisedKeys: ['security.renamed_last_year'],
  })
  const view = settingsView({ phase: 'READ', read }, [row])

  assert.deepEqual(view.unrecognisedKeys, ['security.renamed_last_year'])
  // Kept apart from the discarded count on purpose: one is a row this build
  // could not parse, the other a row the catalogue does not have.
  assert.equal(view.discarded, 1)

  // A failed read has no envelope to read them from, and must not invent one.
  const failed = settingsView(
    { phase: 'READ', read: { outcome: 'FAILED', because: 'gone' } },
    []
  )
  assert.deepEqual(failed.unrecognisedKeys, [])
  assert.deepEqual(settingsView({ phase: 'LOADING' }, []).unrecognisedKeys, [])
})
