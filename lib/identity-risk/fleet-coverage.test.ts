import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import {
  fleetCoverage,
  riskyUsersSummary,
  type AssessmentCoverage,
  type TenantAssessmentStatus,
} from './fleet-coverage.ts'

/**
 * Strip comments before searching source.
 *
 * A LINE FILTER IS NOT ENOUGH. The earlier version dropped lines that START
 * with a comment marker, so the CONTINUATION lines of a multi-line JSX
 * comment block -- which are plain prose, with no marker of their own --
 * survived, and were searched as if they were code.
 * It cost a false failure here, and it is the same error as matching an
 * import or a category glyph: the check read a mention rather than a use.
 */
const stripComments = (source: string): string => {
  let out = source
  for (const [open, close] of [['{/*', '*/}'], ['/*', '*/']]) {
    for (;;) {
      const from = out.indexOf(open)
      if (from === -1) break
      const to = out.indexOf(close, from + open.length)
      if (to === -1) break
      out = out.slice(0, from) + out.slice(to + close.length)
    }
  }
  return out
    .split(String.fromCharCode(10))
    .filter((line) => !line.trim().startsWith('//'))
    .join(String.fromCharCode(10))
}

const statuses = (...pairs: [string, TenantAssessmentStatus][]) =>
  pairs.map(([tenantId, status]) => ({ tenantId, status }))

/** Fills the fields a fixture does not care about. Added when `fleet` and
 * `missed` arrived and the compiler named every literal that lacked them. */
const cov = (over: Partial<AssessmentCoverage> = {}): AssessmentCoverage => ({
  fleet: { kind: 'KNOWN' },
  inScope: 0,
  assessed: 0,
  loading: 0,
  failed: 0,
  unavailable: 0,
  missed: [],
  ...over,
})

const whole = (n: number): AssessmentCoverage => ({
  fleet: { kind: 'KNOWN' },
  missed: [],
  inScope: n,
  assessed: n,
  loading: 0,
  failed: 0,
  unavailable: 0,
})

test('exactly one empty state earns the green shield', () => {
  // THE ICON IS THE STRONGEST CLAIM ON THE SCREEN. It is read before the prose,
  // believed faster, and cannot be qualified by a clause -- so a green
  // ShieldCheck over a fleet with unassessed tenants says "you are fine" about
  // tenants nobody looked at. The tone is derived here so the markup cannot
  // hardcode reassurance.
  const quiet = riskyUsersSummary(0, whole(4), false)
  assert.equal(quiet.empty!.tone, 'QUIET')

  const unassessed: AssessmentCoverage = cov({
    inScope: 4,
    assessed: 1,
    loading: 0,
    failed: 2,
    unavailable: 1,
  })
  for (const filters of [true, false]) {
    const summary = riskyUsersSummary(0, unassessed, filters)
    assert.notEqual(
      summary.empty!.tone,
      'QUIET',
      'an unassessed fleet earned the reassuring tone'
    )
    assert.equal(summary.empty!.tone, 'UNKNOWN')
  }

  // Filters over a fully assessed fleet is its own answer -- neither reassuring
  // nor a warning about coverage.
  assert.equal(riskyUsersSummary(0, whole(4), true).empty!.tone, 'FILTERED')

  // All three reachable, or the rule above is satisfied by a page that never
  // reassures at all.
  const tones = new Set([
    riskyUsersSummary(0, whole(4), false).empty!.tone,
    riskyUsersSummary(0, whole(4), true).empty!.tone,
    riskyUsersSummary(0, unassessed, false).empty!.tone,
  ])
  assert.equal(tones.size, 3, 'not every tone is reachable')
})

