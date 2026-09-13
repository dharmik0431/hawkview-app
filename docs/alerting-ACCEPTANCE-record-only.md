# Record-only acceptance — the checks that can be performed against what ships

**Every check on this page is performable today.** That is the only rule for what belongs here. The
four checks that need a sender have moved to `alerting-ACCEPTANCE-email-delivery.md`, which is not
yet applicable and says so.

**Why they moved, verified rather than assumed:** there is no mail provider dependency in the
backend — `resend`, `nodemailer`, `postmark`, `sendgrid`, `mailgun` and any SES client are all
absent from `package.json`. Nothing can send, so nothing can arrive, bounce, or carry a provider
signature. Those were four signature lines asking for observations nobody can make.

**A note on how these are written.** None names a position on a screen or a colour. Each says what
must be **true** and leaves the person to find it. Where a word is the claim, the word is quoted.

---

## 1 — The bell, before opening anything

**Run:** nothing. Sign in as a member of an organisation with at least one alert in its history.

**Look at:** the bell alone, before clicking. It has exactly three honest states and you must be
able to say which one you are looking at: a **count**, **quiet**, or **cannot say**. Read its
screen-reader label as well as its appearance — the label is the more explicit version of the same
claim and it is where a lie shows up first. The labels it can produce are *"Notifications (N
unread)"*, *"…(N unread as of the last successful check)"*, *"…(none unread)"*, *"…(unread count
unavailable)"* and *"…(still checking)"*.

**A pass is:** you can name the state you saw and say why it was the right one for what the product
knew at that moment.

**The fail to look hardest for:** a bare bell with no indicator while the feed has not loaded. That
is *we could not look* rendered as *nothing is wrong*, and it is the shape this product keeps
producing.

**Why a machine cannot do this:** the bell's three states are each correct in isolation and are
tested that way. What no test has seen is the bell in front of a person who reads it before the
prose and believes it faster.

> Performed by ____________________ on ____________
> State seen: ______________  Was it the right one? ______

---

## 2 — The inbox and the settings page

**Run:** nothing. Open the notification inbox, then the alert settings page.

**Look at:**

- every inbox row: does it say **what kind of alert** it is and **how urgent this organisation
  considers it** — not how urgent the product considers it in general?
- the settings page: every alert type the catalogue declares, each showing what the product judges
  it to be and what this organisation has chosen.
- **a type no setting can currently reach must say so on its own row.**

**A pass is:** every row names its type and its tier, and no row claims a setting takes effect where
it does not.

**Why a machine cannot do this:** each surface is checked in isolation and each is correct. The
question is whether the three of them, on one screen, tell one story — and *company* is a property
of the assembled screen, not of any component in it.

> Performed by ____________________ on ____________  Any row claiming an effect it does not have? ______

---

## 3 — Turn a type off, and confirm it stops. **Three observations, not one.**

**Run:** on the alert settings page, set one alert type to **record only**. Then cause an alert of
that type.

**Look at, and record all three separately:**

1. **The inbox.** Nothing new for that type.
2. **The unread count on the bell.** Unchanged — a row that is suppressed but still counted is the
   same defect wearing a different hat.
3. **The history.** The incident is **still findable**. Suppressed is not deleted, and this
   observation is the only thing that separates the two.

**A pass is all three.** One and two without three means the evidence was thrown away; three without
one and two means nothing was suppressed.

**What to do if something arrived anyway:** write down the alert type id **exactly as the settings
page spells it**, and stop. Do not adjust the setting and retry. A setting that is saved and ignored
is the defect this surface exists to prevent, and the spelling is the evidence.

**Why a machine cannot do this:** an automated path from the settings page to the pipeline passes
today. That proves **the path works**. It does not prove that **the control the person operated is
the control that path reads** — the same page can save a value the pipeline never consults, which is
exactly what happened here before a column was renamed, with every automated check green throughout.

> Performed by ____________________ on ____________
> Type used: ______________  Inbox silent? ______  Unread count unchanged? ______  History still findable? ______

---

