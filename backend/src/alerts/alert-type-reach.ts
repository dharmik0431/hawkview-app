import { ALERT_CATALOG, type AlertTypeId } from './alert-catalog.js'
import { alertTypeForRule, TYPE_FOR_GUIDANCE } from './finding-pipeline.js'
import { emailReleaseConfiguration } from './email-release-config.js'

/** Explicit source-backed proof, not a claim inferred from mappings or stored findings. */
export const hasProvenAlertProducer = (alertTypeId: string): boolean =>
  alertTypeId === 'security.suspected_credential_attack'

export interface AlertPolicyCapability {
  intakeWiring: 'MAPPED' | 'UNMAPPED'
  producerSupport: 'PROVEN' | 'NOT_ESTABLISHED'
  observedInput: 'OPEN_FINDING_PRESENT' | 'NO_OPEN_FINDING'
  editable: boolean
  reason: 'READY' | 'OWNER_REQUIRED' | 'PRODUCER_NOT_ESTABLISHED' | 'INTAKE_UNMAPPED'
}

export function alertPolicyCapability(
  alertTypeId: string, fedTypes: ReadonlySet<AlertTypeId>, canManagePolicy: boolean,
): AlertPolicyCapability {
  const mapped = dispositionIsConsulted(alertTypeId)
  const proven = hasProvenAlertProducer(alertTypeId)
  return {
    intakeWiring: mapped ? 'MAPPED' : 'UNMAPPED',
    producerSupport: proven ? 'PROVEN' : 'NOT_ESTABLISHED',
    observedInput: fedTypes.has(alertTypeId as AlertTypeId) ? 'OPEN_FINDING_PRESENT' : 'NO_OPEN_FINDING',
    editable: mapped && proven && canManagePolicy,
    reason: !mapped ? 'INTAKE_UNMAPPED' : !proven ? 'PRODUCER_NOT_ESTABLISHED'
      : !canManagePolicy ? 'OWNER_REQUIRED' : 'READY',
  }
}

/** Configuration availability only; never serialize the server configuration or promise delivery. */
export function alertPreferenceCapabilities(
  organizationId: string, userId: string,
  env: Readonly<Record<string, string | undefined>> = process.env, now = Date.now(),
) {
  const configuration = emailReleaseConfiguration(env, now)
  let availability: 'DISABLED' | 'CONTROLLED' | 'UNAVAILABLE' = 'UNAVAILABLE'
  let reason: 'SENDER_OFF' | 'CONTROLLED_TRIAL_ONLY' | 'CONFIGURATION_UNAVAILABLE'
    | 'OUTSIDE_ACTIVATION_WINDOW' | 'NOT_DESIGNATED_RECIPIENT'
  if (!configuration.enabled) {
    availability = configuration.reason === 'DISABLED' ? 'DISABLED' : 'UNAVAILABLE'
    reason = configuration.reason === 'DISABLED' ? 'SENDER_OFF'
      : configuration.reason === 'OUTSIDE_ACTIVATION_WINDOW' ? 'OUTSIDE_ACTIVATION_WINDOW'
        : 'CONFIGURATION_UNAVAILABLE'
  } else if (configuration.config.organizationId !== organizationId || configuration.config.ownerUserId !== userId) {
    reason = 'NOT_DESIGNATED_RECIPIENT'
  } else {
    availability = 'CONTROLLED'
    reason = 'CONTROLLED_TRIAL_ONLY'
  }
  return {
    version: 1 as const, readState: 'AVAILABLE' as const, policyWriterRole: 'MSP_OWNER' as const,
    supportedDigestModes: ['off'] as const,
    channels: {
      inApp: { supported: true as const, availability: 'AVAILABLE' as const },
      email: { supported: true as const, availability, reason },
    },
  }
}

/**
 * FOR EACH ALERT TYPE: DOES A SETTING FOR IT DO ANYTHING?
 *
 * **The settings page's honesty depends on this and nothing else.** An MSP who switches a type
 * off and keeps receiving it concludes the product is broken — which is worse than a row saying
 * *nothing feeds this yet*, because the alerts arrive while the setting says they should not.
 *
 * **DERIVED, NOT COUNTED.** This exists because the count has already been got wrong once by
 * hand, in a message that then built a ruling on top of it. `reachOfAlertTypes()` reads
 * `TYPE_FOR_GUIDANCE` and the catalogue, so adding a guidance mapping moves the number without
 * anybody remembering to. A test asserts the current split, so a change is visible in a diff
 * rather than discovered on a settings page.
 */

