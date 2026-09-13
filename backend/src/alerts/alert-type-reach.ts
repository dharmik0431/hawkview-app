import { ALERT_CATALOG, type AlertTypeId } from './alert-catalog.js'
import { TYPE_FOR_GUIDANCE } from './finding-pipeline.js'

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

/** What a settings row should say about itself. `true` means *a setting here is consulted by
 * something*, which is the ruling: the reader's question is whether their switch does anything. */
export const dispositionIsConsulted = (alertTypeId: string): boolean =>
  reachOfAlertTypes().some(
    (reach) => reach.kind === 'CONSULTED' && reach.alertTypeId === alertTypeId)