## 4 — Turn it back on, and confirm nothing replays

**Run:** with that type still set to record only and at least two alerts suppressed, set it back to
**act today** or **act now**. Then look, **before causing anything new**.

**Look at:** whether a backlog arrives. The alerts suppressed while the type was off must **not**
appear now.

**A pass is:** nothing appears until the next genuine alert. Re-enabling is a change to what happens
next, not a request for what was missed.

**Why this check is new:** re-enabling has never been exercised by a person. The property may hold
today as a side effect of an incident already being open rather than as a stated rule, and a side
effect is not a guarantee — the next change to that path would not know it was load-bearing.

**Why a machine cannot do this:** a test can assert that no rows were written. It cannot tell you
that an MSP who flipped a switch was not handed a week of history as though it had just happened,
because that failure is visible only to somebody watching their own inbox at the moment they flip it.

> Performed by ____________________ on ____________
> Suppressed alerts while off: ______  Any of them appeared on re-enabling? ______

---

## 5 — The empty states, which is the state this ships in

**Run:** nothing. Sign in to an organisation with no alerts at all — on day one that is every
organisation, because production holds zero findings.

**Look at, and write down the exact words:** the alerts inbox with nothing in it, the Risky Users
fleet screen with nothing in it, and **the icon on each, and its colour**.

**A pass is:** each says either *nothing has happened* or *we could not look*, **and you can tell
which of the two it is saying.** An empty screen that reassures is a fail even when every sentence
on it is true.

**The specific thing to refuse:** a green shield, a tick, or any reassuring mark over a screen that
has established nothing. On the fleet screen exactly one state earns a green shield — every tenant
in scope assessed, nothing found. Four others exist and none may show it: some tenants unreadable,
still loading, no tenants connected, and the tenant list itself unavailable.

**Why a machine cannot do this:** the wording and the icon have both been checked by rendering the
real screens, and they pass. But *nothing happened* against *we could not look* is a distinction
about **what a reader takes away**, and a renderer cannot confirm that about its own output.

> Performed by ____________________ on ____________
> Inbox empty state says: __________________________________________
> Fleet empty state says: __________________________________________
> Any reassuring icon over an unestablished screen? ______

---

## 6 — Lowering a tier, with in-app notifications muted

**Run:** as a user who has turned in-app notifications **off** in their own preferences, cause an
alert of a type set to **act now** and look at the inbox. Then have the organisation lower that type
to **act today**, cause another, and look again.

**A pass is:** the first appeared despite the mute, the second did not, **and you expected the second
not to.**

**Why it is here:** it is correct behaviour and it will still surprise somebody. The most urgent tier
is shown in-app whatever an individual has muted, so lowering a type takes its rows out of that set.
**An organisation's setting and an individual's setting interact**, and a person meeting that during
an incident will read it as a bug.

**Why a machine cannot do this:** no automated check can establish that the combined effect of two
settings owned by different people is the one the product intends rather than the one that fell out.
Somebody has to decide, in front of it, that this is what should happen.

> Performed by ____________________ on ____________
> Muted user saw the ACT_NOW alert? ______  Stopped after lowering? ______  Is that intended? ______

---

## ⚠ One thing that must be re-checked when record-only changes

`RECORD_ONLY` currently writes the incident **and** the in-app notification and withholds only the
send job — measured: 1 incident, 1 notification, 0 jobs. The settings page says so outright: the
delivery table has `RECORD_ONLY: [{ channel: 'IN_APP', live: true }]`.

**When the notification is suppressed too, that line becomes false.** If the table is left as it is,
the settings page will tell an MSP their record-only alerts still appear in the product while they no
longer do — **a false statement in front of the person making the choice**, which is worse than the
behaviour it describes. Check 3 above is what catches it, and the table should change in the same
commit as the behaviour.

## What passing all six means, and what it does not

**It means the record is trustworthy. It does not mean anybody has been told anything.** The four
checks about a message arriving are in the other document and cannot be attempted yet. Read six
signatures here as *"HawkView records and shows this correctly"*, never as *"an MSP was notified"*.
