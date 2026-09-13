# The acceptance checks, as things to do at nine in the morning

**The checklist says what must be established. This says how.** For each: what to run, what to
look at, what counts as a pass, and what to write on the line.

**Nothing here is signed by running a command.** Four of these need a person to look at something
a machine cannot look at, which is why they have signature lines at all.

---

## FIRST — forecast the run before you make it

**Run:**

```bash
cd backend
export DATABASE_URL='…'                              # read-only credentials are enough
export HAWKVIEW_ALERT_WATERMARK_ISO='2026-09-13T00:00:00.000Z'   # the instant YOU chose
npx tsx scripts/alerting-forecast.mts
```

**It reads and nothing else.** Only `SELECT` statements; verified by row count before and after.
**It refuses to run without a watermark, and an unparseable one is also a refusal** — both exit
`2`, so it is safe to put in a script.

**Look at:** the first block. It prints the four gates it is operating under — watermark, read
window, read limit, and how many unmapped rules appear in this window — **so you are not relying
on remembering that they exist.**

**A pass is:** a number of messages you are willing to send, to a set of organisations you
recognise. **There is no correct value.** If it is more than a handful on the first run, the
watermark is wrong, and that is a tuning question **only until it is sent.**

**Two things that mean stop:**

- `*** N ARE BEYOND THE 5000-ROW LIMIT` — a burst is being deferred, and the forecast describes
  one tick rather than the backlog.
- `*** THEY DISAGREE` — the same figure counted two ways does not match. Do not act on the
  forecast; something has drifted between the catalogue and the decision.

> Forecast: ______ messages, across ______ organisations. Watermark: ____________
> Approved by ____________________ on ____________

---

## 1 — Send twice, one arrives

**Run:** trigger the same message twice — the same job retried, not two different alerts. On a
disposable setup, the simplest form is to let a send time out and be retried; on a real one, ask
the operator of the queue to replay one job.

**Look at:** the receiving inbox. **Count the messages in it.** Not the logs, not the job state,
not the provider dashboard — **the inbox.**

**A pass is:** exactly one message, for two sends carrying one idempotency key.

**Why a machine cannot do this:** our side can only show what we did — two calls, one key, one
provider id back. **Whether that became one email or two is a fact about the provider and a
mailbox.** A test that counts our own calls is asserting the thing it assumed.

> Performed by ____________________ on ____________  Messages in the inbox: ______

---

## 2 — A human opens the EMAIL and writes down what arrived

**Run:** nothing. Open the message that arrived in check 1.

**Look at, and write down:**

- the **sender address** it came from
- the **subject line**
- whether it **rendered** — in the client the recipient actually uses, not a preview
- whether the **deep link resolves and demands authentication** when opened in a private window
- **whether anything in the body names a person or a tenant**

**A pass is:** nothing in the body names a person or a tenant, and the link demands
authentication.

**Why a machine cannot do this:** the body is built from a closed vocabulary with no slot for an
identity. That is a strong guarantee **about what the code can construct** — and it says nothing
about what a template, a subject line, or a provider's own footer adds on the way out. **The only
place to see what was actually sent is the thing that received it.**

> Performed by ____________________ on ____________  Anything naming a person? ______

---

## 3 — A genuine signature still verifies

**Run:** send a real webhook from the provider — a test event from their dashboard is enough —
at the configured endpoint, with the real signing secret in place.

**Look at:** whether the event was accepted and matched to its job, **and** whether a deliberately
corrupted copy of the same event is rejected.

**A pass is both halves.** A genuine event verifies **and** a tampered one does not.

**Why the positive half is not optional:** `() => 'invalid'` passes every forgery test ever
written. **A verifier that rejects everything is indistinguishable from a correct one until
something genuine arrives** — and the first genuine thing in production would be a delivery
receipt that silently never lands, leaving every message permanently unconfirmed.

> Performed by ____________________ on ____________  Genuine verified: ____  Tampered rejected: ____

---

## 4 — A real hard bounce

**Run:** send one message to an address that will hard-bounce — an invalid mailbox at a domain
you control is cleanest.

**Look at:** the suppression state for that address after the bounce arrives, then attempt a
**different** message to the same address.

**A pass is:** the second message is **not attempted**, and the refusal names the suppression
rather than looking like an error.

**Why it matters that it is per address:** a bounce recorded against the job would let every new
incident retry the same dead mailbox, and **continuing to write to dead addresses is what earns a
sending domain a reputation problem** — damage that lands on every other message rather than on
the one that bounced.

> Performed by ____________________ on ____________  Second message attempted? ______

---

## The checks below are for the SCREENS

The four above were written when this release was email-only. Since then the scope grew an in-app
half — alerts visible inside HawkView, and MSPs turning them on and off per type — and it is now
the larger part of what ships. **Checks 1 to 4 stand unchanged**, signature lines and all. Check 2
is now explicitly about the EMAIL; the in-app inbox is check 5, and the two must not be confused on
a signature line six months from now.

**None of these names a position on a screen or a colour.** Each says what must be TRUE and leaves
the person to find it, so that seeing the screens for the first time does not make the procedure
wrong. Where a specific word matters it is quoted, because the wording IS the claim.

---

## 5 — A human opens the three in-app surfaces, in this order

**Run:** nothing. Sign in as a member of an organisation that has at least one alert in its
history. Do this **after** check 1, so there is something to see.

**Look at, in this order — the order matters, because each one narrows the next:**

1. **The bell, before opening anything.** It has exactly three honest states and you must be able
   to say which one you are looking at: a **count**, **quiet**, or **cannot say**. Read its
   screen-reader label as well as its appearance — the label is the more explicit version of the
   same claim, and it is where a lie shows up first. The four labels it can produce are
   *"Notifications (N unread)"*, *"…(N unread as of the last successful check)"*,
   *"…(none unread)"* and *"…(unread count unavailable)"* / *"…(still checking)"*.
