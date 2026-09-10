import type { CollectorSyncStatus } from '../tenants/service-sync-freshness.js'

/** Whether a stream's evidence may be treated as read at all.
 *
 * The question a sign-in log cannot answer about itself. A tenant whose newest
 * event is eleven days old is either dormant with genuinely no activity, or a
 * tenant where collection stopped and nothing said so — and the events look
 * identical in both cases, because in both cases there are none.
 *
 * That is exactly "collected and genuinely clean" versus "never collected", and
 * rendering the second as the first is this feature's original defect. The
 * collector's own sync state is the only thing that distinguishes them, so the
 * decision is derived from it here rather than left to a caller's judgement —
 * and `assessTenant` cannot be reached without making it.
 */

export type EvidenceDisposition =
  | Readonly<{ read: true }>
  | Readonly<{ read: false; availability: 'NEVER_COLLECTED' | 'UNREADABLE_NOW'; because: string }>

/** Exhaustive on purpose: a new collector status must be classified here rather
 * than falling into whichever branch the author of that status happened not to
 * think about. The unsafe direction is silent — an unclassified status
 * defaulting to "read" would produce a confident zero over a window nobody
 * collected. */
export function evidenceFromSync(status: CollectorSyncStatus): EvidenceDisposition {
  switch (status) {
    // Collection ran and succeeded. Whatever it found — including nothing — is
    // evidence, and a tenant that genuinely has no risky sign-ins must be able
    // to be told so. EMPTY is the case that lets a real, quiet tenant report a
    // confident zero, which is as much a requirement as withholding is.
    case 'SUCCESS':
    case 'EMPTY':
      return { read: true }

    // Collection has not happened yet. Not a failure, and not an answer.
    case 'PENDING':
    case 'RUNNING':
      return { read: false, availability: 'NEVER_COLLECTED', because: 'Collection for this evidence has not completed yet.' }

    // Never attempted, for a stated reason. These are capability statements
    // rather than faults, and a technician reading one should see why rather
    // than an unexplained blank.
    case 'NOT_CONFIGURED':
      return { read: false, availability: 'NEVER_COLLECTED', because: 'This evidence source is not configured for this tenant.' }
    case 'NOT_LICENSED':
      return { read: false, availability: 'NEVER_COLLECTED', because: "This tenant's licensing does not include this evidence source." }
    case 'UNSUPPORTED':
      return { read: false, availability: 'NEVER_COLLECTED', because: 'This evidence source is not supported for this tenant.' }
    case 'PERMISSION_REQUIRED':
      return { read: false, availability: 'NEVER_COLLECTED', because: 'HawkView does not hold the permission needed to collect this evidence.' }

    // Collection attempted and did not deliver current evidence. STALE is the
    // spinnrapp case: rows exist and are readable, and they do not cover the
    // window being asked about — so treating them as read would report a clean
    // result for time nobody collected.
    case 'FAILED':
      return { read: false, availability: 'UNREADABLE_NOW', because: 'The last collection attempt for this evidence failed.' }
    case 'STALE':
      return { read: false, availability: 'UNREADABLE_NOW', because: 'This evidence has not been collected recently enough to cover the window.' }

    // We cannot establish that it was collected. NEVER_COLLECTED would overclaim
    // — that asserts we know it was not — so this says what is true: we cannot
    // read it now, and therefore cannot claim anything from it.
    case 'UNKNOWN':
      return { read: false, availability: 'UNREADABLE_NOW', because: 'The collection state of this evidence could not be determined.' }

    default: {
      const unhandled: never = status
      throw new Error(`Unclassified collector status: ${JSON.stringify(unhandled)}`)
    }
  }
}