test('a zero over unassessed tenants is not a zero over assessed ones', () => {
  const assessed = riskyUsersSummary(0, whole(4), false)
  const partial = riskyUsersSummary(
    0,
    cov({ inScope: 4, assessed: 1, loading: 0, failed: 3, unavailable: 0 }),
    false
  )
  assert.notEqual(assessed.empty!.title, partial.empty!.title)
  assert.equal(assessed.complete, true)
  assert.equal(partial.complete, false)
  assert.match(
    partial.empty!.detail,
    /not a statement that those tenants have no risky users/
  )
})

test('the shortfall says WHY, because the remedies differ', () => {
  // "Could not be reached" is a connection problem; "returned no assessment" is
  // a collection problem; "still loading" is not a problem at all. Collapsing
  // them into one number would send somebody to the wrong place.
  const mixed: AssessmentCoverage = cov({
    inScope: 6,
    assessed: 1,
    loading: 2,
    failed: 1,
    unavailable: 2,
  })
  const detail = riskyUsersSummary(0, mixed, false).empty!.detail
  assert.match(detail, /1 could not be reached/)
  assert.match(detail, /2 have incomplete or unavailable evidence/)
  assert.match(detail, /2 still loading/)
  assert.match(detail, /5 of 6 tenants were not assessed/)

  // Only the causes that actually occurred are named, or every screen would
  // list three problems when it has one.
  const onlyFailed = riskyUsersSummary(
    0,
    cov({ inScope: 2, assessed: 1, loading: 0, failed: 1, unavailable: 0 }),
    false
  ).empty!.detail
  assert.match(onlyFailed, /1 could not be reached/)
  assert.ok(!/still loading/.test(onlyFailed), 'named a cause that did not occur')
  assert.ok(!/returned no assessment/.test(onlyFailed))
})

test('UNAVAILABLE counts against coverage, which failedTenants did not', () => {
  // The defect in the tile that was supposed to cover for the badge. The hook
  // increments failedTenants only under `if (assessmentError)`, so a tenant
  // whose assessment came back null is UNAVAILABLE, contributes no rows, and was
  // counted as fine -- the tile read "100% tenants synced" over a fleet with
  // tenants nobody assessed.
  const coverage = fleetCoverage(
    statuses(['a', 'SUCCESS'], ['b', 'UNAVAILABLE'], ['c', 'SUCCESS']),
    'ALL'
  )
  assert.equal(coverage.inScope, 3)
  assert.equal(coverage.assessed, 2)
  assert.equal(coverage.unavailable, 1)
  assert.equal(coverage.failed, 0, 'UNAVAILABLE was miscounted as an error')

  // And it reaches the summary as an incompleteness, not as a clean fleet.
  const summary = riskyUsersSummary(0, coverage, false)
  assert.equal(summary.complete, false)
  assert.notEqual(summary.empty!.tone, 'QUIET')
})

test('coverage describes THIS view, not the whole fleet', () => {
  // With one tenant selected, "3 of 4 tenants could not be assessed" is about a
  // fleet the reader is not looking at. A reader who picked a healthy tenant
  // would be warned about somebody else's problem, and one who picked a broken
  // tenant would be told three others are fine.
  const all = statuses(
    ['a', 'SUCCESS'],
    ['b', 'FAILED'],
    ['c', 'FAILED'],
    ['d', 'FAILED']
  )
  const healthy = fleetCoverage(all, 'a')
  assert.deepEqual(healthy, {
    fleet: { kind: 'KNOWN' },
    inScope: 1,
    assessed: 1,
    loading: 0,
    failed: 0,
    unavailable: 0,
    missed: [],
  })
  assert.equal(riskyUsersSummary(0, healthy, false).empty!.tone, 'QUIET')

  const broken = fleetCoverage(all, 'b')
  assert.equal(broken.assessed, 0)
  assert.equal(riskyUsersSummary(0, broken, false).empty!.tone, 'UNKNOWN')

  // The control: unfiltered, the whole fleet is in scope.
  assert.equal(fleetCoverage(all, 'ALL').inScope, 4)
  assert.equal(fleetCoverage(all, 'ALL').assessed, 1)
})

