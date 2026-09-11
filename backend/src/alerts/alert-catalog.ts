import type { AlertTypeDeclaration } from './alert-type.js'

/** Every alert type HawkView may raise, with what makes each one stop.
 *
 * An alert type that cannot say what makes it stop is not ready to be built, so
 * `conditionClears` is a required field and nothing can be added here without
 * answering it. That is the whole reason this file is a declaration rather than
 * a set of `publish()` calls scattered through the collectors, which is what
 * produced the current 364.
 *
 * NOTHING HERE PUBLISHES ANYTHING. Step 01 is the lifecycle and the declarations;
 * grouping is 02, reconciling the existing 364 is 03, and connecting Risky Users
 * is 04. This file is what those steps must conform to.
 */

export const ALERT_CATALOG = [
  // ── Suspected credential attack ────────────────────────────────────────────
  {
    id: 'security.suspected_credential_attack',
    // The account being attacked. The failures come from many addresses and often resolve to nothing, so the attacker is not a subject that groups.
    subject: 'TARGET',
    category: 'SECURITY',
    severity: 'ACT_NOW',
    opensInvestigation: true,
    investigationCloses: 'ONLY_BY_A_PERSON',
    // "Suspected", never "confirmed". Repeated lockouts are an investigation
    // signal and they also come from stale credentials on a phone, a
    // misconfigured service account, or a legitimate user having a bad morning.
    summary: 'Suspected credential attack',
    conditionClears: {
      kind: 'NO_FURTHER_EVENTS_IN_READABLE_WINDOW',
      windowHours: 24,
      because:
        'Lockouts stopping is evidence the activity stopped, never evidence the account is clean — ' +
        'and lockouts also stop when collection stops, so the quiet only counts across time HawkView could see.',
    },
    escalations: [
      {
        signal: 'SUCCESS_FOLLOWED_FAILURES',
        because:
          'Repeated failures and then a success from the same source is a different situation from more failures. ' +
          'It is the thing the recipient most needs to hear, and a flat same-incident rule would swallow it.',
      },
      {
        signal: 'SUBJECT_HOLDS_PRIVILEGED_ROLE',
        because: 'The same activity against an administrator is a different problem from the same activity against a mailbox.',
      },
      {
        signal: 'SPREAD_TO_ADDITIONAL_SUBJECTS',
        because: 'One account under attack is an account. Several at once is a campaign, and the response differs.',
      },
    ],
  },

  // ── Privileged directory change ────────────────────────────────────────────
  {
    id: 'security.privileged_directory_change',
    // Who made the change. One compromised administrator touching twelve accounts is ONE incident, not twelve pages.
    subject: 'ACTOR',
    category: 'SECURITY',
    severity: 'ACT_NOW',
    opensInvestigation: true,
    investigationCloses: 'ONLY_BY_A_PERSON',
    summary: 'Privileged directory change',
    conditionClears: {
      kind: 'CONFIGURATION_RESTORED',
      because:
        'The change being reverted is observable. It clears the condition and does not close the question: ' +
        'that it happened at all is the finding, and whether it was authorised is a person’s judgement.',
    },
    escalations: [
      {
        signal: 'CORROBORATED_BY_SECOND_SOURCE',
        because: 'A role assignment alongside a suspected credential attack on the same tenant is one story, not two.',
      },
      {
        signal: 'SPREAD_TO_ADDITIONAL_SUBJECTS',
        because: 'Several privileged changes in one window is a pattern rather than an administrator doing their job.',
      },
    ],
  },

  // ── Routine directory change ───────────────────────────────────────────────
  {
    id: 'security.routine_directory_change',
    // Who made the change, for the same reason as the privileged case — a bulk operation by one person is one record.
    subject: 'ACTOR',
    category: 'SECURITY',
    severity: 'RECORD_ONLY',
    // No investigation. See the note on `opensInvestigation`: a record with
    // nothing to do must not sit in a queue only a person can empty, which is
    // what 301 of the current alerts are.
    opensInvestigation: false,
    summary: 'Directory change recorded',
    conditionClears: {
      kind: 'CONFIGURATION_RESTORED',
      because: 'A record of something that happened. It has no ongoing condition to clear beyond the change itself.',
    },
    // A RECORD THAT CAN STILL BECOME AN INVESTIGATION. "Records do not open
    // investigations" is a default, not a prohibition — a routine change that
    // turns out to be the first step of something must be promotable, or keeping
    // records out of the queue would make them un-investigable and we would have
    // traded one dead end for another.
    escalations: [
      {
        signal: 'CORROBORATED_BY_SECOND_SOURCE',
        because:
          'An ordinary-looking change during a suspected credential attack on the same tenant is not ordinary. ' +
          'Nothing about the change itself moved; what changed is the company it is in.',
      },
      {
        signal: 'SPREAD_TO_ADDITIONAL_SUBJECTS',
        because:
          'One routine change is administration. Many across subjects in one window is a pattern, ' +
          'and the pattern is the finding rather than any single change in it.',
      },
    ],
  },

  // ── Tenant disconnected ────────────────────────────────────────────────────
  {
    id: 'monitoring.tenant_disconnected',
    // Nobody performed this and nothing was targeted. The tenant is the subject.
    subject: 'TENANT',
    category: 'OPERATIONAL',
    severity: 'ACT_NOW',
    opensInvestigation: true,
    // Auto-close is right here — a human click between a tenant reconnecting and
    // the alert closing is friction that buys no information. What counts as
    // reconnected is the part that needed fixing; see conditionClears below.
    investigationCloses: 'AUTOMATICALLY_WHEN_CONDITION_CLEARS',
    summary: 'HawkView cannot see this tenant',
    // CLEARS ON EVIDENCE, NOT ON THE HANDSHAKE.
    //
    // This was CONNECTION_VERIFIED, and the reasoning for it was half right: a
    // verified connection IS positive evidence rather than an absence of
    // complaints. But "collection can resume" is a weaker claim than the one this
    // alert opened on. The summary says HawkView cannot SEE this tenant, and the
    // inverse of cannot-see is evidence arrived — not the handshake works.
    //
    // The failure that makes it matter: a tenant reconnects with narrower consent,
    // or reconnects cleanly while one collector still returns PERMISSION_REQUIRED.
    // The connection verifies, the alert closes, and an MSP has been told their
    // visibility came back when part of it did not. On a phone-tier page, which is
    // how people learn to stop trusting pages.
    //
    // COLLECTOR_REPORTS_SUCCESS would not have fixed it either — it is satisfied
    // by ANY one collector succeeding, which is the same partial visibility in
    // different words. Hence the plural in EVERY_COVERED_SOURCE_READABLE.
    conditionClears: {
      kind: 'EVERY_COVERED_SOURCE_READABLE',
      because:
        'The claim this alert makes is that HawkView cannot see the tenant, so only every covered source ' +
        'being readable again retracts it. A verified connection proves collection CAN resume; it does not ' +
        'prove anything arrived, and one collector answering does not prove the rest did.',
    },
    escalations: [
      {
        signal: 'PERSISTED_BEYOND_EXPECTED_WINDOW',
        because:
          'A tenant disconnected for five minutes during a Microsoft blip should not ring a phone. ' +
          'One still disconnected after the window is a different fact, and blindness compounds.',
      },
    ],
  },

  // ── Collector failing ──────────────────────────────────────────────────────
  {
    id: 'monitoring.collector_failing',
    // The specific feed. TENANT here would merge two collectors failing for two different reasons into one incident, and they are two different fixes.
    subject: 'COLLECTOR',
    category: 'OPERATIONAL',
    severity: 'ACT_TODAY',
    opensInvestigation: true,
    investigationCloses: 'AUTOMATICALLY_WHEN_CONDITION_CLEARS',
    summary: 'A collector is failing',
    conditionClears: {
      kind: 'COLLECTOR_REPORTS_SUCCESS',
      because:
        'A collector that succeeds has demonstrably recovered. This is the one place auto-closing is safe, ' +
        'and holding it open is the noise that teaches people to ignore the queue.',
    },
    escalations: [
      {
        signal: 'PERSISTED_BEYOND_EXPECTED_WINDOW',
        because: 'A failing collector past its window means the evidence behind other findings is going stale.',
      },
      {
        signal: 'SPREAD_TO_ADDITIONAL_SUBJECTS',
        because:
          'One collector failing on one tenant is a fault. The same collector failing across the fleet is one cause, ' +
          'and must be reported once rather than once per tenant.',
      },
    ],
  },

  // ── Consent expiring ───────────────────────────────────────────────────────
  {
    id: 'monitoring.consent_expiring',
    // Consent is granted per tenant, so the tenant is what expires.
    subject: 'TENANT',
    category: 'OPERATIONAL',
    severity: 'ACT_TODAY',
    opensInvestigation: true,
    investigationCloses: 'AUTOMATICALLY_WHEN_CONDITION_CLEARS',
    summary: 'Microsoft consent is expiring',
    conditionClears: {
      kind: 'CONNECTION_VERIFIED',
      because: 'Re-consent is observable at the next verification, and nothing is inferred from quiet.',
    },
    escalations: [
      {
        signal: 'PERSISTED_BEYOND_EXPECTED_WINDOW',
        because: 'Consent that expires takes collection with it, so proximity to the date changes what this is.',
      },
    ],
  },

  // ── Monitoring recovered ───────────────────────────────────────────────────
  {
    id: 'monitoring.recovered',
    // Recovery is observed per feed, matching the failure it resolves.
    subject: 'COLLECTOR',
    category: 'OPERATIONAL',
    severity: 'RECORD_ONLY',
    opensInvestigation: false,
    summary: 'Collection recovered',
    conditionClears: {
      kind: 'COLLECTOR_REPORTS_SUCCESS',
      because:
        'Recovery is a record, not a task. Today it is published as 17 unresolved alerts of its own — ' +
        'good news filed as a problem, because recovery closes nothing.',
    },
    escalations: [],
  },
] as const satisfies readonly AlertTypeDeclaration[]

