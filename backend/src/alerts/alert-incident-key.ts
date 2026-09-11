import { joinUnambiguously } from './alert-key-encoding.js'
import type { AlertTypeDeclaration } from './alert-type.js'

/** The INCIDENT key — grouping, and nothing else.
 *
 * The other half of the pair. `alert-event-key.ts` answers "have we already
 * processed this exact event" and is structurally unable to group;
 * this answers "which incident does this belong to" and is structurally unable to
 * deduplicate, because it contains no event identifier. Both jobs are necessary.
 * Asking one field to do both is the existing defect, visible in two strings:
 *
 *   tenant:{id}:sync:{resourceType}       no event id  ->  334 occurrences, 15 alerts
 *   security:directory-audit:{auditId}    an event id  ->  301 events, 301 alerts
 *
 * THE SUBJECT COMES FROM THE DECLARATION, NOT FROM THE CALLER. This function takes
 * the whole `AlertTypeDeclaration` rather than a role argument, so a caller cannot
 * pass a role that disagrees with what the type declares. A role parameter would be
 * a second place the same fact lives, and the two would be free to drift — which is
 * the coupling shape that produced three defects here in a week.
 */

/** The subject, after whatever resolution the caller could do.
 *
 * `resolved: false` is a first-class outcome rather than an empty string, because
 * the two must not be able to reach the same key. An unresolvable subject is the
 * case below, and an empty string would group every unattributable event in a
 * tenant into one incident — silently.
 */
export type ResolvedSubject =
  | Readonly<{ resolved: true; id: string }>
  | Readonly<{
      resolved: false
      /** What was missing. Carried so the unattributed set can be surfaced and
       * SHRUNK rather than quietly accumulating — the same discipline as
       * `ClassifiedChange.unknown`. */
      why: string
    }>

export interface IncidentScope {
  readonly organizationId: string
  readonly customerTenantId: string
}

export type Grouping =
  | Readonly<{ groups: true; key: string }>
  | Readonly<{ groups: false; because: string; why: string }>

/** Which incident this event belongs to, or that it belongs to none.
 *
 * AN UNRESOLVABLE SUBJECT DOES NOT GROUP. It stands alone, labelled unattributed.
 * Merging on "unknown" asserts a relationship there is no evidence for — it would
 * say "these events are the same incident" on the strength of not knowing who did
 * either of them. Standing alone asserts nothing. And if unattributed volume
 * becomes a problem, that is a visible signal to fix attribution rather than a
 * silent merge to discover later.
 *
 * The role is part of the key, even though it is derivable from the type id today.
 * A declaration can change, and if it does, events keyed under the old role must
 * not join episodes keyed under the new one: that would merge "who did this" with
 * "who it was done to" under one incident.
 */
export function incidentGrouping(
  declaration: AlertTypeDeclaration,
  scope: IncidentScope,
  subject: ResolvedSubject,
): Grouping {
  if (!subject.resolved) {
    return {
      groups: false,
      because:
        `This event has no resolvable ${declaration.subject.toLowerCase()}, so it is recorded on its own ` +
        'rather than joined to an incident. Grouping on an unresolved subject would assert that these ' +
        'events are related on the strength of not knowing who was involved in either.',
      why: subject.why,
    }
  }

  return {
    groups: true,
    key: joinUnambiguously([
      'hawkview-alert-incident/v1',
      declaration.id,
      scope.organizationId,
      scope.customerTenantId,
      declaration.subject,
      subject.id,
    ]),
  }
}

/** Whether two events would land in the same incident, for readers and tests.
 *
 * Exists because the interesting property of a grouping key is a RELATION between
 * two events, and asserting on the opaque string makes a test a shape assertion —
 * green on any change to the encoding, and silent about whether the two actually
 * group. Comparing groupings says the thing that matters. */
export function wouldGroupTogether(left: Grouping, right: Grouping): boolean {
  // Two non-grouping events are not "the same incident" — they are two incidents
  // of one event each. Returning true here would reintroduce the unknown-subject
  // merge through the back door.
  if (!left.groups || !right.groups) return false
  return left.key === right.key
}
