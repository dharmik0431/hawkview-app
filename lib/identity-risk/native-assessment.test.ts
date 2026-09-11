import assert from 'node:assert/strict'
import test from 'node:test'
import {
  adaptNativeAssessment,
  NATIVE_RISKY_USERS_VERSION,
} from './native-assessment.ts'
import { nativeRiskyUserCount, nativeRiskyUserList } from './native-view.ts'

/** A payload the endpoint could actually return, with the fleet's real shape. */
function available(overrides: Record<string, unknown> = {}) {
  return {
    version: NATIVE_RISKY_USERS_VERSION,
    available: true,
    run: {
      windowStart: '2026-08-11T12:00:00.000Z',
      windowEnd: '2026-09-10T12:00:00.000Z',
      completedAt: '2026-09-10T12:00:07.000Z',
    },
    collectors: [
      {
        source: 'SIGN_INS',
        status: 'OK',
        lastSuccessfulCollectionAt: '2026-09-10T11:13:00.000Z',
      },
      {
        source: 'M365_AUDIT',
        status: 'BACKLOGGED',
        lastSuccessfulCollectionAt: null,
      },
    ],
    count: {
      accuracy: 'EXACT',
      value: 1,
      scope: {
        evidenceRequested: ['SIGN_INS'],
        setAside: [],
        covered: ['credential-failure'],
        notCovered: [
          {
            detectorId: 'external-mailbox-forwarding',
            because: 'NEVER_COLLECTED',
          },
        ],
      },
    },
    claim: { permitted: true },
    coverage: [],
    findings: {
      complete: true,
      items: [
        {
          detectorId: 'credential-failure',
          subject: {
            kind: 'DIRECTORY_USER',
            userRef: 'c54eb6ce-0000-0000-0000-000000000001',
            correlation: { available: false, because: 'NOT_RESOLVED' },
          },
          signals: [
            {
              signal: 'LOCKED_OUT_AFTER_REPEATED_FAILURES',
              count: 462,
              capped: false,
              latest: {
                at: '2026-09-03T10:40:00.000Z',
                kind: 'EVENT_OCCURRED',
              },
            },
            {
              signal: 'PASSWORD_REJECTED',
              count: 12,
              capped: false,
              latest: {
                at: '2026-09-09T03:58:00.000Z',
                kind: 'EVENT_OCCURRED',
              },
            },
          ],
        },
      ],
    },
    ...overrides,
  }
}

test('the native response is read in its own vocabulary', () => {
  const result = adaptNativeAssessment(available())
  assert.ok(result)
  assert.equal(result!.available, true)
  if (!result!.available) return

  // Raymonds: one finding, two signals, each keeping its own count and date.
  assert.equal(result!.findings.length, 1)
  assert.equal(result!.findings[0].signals.length, 2)
  assert.equal(result!.findings[0].signals[0].count, 462)
  assert.equal(result!.findings[0].signals[1].count, 12)
  assert.notEqual(
    result!.findings[0].signals[0].latest?.at,
    result!.findings[0].signals[1].latest?.at
  )

  // A detector that could not run keeps its own reason rather than being
  // folded into a single tenant-level excuse.
  assert.deepEqual(result!.count.notCovered, [
    { detectorId: 'external-mailbox-forwarding', because: 'NEVER_COLLECTED' },
  ])

  // Null means never collected and must survive as null. Reaching a date
  // formatter it would render as an epoch or a dash and read as a very old
  // success, which is the opposite of what it says.
  const audit = result!.collectors.find(
    (entry) => entry.source === 'M365_AUDIT'
  )
  assert.equal(audit?.lastSuccessfulCollectionAt, null)
})

test('an absent optional field is a state; a contradictory one is refused', () => {
  // Absent is the ordinary condition during a rollout, because the backend
  // auto-deploys and the frontend publishes separately. Rejecting on a key
  // this build has not heard of would break the surface on a normal release.
  const withoutCollectors = available()
  delete (withoutCollectors as Record<string, unknown>).collectors
  const tolerated = adaptNativeAssessment(withoutCollectors)
  assert.ok(tolerated, 'a missing optional array rejected the whole payload')
  assert.deepEqual(tolerated!.available && tolerated!.collectors, [])

  // An unknown extra key is not this build's business.
  assert.ok(adaptNativeAssessment(available({ somethingNewer: { a: 1 } })))

  // Contradiction is refused. The contract guarantees a null count exactly on
  // NOT_AVAILABLE; a payload breaking that is not omitting something, and
  // repairing it would mean choosing which half to believe.
  assert.equal(
    adaptNativeAssessment(
      available({ count: { accuracy: 'EXACT', value: null, scope: {} } })
    ),
    null
  )
  assert.equal(
    adaptNativeAssessment(
      available({ count: { accuracy: 'NOT_AVAILABLE', value: 4, scope: {} } })
    ),
    null
  )
})