export type AlertTypeId = (typeof ALERT_CATALOG)[number]['id']

export function alertType(id: AlertTypeId): AlertTypeDeclaration {
  const found = ALERT_CATALOG.find((declaration) => declaration.id === id)
  // Unreachable through the type, and a throw rather than a default because a
  // missing declaration must never resolve to some other type's resolving
  // condition.
  if (!found) throw new Error(`No alert type declared for ${id}`)
  return found
}

/** WHICH DIRECTORY CHANGES ARE PRIVILEGED — a policy, written down and
 * reviewable rather than inferred per event.
 *
 * APPROVED WITH CORRECTIONS, AND NOW IMPLEMENTED. The decisions live in
 * `privileged-change.ts`, which classifies a change as URGENT, ROUTINE or
 * UNCLASSIFIED from fields already collected. This block stays as the
 * human-readable statement of why each kind of change is on the list at all: the
 * classifier says what happens, this says what it is for, and they are meant to be
 * read together.
 *
 * Two of the six corrections were defects rather than refinements — HawkView must
 * not be exempt by application id alone, and the consent rule contradicted itself.
 * Both are described where they are implemented.
 *
 * EXPECTEDNESS IS NOT APPLIED ANYWHERE IN THIS POLICY. Each entry used to carry a
 * `context` clause suppressing the alert when the change matched a recorded
 * onboarding or change window. Both are gone, for two reasons:
 *
 *   1. The failure direction. HawkView does not know what an MSP planned, so any
 *      expectedness test is a guess, and the way a guess fails here is silence
 *      during a real compromise — the failure this whole plan exists to remove. A
 *      privileged role granted during genuine onboarding costs an MSP one
 *      dismissed notification; the reverse mistake costs them a tenant. There is
 *      no volume argument to justify the risk either: the urgent tier measures 25
 *      events across 68 days and 5 tenants, so there is no burst to suppress.
 *
 *   2. THERE ARE NO RECORDED CHANGE WINDOWS. The feature does not exist. So the
 *      clause suppressed nothing at all while reading exactly like a safeguard —
 *      a guard that cannot fire, sitting in the document steps 02 through 05 will
 *      be built from. That is the shape this codebase has been bitten by
 *      repeatedly, and it is worse than the wrong rule because it looks handled.
 *
 * Each entry therefore carries only what can be decided from evidence HawkView
 * actually holds: PERSISTENCE (has it lasted?) and URGENCY (does delay make it
 * worse?). */
