# Risky Users user guide

Status: **target user experience; not a deployment claim**

Audience: MSP owners, administrators, and technicians

## What the screen means

The Identity Risk screen has two independent channels:

- **HawkView Risky Users** shows explainable HawkView investigation leads from
  supported evidence.
- **Microsoft Entra Risky Users** shows Microsoft-reported risk when the tenant
  is licensed and authorized for that Microsoft service.

One channel does not replace or change the other. A missing Microsoft result does
not make a HawkView result disappear. A HawkView result does not change
Microsoft's severity or lifecycle.

## Read a HawkView reason

Each reason should tell you:

1. who needs investigation;
2. what activity or setting was observed;
3. why it matters and what the evidence cannot prove;
4. the investigation priority and evidence confidence;
5. which source and time window were evaluated;
6. what protection was verified; and
7. what to do next.

Low, Medium, and High are investigation priorities, not probabilities of account
compromise. Protection is displayed beside risk; it is not subtracted from it.

## Recommended MSP steps

For repeated invalid credentials:

- confirm whether the user and application were expected;
- compare event and application timing;
- check for stale saved credentials on known devices or services;
- verify current MFA enforcement and relevant exclusions; and
- follow the MSP incident process if the activity is unexplained.

For failures followed by a successful sign-in:

- validate the successful event, application, device, and source context;
- determine whether the user corrected an expected password problem;
- check event-specific MFA or policy evidence without assuming current policy
  applied historically; and
- use the MSP incident process for suspected unauthorized access, including
  session revocation or password recovery where appropriate.

For external mailbox forwarding:

- confirm whether the forwarding or redirect rule is expected and approved;
- review the external destination and business purpose in the authorized
  Microsoft administration experience;
- remove or change unauthorized forwarding through the normal Microsoft process;
  and
- investigate related access evidence when compromise is suspected.

HawkView recommends these actions but does not change Microsoft accounts,
sessions, passwords, mailbox rules, or policies.

## Coverage and readiness states

| State | Meaning | What to do |
| --- | --- | --- |
| Findings | One or more rules matched qualified evidence. | Review every reason and its time window. |
| No findings in evaluated evidence | No rule matched the named evaluated scope/window. | Do not interpret this as “safe”; check coverage and freshness. |
| Partial coverage | Some required evidence was usable and some was not. | Review the source/rule details and restore missing collection. |
| Waiting for first usable collection | No qualifying evidence window is ready yet. | Complete onboarding and allow the normal collection schedule to run. |
| Missing permission | The requested source cannot be read with current consent. | Have an authorized administrator review the documented permission. |
| Licensing restriction | Microsoft licensing was positively established as insufficient for that source. | Use an available qualified source or update licensing through Microsoft. |
| Stale collection | Evidence is older than the rule permits. | Investigate collection health; do not rely on an old clean result. |
| Collection failure | The source attempt failed. | Use the safe reason and support correlation; do not retry broadly. |
| Unsupported or insufficient fields | Records arrived but cannot safely qualify the rule. | Check source compatibility; do not infer missing values. |
| Unexpected request error | The screen could not load the authorized result. | Retry once, then provide the safe support correlation. |

Event time, ingestion time, and evaluation time are different. Microsoft delivery
delay is not HawkView processing delay. Historical findings retain last-seen time
and must not reappear as fresh merely because data was evaluated again.

## Protection labels

- **MFA required by Conditional Access — [policy]** means fresh evidence proves
  the named enforced policy applies.
- **Conditional coverage** means conditions or exclusions limit coverage.
- **Security Defaults enabled** describes verified tenant configuration, not proof
  that every past sign-in used MFA.
- **Per-user MFA enforced** requires authoritative enforcement state.
- **Protection not verified** means evidence is missing, stale, or ambiguous.
- **Blocked by policy** or **MFA satisfied for this event** requires evidence for
  that event.

MFA registration by itself is not suspicious behavior and is not equivalent to
enforcement.

## Information to give support

Provide only the organization-safe support correlation, tenant display context,
rule ID/version, readiness reason, and relevant timestamps already shown in the
authorized app. Do not send passwords, tokens, raw audit records, mailbox content,
full user exports, private keys, or screenshots containing unrelated tenants.
