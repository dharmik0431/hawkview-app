# Auditing privileged reads of customer identity data

## What was missing

The role gate decided correctly who may see a customer's named users, and then
forgot it happened. Nothing recorded **which operator viewed which customer's
people**.

That is what an MSP's own client eventually asks for, and it is the only thing
that answers *"what did they see?"* after one of your operator accounts is
compromised. Without it the honest answer is "everything that role could reach,
for as long as the account was open".

## What is recorded

One row in `workspace_admin_audit_logs` per read that actually named somebody.

| Column | Value |
|---|---|
| `action` | `CUSTOMER_IDENTITY_DISCLOSED` |
| `actorUserId` | the operator who was shown the names |
| `organizationId` | the MSP they belong to |
| `targetType` / `targetOpaqueId` | `CUSTOMER_TENANT` / the tenant id |
| `metadata.namedSubjectCount` | how many distinct people were named |
| `metadata.surface` | `RISKY_USERS_ASSESSMENT` |
| `requestId` | correlates with the response the operator received |
| `expiresAt` | 365 days, the existing workspace window |

### Why this table, given the name is wrong

`workspace_admin_audit_logs` no longer holds only workspace-admin actions, and a
name that makes a claim about its contents is a fault this codebase has hit
repeatedly. It is accepted deliberately and written down in two places — here and
in the Prisma model — so the next person is told rather than misled.

The alternative is worse. A second audit table means a second retention
implementation, and **two retention implementations is a worse failure than one
misnamed table**: the second one stops silently and nobody notices for a year.
Retention, pruning and the organization-isolation tests behind this table are
already proven. A rename is a separate, optional cleanup.

## What is deliberately NOT recorded

**The names.** This is the constraint that matters most. An audit log of who saw
which identities must never become a second, longer-lived copy of those
identities — it would be the largest identity store in the product, kept for a
year, and justified as a control.

So the row carries a **count** and a **tenant**. Never a display name, never a
UPN, and not the opaque subject refs either, since those are stable per person and
would re-identify across rows.

Three things enforce that rather than one:

1. `recordIdentityDisclosure`'s parameters cannot carry a name — there is nowhere
   to put one.
2. `writeWorkspaceAudit` hardcodes `actorEmail: null` and `targetEmail: null`.
3. `safeWorkspaceAuditMetadata` drops any key not on its allowlist, so an edit
   that adds a name to metadata writes nothing rather than leaking. The two keys
   this uses are a bounded integer and a closed enum.

**Reads that named nobody.** `subjectsNamed` can be true while no directory row
matched, so nothing identifying reached the operator. Recording those would fill
the log with rows in which nothing was shown, and a log that is mostly noise is
one nobody reads when it matters. The event is *a disclosure*, not *a request*.

**Unnamed reads and page loads.** Every role sees counts, coverage and opaque
refs; only `MSP_OWNER` and `MSP_ADMIN` see who. Only the second is a disclosure.

## Where the write lives, and why there

Inside `discloseSubjects` in `risky-users.controller.ts` — the function that turns
opaque refs into people — and **not** beside the call to it.

If recording were a separate step, a future edit would eventually drop one of the
two, and a silently-missing audit trail is worse than none because it gets
trusted. That function is the only place in the controller that queries
`directory_users` for a display name, so there is no path to a name that does not
pass through the line that records it. It was renamed from `resolveSubjects` for
the same reason: a name that still said "resolve" would invite someone to add a
second resolver beside it.

### The one place two requirements conflict

"Impossible to serve names without writing the row" and "the audit write must
never fail the read" cannot both be absolute. A technician investigating a live
attack must not be blocked because an audit insert failed, so
`recordIdentityDisclosure` swallows its own failure.

What is guaranteed is that the **attempt** is inseparable from the naming. A
failure is then visible as `identity_disclosure_audit_failed` in the service logs
rather than as a quietly missing row — absent rows have a loud cause, which is
what keeps the trail trustworthy.

## What to check first when it breaks

**Symptom: an operator viewed named users and no row appeared.**

1. **Search the service logs for `identity_disclosure_audit_failed`.** If it is
   there, the write was attempted and the database refused it; the line carries
   the tenant, the count and the error name. That is a database problem, not a
   wiring problem.
2. **If there is no such line, check whether anybody was actually named.** A read
   by `MSP_TECHNICIAN` or `MSP_VIEWER` names nobody, and a read where no directory
   row matched names nobody. Neither is a disclosure and neither writes a row.
   `subjectsNamed: true` in the response is *not* sufficient — look for
   `displayName` on the items.
3. **If names were served and nothing was logged**, the write has been detached
   from the naming. That is the failure this design exists to prevent; check that
   the `recordIdentityDisclosure` call is still inside `discloseSubjects` and not
   beside its caller. `identity-disclosure.test.ts` fails loudly if it is removed
   — five of its six tests — so a green suite makes this unlikely.

**Symptom: rows are disappearing.** They expire after 365 days by design, pruned
by the existing workspace audit sweep. There is one retention policy, and it is
`WORKSPACE_AUDIT_RETENTION_DAYS`. If rows are vanishing sooner, that sweep is the
only thing that deletes them.

**Symptom: the count looks wrong.** It is the number of subjects actually named in
that response, not the number of findings and not the number of subjects asked
about. A tenant with five findings across three people, two of whom have directory
rows, records `2`.

## What is NOT covered, and it is not a small gap

**Only the risky-users surface writes these rows.** The older identity-risk
endpoints also disclose customer identities and are **not** audited:

- `identity-signals/assessment` — `risk-assessment-reader.service.ts` builds
  mailbox labels from `mail ?? userPrincipalName` and returns them in
  `RiskAssessmentUserDto`.
- `findingDetail` and the mailbox investigation in `identity-risk.service.ts`,
  both gated on `evidenceDetailAllowed` — the same role tier, the same kind of
  data.

These are registered, live endpoints, but they are **not reached from the UI**:
the component that calls them, `identity-risk-section.tsx`, is mounted by nothing
under `app/` since Risky Users was relocated out of Entra. So the gap is that any
authenticated operator with the role can call them **directly** and be shown a
customer's people with nothing recorded — not that operators are being shown
names in normal use. That changes its urgency, not its existence.

An earlier revision of this section said both paths were live and being served to
customers. That was wrong, and the mechanism is worth keeping: a `grep -l` for
`identity-risk-hooks` matched `risky-users-assessment-hooks.ts`, and the match
was a sentence in a **comment** — the one explaining why that module is separate
and deliberately does not use the old hooks. **A file mentioning a thing is not a
file importing it, and a file importing a thing is not a route reaching it.**

Overstating exposure is the safer direction to be wrong in and still wrong: it
spends attention a real gap elsewhere needs, and this is the sentence in this
document a reader would act on.

`recordIdentityDisclosure` is written to be surface-agnostic for exactly this
reason — covering those paths means adding a `DisclosureSurface` value and one
call at each disclosure point, plus deciding the count from each DTO. It was left
out of this change because it means editing the old engine's reader, which is
dense and serves customers today; it should be its own change with its own
verification, not a rider on this one.

Until then, the accurate statement is **"risky-users disclosures are audited"**,
not "privileged reads are audited".
