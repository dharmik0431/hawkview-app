# 51 frontend tests are red on the release branch, and they were red before today

Found while gathering measured numbers for the release statement. **Not caused by this release** —
and that is the less important half of the finding.

## What is true

`lib/identity-risk/risky-users-ui.test.ts` — **55 tests, 4 pass, 51 fail** at `d0bafac`.

**Identical at `origin/main` (`5488ad6`): 55 tests, 4 pass, 51 fail.** So nothing in today's alerting
work, and nothing in the merge, caused it. I checked that before saying anything else about it.

**The cause is a stale test file, not a broken page.** The test asserts the pre-rework column
headings and the page renders the current ones:

```
actual   [ 'User', 'Why this user needs review', 'Found by', 'Latest evidence' ]
expected [ 'User', 'Detected by',                'HawkView priority', 'Latest of any reason' ]
```

The file last changed at `41d60e5`, *"Integrate Dharmik's GAS rework as a delta, not a snapshot"* —
the same rework that changed the page. The tests were left describing the page that was replaced,
and have been failing on `main` ever since. Across the 51, the failures are of a piece: fifteen
falsy-value assertions, five missing sections, regexes for copy that no longer exists, and one that
says out loud *"no rows rendered, so the per-row assertions below check nothing"* — the file's own
guard against a vacuous pass, firing correctly.

## Why it belongs in the release statement anyway

**These 51 are not incidental coverage.** They guard, by name:

- *the surface never claims a user is safe or that HawkView acted*
- *a zero is never rendered alone* / *a zero never renders as a clean tenant while findings sit below it*
- *an unconfirmed empty Microsoft result never becomes an authoritative zero*
- *a withheld count reads as a decision, not as a blank or a breakage*
- *no raw Microsoft identifier is ever painted on screen*

That is the exact property family this release spent the day on — a true sentence in the wrong
company, and a zero that means two different things. **They have not run since the rework**, and the
Risky Users surface is in this release's scope.

## What I am NOT claiming

**I have not established that the page violates any of those properties.** The tests are red because
they describe a different page, not because they caught something. Saying otherwise would be the
mistake I have spent the day refusing: a failing check is evidence about the check until somebody
looks at the subject.

What is established is narrower and still worth a decision: **a set of guards on a surface this
release ships is not protecting it**, and nobody has looked at whether the properties still hold.

## What would settle it

Re-point the file at the current page. That is a day's work rather than an afternoon's, and it is
not a scope-freeze candidate — it sends nothing, silences nothing, and puts no false statement in
front of an MSP by itself. It belongs in the backlog with this evidence attached.

**The one thing that must not happen is the release statement saying "the frontend tests pass."**
They do not, they did not before, and the reason is worth a line rather than a footnote.

---

## Correction: the mapping to today's work does not hold

I was asked to add a precision saying several of these properties *were* re-established today by
different instruments. **I checked it, and it is not true — for a reason that makes the finding
sharper rather than softer.**

**The 51 tests render a different component.** The file compiles and renders
`components/identity-risk/risky-users-section.tsx` and
`components/identity-risk/risky-users-count-card.tsx` — the **per-tenant Risky Users section and
its overview card**. Today's fleet work, and my R1–R9, are on
`app/(protected)/risky-users/page.tsx` and `lib/identity-risk/fleet-coverage.ts` — the
**fleet screen**.

Reading the four tests confirms it from the other side. They drive
`render(assessmentFixture(…))`, `value.summary.currentUsers`, `value.rules[…]`, and
`microsoftPanel(document)`:

| the guard | what it actually asserts |
|---|---|
| *a zero is never rendered alone* | the tenant section's zero carries *"does not establish that an identity is safe"* and *"Not covered by this number … requires Entra ID P2"* |
| *an unconfirmed empty Microsoft result never becomes an authoritative zero* | an empty Microsoft page **while `pageInfo.hasMore` is true** must not borrow a clean tenant's wording |
| *a withheld count reads as a decision* | `summary.currentUsers` with `value: null, accuracy: 'UNKNOWN'` |
| *a zero never renders as a clean tenant while findings sit below it* | `summary.currentUsers.value = 0` with three matched identities in `rules` |

**None of that is the fleet screen's empty states.** The property *family* is the same — a zero that
means two things, a count without its coverage — which is exactly why the mapping looked right. The
surface is not.

**And today touched neither component.** `git log` over the last twenty hours on
`risky-users-section.tsx` and `risky-users-count-card.tsx` is empty. Both last changed at `41d60e5`,
the same GAS rework that last changed the test file — the component moved and its tests did not.

### So the honest line is simpler than either version

Not *"some were re-established and one was not."* **All 51 guard a component this release does not
change and today's instruments never rendered.** The property family was re-established today on the
fleet screen, by rendering and by register; the per-tenant section's own guards have not run since
the rework, and nothing has looked at it since.

That is a smaller claim about today's work and a larger one about the gap, and it is the version I
will put in the release statement.
