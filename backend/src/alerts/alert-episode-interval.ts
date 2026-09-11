import type { AlertTypeDeclaration } from './alert-type.js'

/** How long an alert type must be quiet before its episode closes.
 *
 * DERIVED FROM THE DECLARED RESOLVING CONDITION, never a second constant beside
 * it. A type that says "no further events in a readable 24-hour window" has already
 * stated how long quiet must last for the condition to be over; an episode closing
 * on a different number would mean the incident and the condition disagree about
 * when it stopped, and nothing would force them back together. That is the coupling
 * class that produced three defects here in a week — the fingerprint and its
 * modelled set, the client's evidence table on old rule ids, and `COLLECTOR_FOR`
 * naming a collector that writes a different table. Each was two things that had to
 * agree with nothing making them.
 *
 * A TYPE WITH NO DECLARED WINDOW HAS NO INTERVAL TO DERIVE, and this throws rather
 * than substituting a plausible number. A default would be a second constant
 * wearing a disguise: invisible, unreviewed, and identical in effect to the thing
 * the derivation exists to avoid.
 */

export class NoQuietIntervalDeclared extends Error {
  constructor(readonly alertTypeId: string, readonly declaredKind: string) {
    super(
      `Alert type "${alertTypeId}" resolves on ${declaredKind}, which states no quiet window, so no ` +
      'episode interval can be derived from it. Declare the window on the type rather than defaulting ' +
      'one here: a default is a second constant that no reviewer sees.')
    this.name = 'NoQuietIntervalDeclared'
  }
}

/** Throws `NoQuietIntervalDeclared` when the type declares no window. */
export function quietIntervalMsOf(declaration: AlertTypeDeclaration): number {
  const clears = declaration.conditionClears
  if (clears.kind !== 'NO_FURTHER_EVENTS_IN_READABLE_WINDOW') {
    throw new NoQuietIntervalDeclared(declaration.id, clears.kind)
  }
  return clears.windowHours * 60 * 60 * 1000
}

/** Whether an interval can be derived at all, without throwing to find out.
 *
 * Callers deciding what to build need to ask this; it is not a softer version of
 * the function above. `quietIntervalMsOf` still throws, because a caller that
 * reaches it for an undeclared type has a bug rather than a missing value. */
export function hasQuietInterval(declaration: AlertTypeDeclaration): boolean {
  return declaration.conditionClears.kind === 'NO_FURTHER_EVENTS_IN_READABLE_WINDOW'
}
