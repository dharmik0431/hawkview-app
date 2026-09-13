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