test('a finding resting on nothing is refused rather than shown', () => {
  const base = available()
  const items = (base.findings as { items: Record<string, unknown>[] }).items

  // Empty signals says every signal was never evaluated.
  const empty = available({
    findings: { complete: true, items: [{ ...items[0], signals: [] }] },
  })
  assert.equal(adaptNativeAssessment(empty), null)

  // Two entries for one signal make every per-signal count ambiguous.
  const duplicated = available({
    findings: {
      complete: true,
      items: [
        {
          ...items[0],
          signals: [
            {
              signal: 'PASSWORD_REJECTED',
              count: 1,
              capped: false,
              latest: null,
            },
            {
              signal: 'PASSWORD_REJECTED',
              count: 2,
              capped: false,
              latest: null,
            },
          ],
        },
      ],
    },
  })
  assert.equal(adaptNativeAssessment(duplicated), null)

  // Nothing occurred for a zero's timestamp to mark.
  const datedZero = available({
    findings: {
      complete: true,
      items: [
        {
          ...items[0],
          signals: [
            {
              signal: 'PASSWORD_REJECTED',
              count: 0,
              capped: false,
              latest: {
                at: '2026-09-09T03:58:00.000Z',
                kind: 'EVENT_OCCURRED',
              },
            },
          ],
        },
      ],
    },
  })
  assert.equal(adaptNativeAssessment(datedZero), null)

  // An evaluated-and-empty signal is a result and survives.
  const evaluatedZero = available({
    findings: {
      complete: true,
      items: [
        {
          ...items[0],
          signals: [
            {
              signal: 'LOCKED_OUT_AFTER_REPEATED_FAILURES',
              count: 0,
              capped: false,
              latest: null,
            },
            {
              signal: 'PASSWORD_REJECTED',
              count: 7,
              capped: false,
              latest: null,
            },
          ],
        },
      ],
    },
  })
  const kept = adaptNativeAssessment(evaluatedZero)
  assert.ok(kept)
  assert.equal(kept!.available && kept!.findings[0].signals[0].count, 0)
})

test('an identity the caller may not see is a narrower view, not a failure', () => {
  // Named identity is gated on the caller's role and the opaque handle travels
  // for everyone. A reader without the gate sees less; nothing is broken, and
  // the finding must not be withheld because the name was.
  const gated = adaptNativeAssessment(available())
  assert.ok(gated)
  assert.equal(gated!.available && gated!.findings[0].subject.displayName, null)
  assert.ok(gated!.available && gated!.findings[0].subject.ref.length > 0)

  const base = available()
  const items = (base.findings as { items: Record<string, unknown>[] }).items
  const named = adaptNativeAssessment(
    available({
      findings: {
        complete: true,
        items: [
          {
            ...items[0],
            subject: {
              kind: 'DIRECTORY_USER',
              userRef: 'c54eb6ce-0000-0000-0000-000000000001',
            },
            // Beside subject, not inside it. This fixture asserted the name in
            // the wrong place and so asserted the defect: it passed while the
            // screen said every identity was unresolved. A fixture written to
            // match the adapter rather than the wire cannot fail when the
            // adapter is the thing that is wrong.
            displayName: 'Alice Chen',
            userPrincipalName: 'alice.chen@synthetic.invalid',
          },
        ],
      },
    })
  )
  assert.ok(named)
  assert.equal(
    named!.available && named!.findings[0].subject.displayName,
    'Alice Chen'
  )
})

test('a truncated list is not an empty list, and a wrong contract is not a state', () => {
  const truncated = adaptNativeAssessment(
    available({ findings: { complete: false, items: [] } })
  )
  assert.ok(truncated)
  assert.equal(truncated!.available && truncated!.complete, false)
  assert.deepEqual(truncated!.available && truncated!.findings, [])

  // Complete-and-empty is the other sentence and must stay distinct.
  const genuinelyEmpty = adaptNativeAssessment(
    available({ findings: { complete: true, items: [] } })
  )
  assert.ok(genuinelyEmpty)
  assert.equal(genuinelyEmpty!.available && genuinelyEmpty!.complete, true)

  // A different contract version is not a degraded version of this one.
  assert.equal(
    adaptNativeAssessment(available({ version: 'hawkview-risky-users/v2' })),
    null
  )
})