2. **The inbox.** Open it. Each row must say **what kind of alert it is** and **how urgent this
   organisation considers it** — not how urgent the product considers it in general.
3. **The alerts settings page.** Every alert type the catalogue declares, each showing what the
   product judges it to be and what this organisation has chosen. A type that no setting can
   currently reach must say so on its own row.

**A pass is:** you can state which of the three bell states you saw and why it was the right one;
every inbox row names its type and its tier; and no row on the settings page claims a setting takes
effect where it does not.

**A fail worth naming specifically:** a bare bell with no indicator while the feed has not loaded.
That is the shape this product keeps producing — *we could not look* rendered as *nothing is
wrong* — and it is the one to look hardest for.

**Why a machine cannot do this:** each surface has been checked in isolation and each is correct in
isolation. What no test has seen is the three of them at once, on the same screen, in front of a
person who will read the bell before the prose and believe it faster. **The recurring defect in
this product is a true sentence in the wrong company**, and company is a property of the assembled
screen.

> Performed by ____________________ on ____________
> Bell state seen: ______________  Was it the right one? ______

---

## 6 — A person turns an alert type off, and then on again

**Run:** on the alerts settings page, set one alert type to **record only**. Then cause an alert of
that type — the same way check 1 causes one. Then set the same type back to **act today** or
**act now**, and cause another.

**Look at:**

- after the record-only setting: whether **anything** arrives — in the inbox, on the bell, by email
- after setting it back: whether something arrives
- whether the settings page still shows your choice when you navigate away and return

**A pass is:** record-only produced **nothing you can find**, setting it back produced something,
and the page shows the choice that is actually in force.

**What to do if record-only produced something anyway:** write down the alert type id exactly as
the settings page spells it, and stop. Do not adjust the setting and retry. A setting that is saved
and ignored is the defect this whole surface exists to prevent, and the spelling is the evidence.

**Why a machine cannot do this:** the path from the settings page to the tick is checked
end-to-end automatically and it passes. What that proves is that **the path works**. It does not
prove that **the control the person operated is the control that path reads** — the same page can
save a value the pipeline never looks at, which is exactly what happened here before the column was
renamed, and every automated check passed throughout. **Only a person who used the control can say
the control is the one that did it.**

> Performed by ____________________ on ____________
> Type used: ______________  Nothing arrived while off? ______  Something arrived after? ______

---

## 7 — The empty states, which is the state this ships in

**Run:** nothing. Sign in to an organisation with **no alerts at all** — on day one that is every
organisation, because production holds zero findings.

**Look at, and write down the exact words:**

- the **alerts inbox** with nothing in it
- the **Risky Users fleet screen** with nothing in it
- the **icon** on each, and its colour

**A pass is:** each one says either *nothing has happened* or *we could not look*, and **you can
tell which of the two it is saying.** An empty screen that reassures is a fail even when every
sentence on it is true.

**The specific thing to refuse:** a green shield, a tick, or any other reassuring mark over a screen
that has not established anything. On the fleet screen there is exactly one state that earns a green
shield — every tenant in scope assessed, and nothing found. Four other empty states exist and none
of them may show it: some tenants unreadable, still loading, no tenants connected, and the tenant
list itself unavailable.

**If you can, look at the fleet screen for an organisation where a tenant is failing**, and confirm
it names which tenants were not assessed rather than only how many.

**Why a machine cannot do this:** the wording and the icon have both been checked by rendering the
real screens over fixtures, and they pass. But *"nothing has happened"* versus *"we could not look"*
is a distinction about **what a reader will take away**, and a test can only confirm that the words
are the words somebody chose. **The question of whether they land is not answerable by the machine
that renders them** — and this release's day-one experience is entirely made of these screens, so
the state nobody will look at is the state everybody will see.

> Performed by ____________________ on ____________
> Inbox empty state says: __________________________________________
> Fleet empty state says: __________________________________________
> Any reassuring icon over an unestablished screen? ______

---

## 8 — Lowering a tier, with in-app notifications muted

**Run:** as a user who has **turned in-app notifications off** in their own notification
preferences, cause an alert of a type set to **act now** and look at the inbox. Then have the
organisation lower that type to **act today**, cause another, and look again.

**Look at:** whether the second one appears for that user.

**A pass is:** the first appeared despite the mute, the second did not, and **you expected the
second not to.**

**Why this is in the document at all:** it is correct behaviour and it will still surprise somebody.
The product shows the most urgent tier in-app whatever an individual has muted, so lowering a type
takes its rows out of that set. **An organisation's setting and an individual's setting interact**,
and a person who meets that for the first time during an incident will read it as a bug and file it
as one.

**Why a machine cannot do this:** the two settings are owned by different people at different
grains, and no automated check can establish that the combined effect is the one the product
intends rather than the one that fell out. Somebody has to decide, in front of it, that this is what
should happen — and their signature is the record that somebody did.

> Performed by ____________________ on ____________
> Muted user saw the ACT_NOW alert? ______  Stopped seeing it after lowering? ______
> Is that the intended behaviour? ______

---

## What these four do not cover

**Nothing here proves an email leaves the building.** Checks 1–4 do that and they cannot be run
until a sender exists. These four are about the half that ships now, and passing all four while 1–4
are unrunnable means the **record** is trustworthy, not that anyone has been **told**.

**And none of them can be closed on a screenshot.** Screenshots establish what a screen looked like
on somebody else's machine, in a state somebody else chose. Checks 5 and 7 in particular require the
reader to be looking at a state they did not arrange — that is most of what makes them worth a
signature.