test('an incomplete count never travels alone, and a complete one is not hedged', () => {
  const partial = riskyUsersSummary(
    7,
    cov({ inScope: 4, assessed: 2, loading: 0, failed: 2, unavailable: 0 }),
    false
  )
  assert.match(partial.headline, /7 users/)
  assert.match(partial.headline, /2 of 4 tenants/)
  assert.equal(partial.empty, null, 'a populated list rendered an empty state')

  assert.equal(riskyUsersSummary(7, whole(4), false).headline, '7 users')
  assert.equal(riskyUsersSummary(1, whole(4), false).headline, '1 user')
})

test('grammar survives the one-tenant fleet and the impossible coverage', () => {
  assert.match(
    riskyUsersSummary(0, cov({ inScope: 1, assessed: 0, loading: 0, failed: 1, unavailable: 0 }), false)
      .empty!.detail,
    /1 of 1 tenant was not assessed/
  )
  assert.match(
    riskyUsersSummary(0, cov({ inScope: 3, assessed: 1, loading: 0, failed: 2, unavailable: 0 }), false)
      .empty!.detail,
    /2 of 3 tenants were not assessed/
  )

  // `assessed` above `inScope` should be impossible; if a refactor makes it
  // possible the screen must not print a negative, which is the part a reader
  // would try to act on.
  const odd = riskyUsersSummary(
    0,
    cov({ inScope: 1, assessed: 4, loading: 0, failed: 0, unavailable: 0 }),
    false
  )
  assert.equal(odd.complete, true)
  assert.ok(!/-\d/.test(odd.headline + odd.empty!.detail))
})