/** Whether a disposition stored against this type is consulted by anything that produces alerts.
 *
 * TWO ANSWERS, WHICH IS THE READER'S QUESTION. *Will my setting do anything?* There is no third
 * state worth inventing: a type nobody produces and a type produced by something that ignores the
 * setting are the same answer to the person looking at the switch, even though they are different
 * facts to us — and the second is the dangerous one, so it is named separately below rather than
 * hidden behind a third label. */
export type DispositionReach =
  /** Something produces this type AND consults the disposition before delivering. */
  | Readonly<{ kind: 'CONSULTED'; alertTypeId: AlertTypeId }>
  /** Nothing writes a notification carrying this type, so the setting cannot bite either way. */
  | Readonly<{ kind: 'NO_PRODUCER'; alertTypeId: AlertTypeId }>

/**
 * ⚠ THE THIRD CASE — a producer that ignores the disposition — CANNOT ARISE TODAY, and that is a
 * measured fact rather than a design guarantee.
 *
 * `tenant-sync.service.ts` and `tenants.service.ts` do publish notifications, seven of them, and
 * an MSP does receive those. But **none of them carries a catalogue alert type id**: they publish
 * `tenant.connection_lost`, `tenant.sync_failed`, `security.directory_change` and four others, in
 * a different namespace entirely, and `alert_type_id` on those rows is NULL.
 *
 * So they are not *catalogue types whose disposition is ignored* — they are not catalogue types
 * at all, and no settings row exists for them to contradict. **Making the publish path consult a
 * disposition therefore needs an alert type it does not have**, which is a mapping somebody must
 * rule on rather than a lookup somebody can add. `reconciliation.ts` classifies those dedupe keys
 * into catalogue types for step 03, so the mapping is not unknowable — but it lives in the
 * apply phase, not in the publish path, and inventing a second copy at the publish site is the
 * two-homes defect this feature has fixed three times.
 */
export function reachOfAlertTypes(): readonly DispositionReach[] {
  // The only producer that stamps a catalogue alert type onto anything is the intake pipeline,
  // through the guidance-code mapping — and the pipeline consults the disposition. So a type is
  // reachable exactly when some guidance code maps to it.
  const produced = new Set<string>(
    Object.values(TYPE_FOR_GUIDANCE).filter((id): id is AlertTypeId => id !== null))

  return ALERT_CATALOG.map((type): DispositionReach =>
    produced.has(type.id)
      ? { kind: 'CONSULTED', alertTypeId: type.id }
      : { kind: 'NO_PRODUCER', alertTypeId: type.id })
}

/** Whether a producer is WIRED to this type. Not the reader's question on its own — see
 * `settingDoesSomething` below, which is what a settings row must answer. */
export const dispositionIsConsulted = (alertTypeId: string): boolean =>
  reachOfAlertTypes().some(
    (reach) => reach.kind === 'CONSULTED' && reach.alertTypeId === alertTypeId)

/**
 * ⚠ WIRED IS NOT FED, AND THE ROW WAS ANSWERING THE WRONG ONE.
 *
 * `reachOfAlertTypes()` asks *is a producer wired to this type?* It cannot ask *does that
 * producer ever receive anything?*, and for two types the difference is the whole answer: the
 * intake reads `identity_risk_findings`, an organisation with no findings hands the pipeline
 * nothing, and a row saying the setting is consulted is then true about the wiring and false
 * about the reader's question. **The gap is upstream of the producer, so a mechanism that stops
 * at the producer cannot see it.**
 *
 * **DERIVED THROUGH `alertTypeForRule`, NOT LISTED.** That is the same mapping the pipeline uses
 * to stamp a type onto a finding, so a new rule or a changed guidance code moves this answer
 * without anybody remembering to edit it — the property that makes `reachOfAlertTypes` worth
 * having, extended rather than duplicated. A hand-kept "and also has input" list would undo it.
 *
 * **ANY OPEN FINDING COUNTS, REGARDLESS OF AGE**, even one older than the intake's own lookback.
 * The question is whether this organisation has a source at all, not whether an alert is
 * imminent, and answering the second would make the badge flap with the calendar.
 */
export function typesWithProducerInput(ruleIds: readonly string[]): ReadonlySet<AlertTypeId> {
  const fed = new Set<AlertTypeId>()
  for (const ruleId of ruleIds) {
    const alertTypeId = alertTypeForRule(ruleId)
    if (alertTypeId !== null) fed.add(alertTypeId)
  }
  return fed
}

/** What a settings row must say about itself: **will my setting do anything?**
 *
 * Both halves, because either alone is a true answer to a question nobody asked. Kept here
 * rather than in the service so the meaning of `mapped` has one home and can be tested without
 * a database. */
export const settingDoesSomething = (
  alertTypeId: string,
  fedTypes: ReadonlySet<AlertTypeId>,
): boolean => dispositionIsConsulted(alertTypeId) && fedTypes.has(alertTypeId as AlertTypeId)
