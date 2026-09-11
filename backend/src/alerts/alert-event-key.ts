/** The EVENT key — idempotency, and nothing else.
 *
 * TWO LAYERS, NOT ONE REPLACING THE OTHER. This key answers "have we already
 * processed this exact event", and it is deliberately unable to answer "which
 * incident does this belong to". The incident key is a separate thing with
 * separate inputs, and letting one key do both jobs is what the current system
 * does — visibly, in two strings:
 *
 *   tenant:{id}:sync:{resourceType}          no event id  →  334 occurrences, 15 alerts
 *   security:directory-audit:{auditId}       an event id  →  301 events, 301 alerts
 *
 * Same field, opposite behaviour, decided by whether the author happened to
 * include an event identifier. The one that groups cannot deduplicate and the one
 * that deduplicates cannot group. Both jobs are necessary, so both get a key.
 *
 * Event-level idempotency is also NOT redundant with the storage layer:
 * `directory_audit_logs` carries `@@unique([customerTenantId, microsoftAuditId])`,
 * which stops the same audit row being stored twice. It says nothing about whether
 * an alert was already raised from it, which is the question here.
 */

import { joinUnambiguously } from './alert-key-encoding.js'

/** Components are length-prefixed rather than separator-joined; the reason, and
 * the cross-tenant collision it prevents, are in `alert-key-encoding.ts`. */

export interface AlertEventIdentity {
  /** Which collector or feed produced it. Two sources may legitimately use the
   * same identifier space, so it is part of the key. */
  readonly source: string
  readonly organizationId: string
  readonly customerTenantId: string
  /** The identifier the SOURCE assigned — Microsoft's audit id, for example.
   * Never one HawkView minted, or a replay would look new. */
  readonly eventId: string
}

export function eventKey(event: AlertEventIdentity): string {
  return joinUnambiguously([
    'hawkview-alert-event/v1',
    event.source,
    event.organizationId,
    event.customerTenantId,
    event.eventId,
  ])
}

export interface Admission {
  /** False when this exact event has already been processed. A replay must add
   * neither a notification nor an occurrence — not a quieter notification, and
   * not an occurrence count bump. It is the same event, and it already counted. */
  readonly admit: boolean
  readonly key: string
}

/** Whether this event may be processed at all.
 *
 * Takes the seen-set rather than reading storage, so the rule is testable without
 * a database and so the layer above chooses where "seen" lives. */
export function admitEvent(
  event: AlertEventIdentity,
  alreadySeen: ReadonlySet<string>,
): Admission {
  const key = eventKey(event)
  return { admit: !alreadySeen.has(key), key }
}