test('the page actually uses this, and no longer hardcodes the shield', () => {
  // A WIRING CHECK, because the rule being right is not it reaching the screen.
  // Both wiring mutations on the dashboard killed nothing until a check like
  // this existed, and that was after the bell had taught me the same thing.
  const page = readFileSync(
    new URL('../../app/(protected)/risky-users/page.tsx', import.meta.url),
    'utf8'
  ).split(String.fromCharCode(13)).join('')

  // POSITIVE CONTROL. If the page moved, everything below passes over nothing.
  assert.ok(
    page.includes('Users requiring review'),
    'did not find the risky users list where this test expects it'
  )

  assert.ok(page.includes('riskyUsersSummary('), 'the page does not call the summary')
  assert.ok(page.includes('fleetCoverage('), 'the page does not derive coverage')

  // Comments stripped: the comments explaining this fix quote the old sentences,
  // and a check that reads prose as behaviour is wrong in both directions.
  const code = stripComments(page)

  assert.ok(
    !code.includes('{filteredRows.length} user{filteredRows.length === 1'),
    'the badge still renders a bare count'
  )
  assert.ok(
    !code.includes('Try adjusting your search terms, tenant selection, or detection source criteria.'),
    'the unconditional filter advice is still hardcoded in the page'
  )
  // The advice is correct in one case and must still be reachable through the
  // summary, or the assertion above would be satisfied by deleting it.
  assert.match(
    riskyUsersSummary(0, whole(2), true).empty!.detail,
    /Try adjusting your search terms/
  )

  // THE ICON. A shield used as REASSURANCE must be gated on the tone; a shield
  // used as a label need not be.
  //
  // Narrowed twice, both times because the check failed on correct code. It
  // first matched the lucide IMPORT rather than any rendering. It then matched
  // a purple ShieldCheck that is the category glyph on the Microsoft Detections
  // tile -- a label for a data source sitting beside a count, which claims
  // nothing about emptiness. The same error as banning the Mark-all-read button
  // for consulting a count: using the construct is not making the claim.
  //
  // Green is what makes a shield a reassurance, so that is the signal.
  const shields = code
    .split(String.fromCharCode(10))
    .map((line, i) => ({ line, i }))
    .filter((each) => each.line.includes('<ShieldCheck'))
  assert.ok(shields.length >= 1, 'no ShieldCheck remains at all')

  const codeLines = code.split(String.fromCharCode(10))
  let reassuring = 0
  for (const { line, i } of shields) {
    const context = codeLines.slice(Math.max(0, i - 12), i + 2).join(String.fromCharCode(10))
    const isReassurance =
      line.includes('emerald') || context.includes('emerald')
    if (!isReassurance) continue
    reassuring += 1
    assert.ok(
      context.includes("tone === 'QUIET'"),
      'a green ShieldCheck is rendered without the tone saying the fleet is quiet: ' +
        line.trim()
    )
  }
  // Control: the reassuring shield must still exist, or this passes vacuously
  // over a page that simply deleted it -- and being quiet IS worth saying when
  // it is true.
  assert.ok(
    reassuring >= 1,
    'no reassuring shield remains, so the gate asserted nothing'
  )
})
test('the KPI tile is gated on the same coverage as the list', () => {
  // I DIAGNOSED THIS TILE AND LEFT IT. The commit that fixed the badge and the
  // empty states said, in as many words, that "100% tenants synced" was derived
  // from failedTenants -- which counts only assessmentError -- and so claimed a
  // fully synced fleet over tenants nobody assessed. Then it changed the badge
  // and not the tile: the visible half fixed and the reassuring half left, which
  // is the exact shape the sweep was looking for.
  const page = readFileSync(
    new URL('../../app/(protected)/risky-users/page.tsx', import.meta.url),
    'utf8'
  ).split(String.fromCharCode(13)).join('')

  assert.ok(
    page.includes('Users requiring review'),
    'did not find the page where this test expects it'
  )

  const code = stripComments(page)

  assert.ok(
    !code.includes("'100% tenants synced'"),
    'the tile still claims a fully synced fleet from failedTenants'
  )
  // EVERY coverage claim, not just the tile. There were eight sites reading
  // failedTenants -- the tile, the heading, two 'N of M' lines, the styling,
  // and the partial-coverage banner, which renders only when that count is
  // above zero and so did not appear AT ALL for a fleet whose tenants came
  // back UNAVAILABLE rather than errored. Fixing one and leaving seven is the
  // shape that put this test here in the first place.
  assert.ok(
    !code.includes('metrics.failedTenants'),
    'a coverage claim still reads a count that ignores UNAVAILABLE'
  )
  assert.ok(
    code.includes('fleetWide.assessed === fleetWide.inScope'),
    'the tile is not gated on assessment coverage'
  )

  // The tile is a fleet KPI and must NOT be scoped to the tenant filter: the
  // counts beside it are unfiltered, and a tile that narrowed while they did
  // not would disagree with the numbers it sits under.
  // AND fleetSize MUST COME FROM THE TENANT-LIST ERROR. Without this, cutting
  // the page off from `isError` killed no test: the summary was right and the
  // page simply never told it the fleet was unknown. The hook has exposed
  // isError all along and the page did not destructure it.
  // Asserted as a RELATIONSHIP rather than an exact spelling. The first version
  // matched the literal line `const fleetSize: FleetSize = isError`, and broke
  // the moment the declaration was wrapped in useMemo -- a correct change. A
  // check pinned to wording fails on refactors and passes on rewrites that
  // keep the words; what matters is that the declaration reads isError.
  const declStart = code.indexOf('const fleetSize')
  assert.ok(declStart !== -1, 'the page does not declare a fleet size at all')
  const decl = code.slice(declStart, declStart + 500)
  // THE DEPENDENCY ARRAY DOES NOT COUNT. The first version of this asserted
  // that `isError` appeared anywhere in the declaration, and replacing the
  // CONDITION with `false` still passed -- because `[isError]` in the memo deps
  // kept the string present. The check has to read the branch, not the block.
  const body = decl.slice(0, decl.indexOf('[isError]') === -1 ? decl.length : decl.indexOf('[isError]'))
  assert.ok(
    body.includes('isError'),
    'fleetSize does not branch on the tenant-list error'
  )
  assert.ok(
    decl.includes("'UNKNOWN'"),
    'a failed tenant list does not produce an UNKNOWN fleet size'
  )
  assert.ok(
    code.includes("fleetCoverage(tenantStatuses, 'ALL', fleetSize)"),
    'the fleet tile is scoped to the tenant filter'
  )
})

