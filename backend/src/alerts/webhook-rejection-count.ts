import { type Authentication } from './email-delivery.js'

/**
 * HOW MANY REQUESTS FAILED TO AUTHENTICATE, AS A NUMBER IN MEMORY.
 *
 * NOT A DATABASE WRITE, AND THAT IS THE ENTIRE POINT. The previous version counted rejections
 * with a shared-row SQL upsert per request, which bounded the ROW COUNT and left the DATABASE
 * WORK unbounded — and the work is what an unauthenticated caller actually consumes. Neither the
 * address limiter nor the subject limiter protects this route (see the controller), so the
 * defence has to be that almost nothing happens, not that the result is small.
 *
 * BOUNDED BY CONSTRUCTION: a fixed number of counters, one per verdict, incremented in place.
 * There is no per-request allocation, no key derived from anything a caller sends, and therefore
 * nothing a caller can grow. A map keyed by address or by claimed provider id would have been the
 * obvious "richer" version and would have handed the attacker the allocation.
 *
 * **THIS IS NOT MONITORING AND MUST NOT BE DESCRIBED AS MONITORING.** There is no exporter, no
 * scrape endpoint and no sink: **nothing outside this process can read these numbers.** An earlier
 * version of this comment said the question an operator asks is "is somebody hammering the
 * webhook", "which a monotonic in-process counter answers". No operator can ask it. The only
 * reader is a test.
 *
 * The wording mattered more than it looks: a counter believed to be observability is a monitoring
 * gap that reads as closed. Somebody deciding whether this route needs alerting would have found
 * that sentence and concluded it already had some.
 *
 * **WHAT IT ACCURATELY IS:** an in-memory bound on the work a forged request can cause — the thing
 * that replaced a per-request SQL upsert. That claim stands without an audience.
 *
 * Exporting it is separate work with its own owner. **Do not start one here**; a metrics pipeline
 * attached to a boundary fix is a new infrastructure programme wearing a bug fix's clothes.
 *
 * Not durable, not exact across restarts, not per-tenant — none of which is a defect, because
 * counting attacker requests precisely is not a requirement that outranks API availability.
 */

export interface RejectionCounts {
  readonly SIGNATURE_MISSING: number
  readonly SIGNATURE_INVALID: number
  /** When this began, so a rate can be computed without storing a history. */
  readonly sinceIso: string
}

class RejectionCount {
  private missing = 0
  private invalid = 0
  private since = new Date().toISOString()

  /** Takes the verdict and nothing else. No address, no body, no claimed id — anything derived
   * from the request would be attacker-controlled input reaching storage, which is the shape
   * being removed rather than relocated. */
  record(verdict: Exclude<Authentication, 'AUTHENTIC'>): void {
    if (verdict === 'SIGNATURE_MISSING') this.missing += 1
    else this.invalid += 1
  }

  read(): RejectionCounts {
    return { SIGNATURE_MISSING: this.missing, SIGNATURE_INVALID: this.invalid, sinceIso: this.since }
  }

  /** For tests. Production has no reason to reset a monotonic counter, and offering one would
   * invite a caller to clear the evidence. */
  resetForTest(nowIso = new Date().toISOString()): void {
    this.missing = 0
    this.invalid = 0
    this.since = nowIso
  }
}

/** One instance, because the count is about the process rather than about a request. */
export const rejectionCount = new RejectionCount()
