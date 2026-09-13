# Email-delivery acceptance — **NOT YET APPLICABLE**

**None of these can be attempted today, and none of them has failed.** They are held here, unsigned,
until delivery exists. Nobody should be asked to sign them, and nobody should read their absence
from the record-only document as an omission.

## Why they cannot be attempted, checked rather than assumed

**There is no mail provider dependency in the backend.** `resend`, `nodemailer`, `postmark`,
`sendgrid`, `mailgun` and any SES client are all absent from `backend/package.json`.

What exists is the **queue** — `alert_send_jobs` rows, and claim and update statements in
`send-queue.ts`. What does not exist is anything that takes a claimed job and hands it to a provider.
So a job can be written and can be claimed, and there it stops.

**Consequently:** nothing can be sent, nothing can arrive, nothing can bounce, and no provider can
sign a webhook. The four checks below are not hard to perform — they are **unperformable**, which is
a different thing and the reason they are not on a page anybody is being asked to sign.

## What has to exist before any of them can be attempted

1. **A provider client**, and the dependency to go with it.
2. **A worker that drains the queue** — claims a job, calls the provider, records the outcome.
3. **Delivery outcomes persisted.** A job's fate after it leaves the queue currently has nowhere to
   land, so even a successful send would be unobservable afterwards.
4. **A configured signing secret and a webhook route.** There is a verifier; nothing routes to it.
   When a route is added it must carry `@Public()` — Resend sends no bearer token, and the global
   guard refuses an undecorated route with 401 before the handler runs. Measured.

**Until 1–3 exist, checks 1, 2 and 4 below cannot start. Until 4 exists, check 3 cannot.**

---

## 1 — Send twice, one arrives *(not yet applicable)*

The same alert, delivered twice by the pipeline, must produce **one** message. The idempotency key is
the mechanism; the check is that a person finds one message and not two.

**Why a machine cannot close it:** the pipeline can prove it wrote one job. Whether that became one
email is a fact about the provider and an inbox, and neither is inside this system.

> Performed by ____________________ on ____________  Messages found: ______

## 2 — A human opens the email *(not yet applicable)*

Open the message that arrived. Record the **sender address**, the **subject line**, whether it
**rendered** in the client the recipient actually uses, whether the **deep link resolves and demands
authentication** in a private window, and **whether anything in the body names a person or a tenant**.

**A pass is:** nothing in the body names a person or a tenant, and the link demands authentication.

**Why a machine cannot close it:** the body is built from a closed vocabulary with no slot for an
identity. That is a strong guarantee **about what the code can construct**, and it says nothing about
what a template, a subject line or a provider's own footer adds on the way out. **The only place to
see what was actually sent is the thing that received it.**

> Performed by ____________________ on ____________  Anything naming a person? ______

## 3 — A genuine signature still verifies *(not yet applicable)*

Send a real webhook from the provider — a test event from their dashboard is enough — at the
configured endpoint, with the real signing secret in place.

**Already established in a laboratory, and it is not the same thing:** a real Nest pipeline over a
real socket delivers the wire bytes byte-identical to the handler, a genuine signature computed over
those bytes verifies **in the handler**, and a re-serialised body is refused. What that does not
establish is that a **provider's** signature, over a **provider's** bytes, through a route that does
not yet exist, verifies. **The half that was broken was the seam, and this endpoint has no seam yet
because it has no endpoint.**

> Performed by ____________________ on ____________  Verified? ______

## 4 — A real hard bounce *(not yet applicable)*

Cause a genuine hard bounce and confirm it lands on its job, moves it out of accepted, and is visible
to somebody looking for it.

**Why a machine cannot close it:** a bounce is an event a third party decides to send. Every test of
this path supplies its own bounce, which tests the half that already works.

> Performed by ____________________ on ____________  Landed on its job? ______

---

## The one thing this document is for

**So that nobody reads a complete record-only signature sheet as a complete acceptance.** Passing
everything in `alerting-ACCEPTANCE-record-only.md` means HawkView records and shows things
correctly. It does not mean an MSP has been told anything, and these four are the checks that would
establish that. They are not failed. They are **not yet askable**.
