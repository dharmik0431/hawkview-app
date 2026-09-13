// QA PRE-REGISTRATION — THE DELIVERY CHECKS, written before the sender exists.
//
// This is the only part of the feature where a mistake reaches a real person's inbox and cannot
// be recalled. Everything below is registered before reading any implementation, and the blob
// shas are published so that is checkable rather than claimed.
//
// ═════════════════════════════════════════════════════════════════════════════
// THE SEAM ATTACK, SPENT FIRST. Eight for eight so far.
//
// The obvious shape is `sendEmail(to, subject, html): Promise<{ id }>`. Six things it cannot
// express, and the first one is not fixable by any shape:
//
// 1. "SEND TWICE, ONE ARRIVES" IS NOT OBSERVABLE FROM THE SENDER AT ALL. The product can see
//    what it DID — two calls, one idempotency key, one provider id back. It cannot see what
//    ARRIVED. Whether that became one email or two is a fact about Resend and an inbox, and no
//    assertion inside this codebase can reach it. **So this check is a human observation and
//    must be registered as one.** A test that asserts "one email arrived" by counting our own
//    calls is asserting the thing it assumed.
//
// 2. A DEFAULT OF FALSE IS NOT CHECKABLE BY READING THE DEFAULT. `emailEnabled` defaulting
//    false can be true in the column, false in the type, and overridden by a seed, a migration
//    default, or a UI that writes `true` on create. The strong form is behavioural: WITH NO
//    PREFERENCE ROW AT ALL, a finding that would otherwise send produces no job. Absence, not
//    a literal.
//
// 3. A NEGATIVE CONTROL'S SILENCE IS INDISTINGUISHABLE FROM A BROKEN PIPELINE. "No email
//    arrived" is the same observation as "nothing works". It only means something when the
//    SAME RUN sent something else and named the withheld one with its reason.
//
// 4. A HARD BOUNCE IS A FACT ABOUT AN ADDRESS, NOT AN ERROR IN A LOG. A logged bounce cannot
//    be asked "will this address be tried again". The property is that the NEXT send consults
//    it, so the seam needs a suppression the send path reads — otherwise the bounce is
//    recorded and disregarded, which is how a dead address gets retried forever.
//
// 5. A VERIFIER THAT REJECTS EVERYTHING PASSES A FORGERY TEST. Any check that only asserts
//    "forged is rejected" is satisfied by `return false`. The positive control is not optional
//    here; it is the half that makes the negative mean anything.
//
// 6. A WATERMARK CHOSEN AFTER SEEING THE OUTPUT IS FITTED TO IT. Nobody has picked the instant.
//    If it is picked by turning the system on and looking, the first run IS the experiment, and
//    the experiment sends real email to a real MSP. The count has to be computable BEFORE
//    anything sends.
//
// WHAT NOBODY HERE CAN PIN, restated because it is load-bearing and easy to lose: whether Resend
// honours an idempotency key. Every retry-after-crash path is safe only if it does.
// ═════════════════════════════════════════════════════════════════════════════

/** The signature verdict, computed where the secret lives and nowhere else. */
export type Authentication = 'AUTHENTIC' | 'SIGNATURE_MISSING' | 'SIGNATURE_INVALID'

/** What a verifier must be, so the pure module never sees the secret. A function of the raw
 * body, the headers and the secret — living at the edge, tested at the edge. */
export type Verifier = (rawBody: string, headers: Readonly<Record<string, string>>, secret: string) => Authentication

/** A delivery address and what we know about it. `suppressedBecause` is the bounce made into a
 * FACT the send path reads, rather than a line in a log nobody consults. */
export interface AddressState {
  readonly address: string
  readonly suppressedBecause: 'HARD_BOUNCE' | 'COMPLAINT' | null
  readonly suppressedAtIso: string | null
}

/** What a dry run must be able to say BEFORE anything is sent. */
export interface FirstRunForecast {
  readonly wouldSend: number
  readonly byOrganization: ReadonlyMap<string, number>
  readonly oldestObservedAtIso: string | null
  readonly watermarkIso: string
}