test('an unavailable response carries its reason, including one this build does not know', () => {
  for (const because of [
    'ROLE_NOT_PERMITTED',
    'NOT_ENABLED_FOR_TENANT',
    'EVALUATION_DISABLED',
    'NO_RUN',
    'COVERAGE_NOT_RECORDED',
    'COVERAGE_UNREADABLE',
    'FINDINGS_NOT_RECORDED',
    'FINDINGS_UNREADABLE',
    'A_REASON_SHIPPED_AFTER_THIS_BUILD',
  ]) {
    const result = adaptNativeAssessment({
      version: NATIVE_RISKY_USERS_VERSION,
      available: false,
      because,
    })
    assert.ok(result, because + ' was rejected')
    assert.equal(result!.available, false)
    assert.equal(!result!.available && result!.because, because)
  }

  // The discriminant itself is not optional: without it there is no way to
  // know whether an empty screen is a result or an absence.
  assert.equal(
    adaptNativeAssessment({ version: NATIVE_RISKY_USERS_VERSION }),
    null
  )
})

test('a figure never reaches a surface without the scope it is exact over', () => {
  // The engine guarantees this structurally: scope sits inside Count and there
  // is no path producing the number without it. That guarantee is about the
  // data and says nothing about a card printing "4". It is spent at the last
  // inch, and this is the last inch.
  //
  // greentech: 4 confirmed, 14 consent events read and identified and held for
  // want of our own written basis for excluding them.
  const greentech = adaptNativeAssessment({
    version: NATIVE_RISKY_USERS_VERSION,
    available: true,
    subjectsNamed: true,
    run: {
      windowStart: '2026-08-11T12:00:00.000Z',
      windowEnd: '2026-09-10T12:00:00.000Z',
      completedAt: '2026-09-10T12:00:07.000Z',
    },
    collectors: [],
    coverage: [
      {
        stream: 'SIGN_INS',
        coverage: {
          applies: 1586,
          notYetCitedEvents: 14,
          uninterpretedEvents: 0,
        },
      },
    ],
    count: {
      accuracy: 'EXACT',
      value: 4,
      scope: {
        evidenceRequested: ['SIGN_INS'],
        setAside: [],
        covered: [],
        notCovered: [],
      },
    },
    claim: { permitted: true },
    findings: { complete: true, items: [] },
  })
  const count = nativeRiskyUserCount(greentech)

  assert.equal(count.accuracy, 'EXACT')
  assert.equal(count.value, 4)
  // The qualification travels with the words that accompany the figure, so a
  // surface cannot render one without having been handed the other.
  assert.match(count.caption, /cited a basis for/)
  assert.match(count.caption, /14 events held pending a citation/)

  // The two set-aside kinds are never summed. Fourteen consent prompts we read
  // and identified is a paperwork gap, bounded and enumerable. Events we could
  // not interpret at all are wrong by an unbounded amount. One number for both
  // would make a tenant with an interpretation failure indistinguishable from
  // one with a filing problem.
  const biolink = adaptNativeAssessment({
    version: NATIVE_RISKY_USERS_VERSION,
    available: true,
    subjectsNamed: true,
    run: {
      windowStart: '2026-08-11T12:00:00.000Z',
      windowEnd: '2026-09-10T12:00:00.000Z',
      completedAt: '2026-09-10T12:00:07.000Z',
    },
    collectors: [],
    coverage: [
      {
        stream: 'SIGN_INS',
        coverage: {
          applies: 900,
          notYetCitedEvents: 0,
          uninterpretedEvents: 112,
        },
      },
    ],
    count: {
      accuracy: 'AT_LEAST',
      value: 4,
      scope: {
        evidenceRequested: ['SIGN_INS'],
        setAside: [],
        covered: [],
        notCovered: [],
      },
    },
    claim: { permitted: true },
    findings: { complete: true, items: [] },
  })
  const bounded = nativeRiskyUserCount(biolink)
  assert.match(bounded.caption, /112 events could not be interpreted/)
  assert.ok(
    !/held pending a citation/.test(bounded.caption),
    'an interpretation failure was described as a paperwork gap'
  )
  assert.ok(
    !/could not be interpreted/.test(count.caption),
    'a paperwork gap was described as an interpretation failure'
  )

  // A response that did not say what it examined cannot support the figure
  // being read as covering anything, and says so rather than staying silent.
  const unscoped = nativeRiskyUserCount(
    adaptNativeAssessment({
      version: NATIVE_RISKY_USERS_VERSION,
      available: true,
      run: {
        windowStart: null,
        windowEnd: null,
        completedAt: null,
      },
      count: { accuracy: 'EXACT', value: 4, scope: {} },
      claim: { permitted: true },
      findings: { complete: true, items: [] },
    })
  )
  assert.match(unscoped.caption, /did not report what it examined/)
})

