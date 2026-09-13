import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import {
  fleetCoverage,
  riskyUsersSummary,
  type AssessmentCoverage,
  type TenantAssessmentStatus,
} from './fleet-coverage.ts'

const statuses = (...pairs: [string, TenantAssessmentStatus][]) =>
  pairs.map(([tenantId, status]) => ({ tenantId, status }))

const whole = (n: number): AssessmentCoverage => ({
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

  const unassessed: AssessmentCoverage = {
    inScope: 4,
    assessed: 1,
    loading: 0,
    failed: 2,
    unavailable: 1,
  }
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
    { inScope: 4, assessed: 1, loading: 0, failed: 3, unavailable: 0 },
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
  const mixed: AssessmentCoverage = {
    inScope: 6,
    assessed: 1,
    loading: 2,
    failed: 1,
    unavailable: 2,
  }
  const detail = riskyUsersSummary(0, mixed, false).empty!.detail
  assert.match(detail, /1 could not be reached/)
  assert.match(detail, /2 returned no assessment/)
  assert.match(detail, /2 still loading/)
  assert.match(detail, /5 of 6 tenants were not assessed/)

  // Only the causes that actually occurred are named, or every screen would
  // list three problems when it has one.
  const onlyFailed = riskyUsersSummary(
    0,
    { inScope: 2, assessed: 1, loading: 0, failed: 1, unavailable: 0 },
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
    inScope: 1,
    assessed: 1,
    loading: 0,
    failed: 0,
    unavailable: 0,
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
    { inScope: 4, assessed: 2, loading: 0, failed: 2, unavailable: 0 },
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
    riskyUsersSummary(0, { inScope: 1, assessed: 0, loading: 0, failed: 1, unavailable: 0 }, false)
      .empty!.detail,
    /1 of 1 tenant was not assessed/
  )
  assert.match(
    riskyUsersSummary(0, { inScope: 3, assessed: 1, loading: 0, failed: 2, unavailable: 0 }, false)
      .empty!.detail,
    /2 of 3 tenants were not assessed/
  )

  // `assessed` above `inScope` should be impossible; if a refactor makes it
  // possible the screen must not print a negative, which is the part a reader
  // would try to act on.
  const odd = riskyUsersSummary(
    0,
    { inScope: 1, assessed: 4, loading: 0, failed: 0, unavailable: 0 },
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
  const code = page
    .split(String.fromCharCode(10))
    .filter((line) => {
      const t = line.trim()
      return !(
        t.startsWith('//') ||
        t.startsWith('{/*') ||
        t.startsWith('/*') ||
        t.startsWith('*') ||
        t.endsWith('*/}') ||
        t.endsWith('*/')
      )
    })
    .join(String.fromCharCode(10))

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