/** THE PROPERTIES. Pre-registered, binding on me, and each labelled by WHO can settle it —
 * because three of these cannot be settled by any assertion in this repository.
 *
 * D1 THE SWITCH IS OFF UNTIL SOMEBODY TURNS IT ON. With NO preference row, a finding that
 *    would otherwise send produces no job. Checked by absence, never by reading a default.
 *    SETTLED BY: a test, against a database with an empty preferences table.
 *
 * D2 SEND TWICE, ONE ARRIVES. Two sends carrying one idempotency key.
 *    SETTLED BY: A HUMAN WITH AN INBOX. Our side can only show one key and one provider id;
 *    whether that became one email is a fact about Resend. Registered as an observation, with
 *    the inbox count written down by the person who looked.
 *
 * D3 A NEGATIVE CONTROL PRODUCES NO EMAIL AND IS SHOWN AS CONSIDERED-AND-WITHHELD, in the SAME
 *    run that sent something else, naming the reason.
 *    SETTLED BY: a test, plus the human confirming the inbox holds exactly one message.
 *
 * D4 A HARD BOUNCE IS A FACT ABOUT AN ADDRESS. After a hard bounce, the NEXT send to that
 *    address does not go — because the send path consults a suppression, not because somebody
 *    read a log. A soft bounce must NOT suppress.
 *    SETTLED BY: a test for the state change; a human for the real bounce arriving.
 *
 * D5 A HUMAN OPENS THE INBOX AND WRITES DOWN WHAT ARRIVED: sender address, subject, whether it
 *    rendered, whether the deep link resolves and demands authentication, and whether anything
 *    in the body names a person or a tenant.
 *    SETTLED BY: a person. Not automatable and not to be dressed as automated.
 *
 * D6 A FORGED SIGNATURE PRODUCES A VERDICT, NOT AN EXCEPTION, and the verdict is never
 *    AUTHENTIC. Missing and invalid are distinguished, because they are different operational
 *    facts: missing is usually us, invalid is usually somebody else.
 *    SETTLED BY: a test at the edge, where the secret is.
 *
 * D7 AND A GENUINE SIGNATURE STILL VERIFIES. THE POSITIVE CONTROL, and it is not optional:
 *    `() => 'SIGNATURE_INVALID'` passes every forgery test ever written.
 *    SETTLED BY: a test against a real Resend signature, which needs the real secret and
 *    therefore cannot be done by me.
 *
 * D8 THE SECRET NEVER REACHES THE PURE MODULE. `authenticate` takes a verdict; nothing in the
 *    delivery module reads an environment variable or accepts a secret.
 *    SETTLED BY: a type-level check plus a grep with its bounds stated.
 *
 * D9 THE FIRST REAL RUN IS FORECAST BEFORE IT RUNS. A dry run reports how many messages would
 *    go and to which organisations, computed from the chosen watermark, with nothing sent.
 *    **IF THAT NUMBER IS MORE THAN A HANDFUL, THE WATERMARK IS WRONG AND IT IS A LAUNCH
 *    BLOCKER, NOT A TUNING QUESTION.** A watermark chosen by turning the system on and looking
 *    has already sent the email it was meant to prevent.
 *    SETTLED BY: a dry run, before the switch, with the number written down and approved.
 */
export const PRE_REGISTERED_DELIVERY = [
  'D1 the switch is off until somebody turns it on',
  'D2 send twice, one arrives — human',
  'D3 a negative control is withheld and shown, in the same run',
  'D4 a hard bounce is a fact about an address',
  'D5 a human opens the inbox and writes down what arrived',
  'D6 a forged signature produces a verdict and never AUTHENTIC',
  'D7 a genuine signature still verifies — the positive control',
  'D8 the secret never reaches the pure module',
  'D9 the first real run is forecast before it runs',
] as const

/** WHAT BINDS ME AND WHAT DOES NOT, the same split as step 06 and the retry layer.
 *
 * D1-D9 ARE PRE-REGISTERED AND BIND ME. The types above are A PROPOSAL — they exist because
 * several of these properties are unaskable of the obvious shape, and something had to carry
 * them. If the implementer picks another shape the properties stay and my checks get rewritten.
 *
 * THREE OF THESE CANNOT BE CLOSED BY ME AT ALL — D2, D5 and D7 need an inbox and a real secret.
 * They are registered so that nobody can later report the feature as verified without saying
 * which of them a person actually did. */
