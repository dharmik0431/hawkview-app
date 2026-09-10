import type { Detector, Finding } from '../contract.js'

/** PLACEHOLDER. Ported to prove the detector seam swaps, not because this is
 * the specification. The detection design is being derived from Microsoft's
 * documented model and this will be replaced; nothing in the core knows this
 * detector exists, and nothing here may leak into the core.
 *
 * Chosen over the two credential rules deliberately: those are built on an
 * outcome vocabulary the research has just invalidated, so porting them would
 * scaffold onto an enum about to change. This one is artefact-based, so it
 * survives that reversal.
 */

/** One mailbox's forwarding configuration, already read and normalized. The
 * detector never talks to Exchange; hidden-rule collection is the collector's
 * problem and a real evasion route, per Microsoft's own remediation guidance. */
export type MailboxForwardingArtefact = Readonly<{
  mailboxRef: string
  observedAt: string
  /** Mailbox-level forwarding, as reported by Exchange. */
  forwardingSmtpAddress: string | null
  forwardingAddress: string | null
  deliverToMailboxAndForward: boolean
  /** Inbox rules, including hidden ones if the collector asked for them. */
  rules: readonly Readonly<{
    enabled: boolean
    redirectTo: readonly string[]
    forwardTo: readonly string[]
    forwardAsAttachmentTo: readonly string[]
  }>[]
}>

const domainOf = (address: string): string | null => {
  const at = address.lastIndexOf('@')
  return at > 0 && at < address.length - 1 ? address.slice(at + 1).trim().toLowerCase() : null
}

/** Built with the tenant's own verified domains rather than deciding what
 * counts as external on its own. A detector that carries tenant configuration
 * inside it cannot be reused across tenants, and one that guesses at domain
 * ownership is asserting something it does not know. */
export function externalForwardingDetector(
  configuration: Readonly<{ verifiedDomains: readonly string[] }>,
): Detector<MailboxForwardingArtefact> {
  const owned = new Set(configuration.verifiedDomains.map(domain => domain.trim().toLowerCase()).filter(Boolean))
  // No verified domains means we cannot tell internal from external. Every
  // address would look external and every mailbox would match, so the detector
  // declines to consider anything rather than manufacturing findings.
  const usable = owned.size > 0

  const isExternal = (address: string | null): boolean => {
    if (address === null) return false
    const domain = domainOf(address)
    return domain !== null && !owned.has(domain)
  }

  return {
    id: 'external-mailbox-forwarding',
    run: applicable => {
      if (!usable) return { considered: 0, findings: [] }
      const findings: Finding[] = []
      for (const mailbox of applicable) {
        const destinations = [
          mailbox.forwardingSmtpAddress,
          mailbox.forwardingAddress,
          ...mailbox.rules.filter(rule => rule.enabled)
            .flatMap(rule => [...rule.redirectTo, ...rule.forwardTo, ...rule.forwardAsAttachmentTo]),
        ]
        if (destinations.some(isExternal)) {
          // Mailbox-scoped, always. This detector reads Exchange artefacts and
          // has no directory binding to offer, so it cannot assert a human. The
          // classifier promotes a mailbox to a directory user on proven binding
          // — exact GUID with userPurpose 'user' — and a detector that guessed
          // here would inflate a count of people with room and shared mailboxes.
          findings.push({
            detectorId: 'external-mailbox-forwarding',
            subject: { kind: 'MAILBOX', mailboxRef: mailbox.mailboxRef },
            observedAt: mailbox.observedAt,
          })
        }
      }
      return { considered: applicable.length, findings }
    },
  }
}