export interface PrivilegedChangeRule {
  readonly change: string
  /** How long it must hold before it is worth waking somebody. */
  readonly persistence: string
  /** Why waiting makes it worse. */
  readonly urgency: string
}

export const PRIVILEGED_DIRECTORY_CHANGES: readonly PrivilegedChangeRule[] = [
  {
    change: 'A directory role granting administrative access is assigned to an account.',
    persistence: 'Raised immediately; an administrative role is effective the moment it is granted.',
    urgency: 'An unexpected administrator can grant itself more, and can remove the evidence that it did.',
  },
  {
    change: 'An authentication policy is weakened — multi-factor requirements removed or relaxed, or a legacy authentication path re-enabled.',
    persistence: 'Raised immediately; the weakening applies to the next sign-in.',
    urgency: 'It removes the control that would have stopped the next credential attack, so delay compounds every other finding.',
  },
  {
    change: 'An application is granted a permission that can read mail, files, or directory data across the tenant.',
    persistence: 'Raised immediately; consent is effective at once and survives password changes.',
    urgency: 'Application access is not revoked by resetting a user, and it is the quietest way to keep access.',
  },
  {
    change: 'A conditional access policy protecting privileged accounts is disabled or deleted.',
    persistence: 'Raised immediately; the policy stops applying the moment it is disabled, and nothing re-applies it.',
    urgency: 'The protection is gone from that moment, and its absence is invisible on every screen that shows only what exists.',
  },
]