test('a resolved name is read from where the server puts it, not where we expected', () => {
  // The shipped defect. displayName and userPrincipalName are spread onto the
  // ITEM, beside subject, because resolution happens at read time against the
  // directory and is not part of what the detector produced. Reading them from
  // inside subject yields null with no error, and every row then claimed
  // HawkView could not identify anybody while the payload carried their names.
  //
  // Both placements are defensible and neither side was wrong alone -- which
  // is why nothing failed. This fixture is shaped like the wire rather than
  // like the adapter, which is the only version of this test that could have
  // caught it.
  const wire = {
    version: NATIVE_RISKY_USERS_VERSION,
    available: true,
    subjectsNamed: true,
    run: {
      windowStart: '2026-08-11T12:00:00.000Z',
      windowEnd: '2026-09-10T12:00:00.000Z',
      completedAt: '2026-09-10T12:00:07.000Z',
    },
    collectors: [],
    coverage: [],
    count: {
      accuracy: 'EXACT',
      value: 1,
      scope: {
        evidenceRequested: [],
        setAside: [],
        covered: [],
        notCovered: [],
      },
    },
    claim: { permitted: true },
    findings: {
      complete: true,
      items: [
        {
          detectorId: 'credential-failure',
          subject: {
            kind: 'DIRECTORY_USER',
            userRef: 'c54eb6ce-0000-0000-0000-000000000001',
          },
          displayName: 'Dara Fixture',
          userPrincipalName: 'dara@fixture.invalid',
          signals: [
            {
              signal: 'PASSWORD_REJECTED',
              count: 12,
              capped: false,
              latest: {
                at: '2026-09-09T03:58:00.000Z',
                kind: 'EVENT_OCCURRED',
              },
            },
          ],
        },
      ],
    },
  }

  const named = adaptNativeAssessment(wire)
  assert.ok(named)
  assert.equal(
    named!.available && named!.findings[0].subject.displayName,
    'Dara Fixture'
  )
  assert.equal(
    named!.available && named!.findings[0].subject.userPrincipalName,
    'dara@fixture.invalid'
  )
  // The opaque handle still comes from inside subject and still travels.
  assert.match(
    named!.available ? named!.findings[0].subject.ref : '',
    /^c54eb6ce/
  )

  const rows = nativeRiskyUserList(named).rows
  assert.equal(rows.length, 1)
  assert.equal(rows[0].name, 'Dara Fixture')
  assert.equal(rows[0].email, 'dara@fixture.invalid')
})

test('a missing name says which of its two causes applies', () => {
  // "Identity not resolved" is a claim about HawkView's own capability and is
  // true only when this response names people and this subject had no
  // directory row. When the response names nobody it is a permission boundary,
  // and printing our own failure there is a false statement about ourselves on
  // every row at once -- worse than the opaque handle it replaced, because the
  // handle invited the question rather than answering it wrongly.
  const build = (subjectsNamed: boolean) => ({
    version: NATIVE_RISKY_USERS_VERSION,
    available: true,
    subjectsNamed,
    run: { windowStart: null, windowEnd: null, completedAt: null },
    collectors: [],
    coverage: [],
    count: {
      accuracy: 'EXACT',
      value: 1,
      scope: {
        evidenceRequested: [],
        setAside: [],
        covered: [],
        notCovered: [],
      },
    },
    claim: { permitted: true },
    findings: {
      complete: true,
      items: [
        {
          detectorId: 'credential-failure',
          subject: {
            kind: 'DIRECTORY_USER',
            userRef: 'c54eb6ce-0000-0000-0000-000000000002',
          },
          signals: [
            {
              signal: 'PASSWORD_REJECTED',
              count: 3,
              capped: false,
              latest: null,
            },
          ],
        },
      ],
    },
  })

  const gated = nativeRiskyUserList(adaptNativeAssessment(build(false))).rows
  assert.equal(gated[0].name, 'Name not shown for your role')
  assert.ok(
    !/not resolved/i.test(gated[0].name),
    'a permission boundary was rendered as a failure of ours'
  )

  const unresolved = nativeRiskyUserList(
    adaptNativeAssessment(build(true))
  ).rows
  assert.equal(unresolved[0].name, 'Identity not resolved')
  assert.notEqual(gated[0].name, unresolved[0].name)
})
