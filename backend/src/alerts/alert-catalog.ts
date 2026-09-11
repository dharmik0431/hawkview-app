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
    escalations: [],
  },

  // ── Tenant disconnected ────────────────────────────────────────────────────
  {
    id: 'monitoring.tenant_disconnected',
    category: 'OPERATIONAL',
    severity: 'ACT_NOW',
    opensInvestigation: true,
    // Demonstrably recovered: the connection verifies or it does not.
    investigationCloses: 'AUTOMATICALLY_WHEN_CONDITION_CLEARS',
    summary: 'HawkView cannot see this tenant',
    conditionClears: {
      kind: 'CONNECTION_VERIFIED',
      because: 'A verified connection is positive evidence that collection can resume, not an absence of complaints.',
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
 * The plan lists this as an open question that must be answered before step 01
 * can finish, and names role assignment, authentication policy and application
 * permission grants as the obvious candidates. This is that list.
 *
 * IT IS PROPOSED, NOT SETTLED. Which changes are privileged is a product and
 * security decision rather than an engineering one, and it decides what rings a
 * phone — so it needs sign-off before step 05 routes anything on it. It is here,
 * in code, because a policy that lives in a document is one nobody can diff.
 *
 * Each entry carries the three things revision 3 requires of a phone-tier
 * candidate: CONTEXT (was this expected?), PERSISTENCE (has it lasted?) and
 * URGENCY (does delay make it worse?). A privileged role assigned during a
 * scheduled onboarding should not ring a phone, and without the context test it
 * would. */
export interface PrivilegedChangeRule {
  readonly change: string
  /** What would make this expected rather than alarming. */
  readonly context: string
  /** How long it must hold before it is worth waking somebody. */
  readonly persistence: string
  /** Why waiting makes it worse. */
  readonly urgency: string
}

export const PRIVILEGED_DIRECTORY_CHANGES: readonly PrivilegedChangeRule[] = [
  {
    change: 'A directory role granting administrative access is assigned to an account.',
    context: 'Not raised when the assignment falls inside a recorded onboarding or change window for that tenant.',
    persistence: 'Raised immediately; an administrative role is effective the moment it is granted.',
    urgency: 'An unexpected administrator can grant itself more, and can remove the evidence that it did.',
  },
  {
    change: 'An authentication policy is weakened — multi-factor requirements removed or relaxed, or a legacy authentication path re-enabled.',
    context: 'Not raised when it matches a change the MSP has recorded for that tenant.',
    persistence: 'Raised immediately; the weakening applies to the next sign-in.',
    urgency: 'It removes the control that would have stopped the next credential attack, so delay compounds every other finding.',
  },
  {
    change: 'An application is granted a permission that can read mail, files, or directory data across the tenant.',
    context: 'Not raised for applications on the tenant’s recorded allow-list.',
    persistence: 'Raised immediately; consent is effective at once and survives password changes.',
    urgency: 'Application access is not revoked by resetting a user, and it is the quietest way to keep access.',
  },
  {
    change: 'A conditional access policy protecting privileged accounts is disabled or deleted.',
    context: 'Not raised when it matches a recorded change window.',
    persistence: 'Raised immediately; the policy stops applying the moment it is disabled, and nothing re-applies it.',
    urgency: 'The protection is gone from that moment, and its absence is invisible on every screen that shows only what exists.',
  },
]