test('a fleet of zero does not earn the shield, however it got there', () => {
  // THE DEFECT QA FOUND, AND IT WAS IN THE ONE CONDITION GUARDING THE SHIELD.
  // `complete = missing === 0` is VACUOUSLY TRUE over an empty scope --
  // "everything in scope was assessed" holds when there is nothing in scope --
  // so an empty fleet produced "No users require review", two green
  // ShieldChecks, and "All 0 tenants in scope were assessed". Identical to a
  // genuinely clean four-tenant fleet except for the digit inside the sentence
  // doing the reassuring.
  const clean = riskyUsersSummary(0, whole(4), false)
  const empty = riskyUsersSummary(0, cov(), false)

  assert.equal(clean.empty!.tone, 'QUIET')
  assert.notEqual(
    empty.empty!.tone,
    'QUIET',
    'a fleet of zero still earns the reassuring tone'
  )
  assert.equal(empty.empty!.tone, 'NO_FLEET')
  assert.notEqual(clean.empty!.title, empty.empty!.title)
  assert.equal(empty.complete, false, 'completeness was satisfied by an empty set')
})

test('an unknown fleet is answered BEFORE completeness is tested', () => {
  // THE ORDER IS THE FIX, NOT THE TYPE. A completeness test over an unknown
  // denominator is the same vacuous truth, so COULD_NOT_LOOK has to be reached
  // first. Constructed with numbers that would otherwise satisfy every ratio
  // below it -- this is precisely the input that produced a shield.
  const unknown = riskyUsersSummary(
    0,
    cov({ fleet: { kind: 'UNKNOWN', because: 'The list could not be loaded.' } }),
    false
  )
  assert.equal(unknown.empty!.tone, 'COULD_NOT_LOOK')
  assert.equal(unknown.complete, false)
  assert.match(unknown.headline, /fleet size unknown/)
  assert.match(unknown.empty!.detail, /Nothing here is a statement about your tenants/)

  // Even with numbers that look complete, the unknown arm still wins -- the
  // ordering, asserted rather than assumed.
  const dressedUp = riskyUsersSummary(
    0,
    cov({
      fleet: { kind: 'UNKNOWN', because: 'gone' },
      inScope: 4,
      assessed: 4,
    }),
    false
  )
  assert.equal(dressedUp.empty!.tone, 'COULD_NOT_LOOK')

  // And a KNOWN fleet of zero is NOT the same answer: one is "nothing is
  // onboarded", the other is "we could not find out". Same integers.
  assert.notEqual(
    riskyUsersSummary(0, cov(), false).empty!.tone,
    unknown.empty!.tone
  )
})

test('every tone is reachable and only one of them reassures', () => {
  // Five tones now. Swept as a set so a change collapsing any two fails here,
  // with the shield asserted against every one of the other four rather than
  // against a sampled pair.
  const cases: [string, ReturnType<typeof riskyUsersSummary>][] = [
    ['quiet', riskyUsersSummary(0, whole(3), false)],
    ['filtered', riskyUsersSummary(0, whole(3), true)],
    ['partial', riskyUsersSummary(0, cov({ inScope: 3, assessed: 1, failed: 2, missed: ['A', 'B'] }), false)],
    ['empty fleet', riskyUsersSummary(0, cov(), false)],
    ['unknown fleet', riskyUsersSummary(0, cov({ fleet: { kind: 'UNKNOWN', because: 'x' } }), false)],
  ]
  const tones = cases.map(([, summary]) => summary.empty!.tone)
  assert.equal(new Set(tones).size, 5, 'two tones collapsed: ' + tones.join(','))

  for (const [name, summary] of cases) {
    if (name === 'quiet') continue
    assert.notEqual(summary.empty!.tone, 'QUIET', name + ' earned the shield')
  }
  // The control, kept explicit: being quiet IS worth saying when it is true.
  assert.equal(cases[0][1].empty!.tone, 'QUIET')
})

