# Green Technology — acceptance checklist

**Written for the MSP, not for us.** What you should see, and how you know it worked.

> **INCOMPLETE, AND THE REASON IS STRUCTURAL.** Steps 2 onward all need a message to actually
> leave, and nothing in this build can send one: there is no sender worker, no transport, no
> webhook route and no persisted ledger. `docs/alerting-rollout-readiness.md` carries the full
> blocker list in the order it must be cleared, and the measured test position.
>
> It exists now because criteria have been decided that would otherwise be remembered rather
> than recorded, and because writing the checklist early is what exposes what the flow does not
> do. **Do not run it as a sign-off until the wiring lands** — and marking it complete before a
> message has left would be exactly the failure it exists to prevent.
>
> **Four things CAN be checked today** against a disposable database, and are worth checking
> first: a real finding produces an incident row and a queued job; an organisation with no
> preference row produces no job; the stop button empties the queue; a hard bounce survives a
> restart. All four are covered by the integration tests.

---

## Step 1 — turn email on

**Do this first, before anything else, or the rest of the checklist reads as broken.**

Email delivery is **off by default** for every existing account (`emailEnabled` defaults to
false). Wire the flow perfectly and zero emails arrive — the checklist says "no email", and the
next hour goes into debugging something that works.

This is deliberately a step you take rather than something we changed for you: turning it on is a
preference, and we do not silently flip preferences somebody may have set on purpose.

- [ ] Email is enabled for at least one operator account in the organisation.
- [ ] That account's address is one somebody will actually open.

## Step 2 — an alert you should get

- [ ] A finding is raised on a tenant you monitor.
- [ ] **One** email arrives, to the operator inbox — not one per affected tenant.
- [ ] The email says **what kind** of thing happened, **how many** tenants and incidents it
      covers, and **over what window**.
- [ ] It contains a link that takes you to the detail after you sign in.

**What it must NOT contain, and this is worth checking rather than assuming:** no customer
company name, no person's name, no email address, and no link whose address contains any of
those. That is enforced by the message's structure rather than by a filter — there is no field
for them — but the point of a checklist is to look.

## Step 3 — an alert you should NOT get, shown as considered

**A negative control, and it is the most informative line here.** Something must be routed to a
channel you have turned off, or held back by a limit, and it must be **visible as withheld**
rather than simply absent.

- [ ] No email arrives for it.
- [ ] It is nonetheless **shown** somewhere as considered-and-withheld, with a reason.

**Why this matters more than it looks.** "We decided not to tell you" and "we failed to tell you"
look identical from an empty inbox. If withheld things are invisible, you cannot tell a working
filter from a broken pipe — and neither can we.

## Step 4 — a real hard bounce

- [ ] Send to an address that does not exist.
- [ ] The failure is **recorded and visible**, not silent.
- [ ] We do not keep retrying it.

**A bounce nobody reads is the same silence as never sending.** This is the check that the
failure path exists at all, and it cannot be done with a fake address that merely looks invalid —
it needs a real rejection from a real mail server.

## Step 5 — send the same thing twice

**Ruled into this checklist because nothing in our code can establish it.**

- [ ] The same message is submitted twice with the same idempotency key.
- [ ] **Exactly one email arrives.**

Every crash-recovery path in the delivery layer is safe **only because the send is idempotent at
the provider**. If a process dies mid-send, the retry re-sends with the same key — and if the key
is not honoured, that is a second email. Nothing on our side can tell the difference between "the
provider de-duplicated it" and "the provider sent two". The only way to know is to try it.

It is cheap, and the thing it protects against is an MSP getting duplicate alerts, which is the
fastest way to teach somebody to ignore them.

## Step 6 — a person opens the inbox

- [ ] Somebody who did not build this reads the email and can say what happened and what to do.

**Not a formality.** Every other check here can pass while the message is unreadable: the counts
can be right, the links can work, the leak checks can hold, and the thing can still fail to tell
a person what is going on. Nothing automated catches that.

---

## What this checklist cannot tell you

- **Whether the 319 unclassified rows matter to you.** This launch keys about 44 notification
  rows, all of them monitoring alerts. The 301 unclosable directory-change alerts are on the
  other side of a classifier that is not wired to historical data yet. **If privileged-change
  alerting is what you were shown, this launch does not deliver it** — see the backlog.
- **Whether the volume is right.** The per-MSP send limit is currently a labelled guess, twenty
  per tick, because nobody has measured real volume. It withholds rather than drops, so a wrong
  number delays rather than loses — but the right number comes from watching this run.