test('the shortfall says WHICH tenants, not only how many', () => {
  // Somebody told three were missed cannot act without going to find which
  // three, and the tenant filter beside the list shows all of them unmarked.
  const detail = riskyUsersSummary(
    0,
    cov({ inScope: 4, assessed: 1, failed: 2, unavailable: 1, missed: ['Greentech', 'Northwind', 'Contoso'] }),
    false
  ).empty!.detail
  assert.match(detail, /Greentech/)
  assert.match(detail, /Northwind/)
  assert.match(detail, /Contoso/)

  // Capped, so a large fleet does not put forty names in one sentence.
  const many = riskyUsersSummary(
    0,
    cov({
      inScope: 40,
      assessed: 0,
      failed: 40,
      missed: Array.from({ length: 40 }, (_, i) => 'Tenant' + i),
    }),
    false
  ).empty!.detail
  assert.match(many, /Tenant0, Tenant1, Tenant2, and 37 more/)
})

test('fleetCoverage names the missed tenants and carries the fleet size', () => {
  const coverage = fleetCoverage(
    [
      { tenantId: 'a', tenantName: 'Greentech', status: 'SUCCESS' },
      { tenantId: 'b', tenantName: 'Northwind', status: 'FAILED' },
      { tenantId: 'c', status: 'UNAVAILABLE' },
    ],
    'ALL'
  )
  assert.deepEqual(coverage.missed, ['Northwind', 'c'])
  assert.deepEqual(coverage.fleet, { kind: 'KNOWN' })

  // Falls back to the id when there is no name, rather than dropping the tenant
  // from the list -- an unnamed tenant was still missed.
  assert.equal(coverage.missed.length, 2)

  const unknown = fleetCoverage([], 'ALL', { kind: 'UNKNOWN', because: 'x' })
  assert.equal(unknown.fleet.kind, 'UNKNOWN')
  assert.equal(unknown.inScope, 0)
})

test('no KPI tile renders a bare count over an unassessed fleet', () => {
  // FOUND BY LOOKING AT TWO SCREENSHOTS SIDE BY SIDE. "HawkView Findings: 0
  // distinct users flagged" and "Microsoft Detections: 0 reported active in
  // Entra ID" rendered IDENTICALLY for a fully assessed fleet and a one-third
  // assessed one. Two of the four tiles could not tell the difference, on the
  // same screen where the other two could.
  //
  // The sweep missed them because it searched for `{x.length}` renderings and
  // health words; these are aggregate metrics off the hook, which is a third
  // spelling of the same thing. A person saw it in one glance.
  const page = readFileSync(
    new URL('../../app/(protected)/risky-users/page.tsx', import.meta.url),
    'utf8'
  ).split(String.fromCharCode(13)).join('')

  assert.ok(page.includes('observed identities; may include retained evidence'), 'tile copy moved')

  const code = stripComments(page)

  // Each of the two tiles must carry coverage within a few lines of its label.
  for (const label of ['observed identities; may include retained evidence', 'observed Microsoft positives; may include retained evidence']) {
    const at = code.indexOf(label)
    assert.ok(at !== -1, label + ' not found in the page')
    const after = code.slice(at, at + 260)
    assert.ok(
      after.includes('notAssessed') && after.includes('fleetWide'),
      label + ' renders a count with no coverage beside it'
    )
  }
})
