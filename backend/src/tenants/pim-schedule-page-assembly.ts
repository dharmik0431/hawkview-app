import { normalizePimScheduleObservations, type PimObservationBounds,
  type PimObservationResult, type PimPlane, type PimScheduleInput } from './pim-schedule-observation.js'

export interface PimSchedulePage {
  /** Opaque caller token, not a validated or executable network URL. */
  requestedPageToken: string
  envelope: unknown
}
export interface PimPageAssemblyBounds extends PimObservationBounds { maxPages: number }
type Normalized = Extract<PimObservationResult, { ok: true }>
type Failure = Extract<PimObservationResult, { ok: false }>
export type PimPageAssemblyResult =
  | { ok: true; pageCount: number; paginationTerminated: true; observations: Normalized }
  | { ok: false; code: Failure['code'] | 'NO_PAGES' | 'PAGE_LIMIT_EXCEEDED' |
      'INVALID_PAGE_TOKEN' | 'INVALID_PAGE_ENVELOPE' | 'INVALID_CONTINUATION' |
      'PAGE_TOKEN_MISMATCH' | 'REPEATED_PAGE_TOKEN' | 'MISSING_CONTINUATION_PAGE' |
      'PAGE_AFTER_TERMINATION' }

function dataObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) return false
  return Reflect.ownKeys(value).every(key => typeof key === 'string' &&
    Object.hasOwn(Object.getOwnPropertyDescriptor(value, key)!, 'value') &&
    Object.getOwnPropertyDescriptor(value, key)!.enumerable)
}

/** Pure assembly of already parsed data. Caller wrappers/envelopes must be
 * ordinary data, never proxies or executable objects. Entire page chain is
 * validated before rows are flattened and passed to the existing normalizer.
 * paginationTerminated records syntax only: no authority, coverage, successful
 * check time, permissions, deletion, holder or event claim follows from it.
 * Limits do not bound already-resident envelopes, wire bytes or process memory.
 */
export function assemblePimSchedulePages(
  context: { tenantId: string; plane: PimPlane },
  pages: readonly PimSchedulePage[],
  bounds: PimPageAssemblyBounds,
): PimPageAssemblyResult {
  if (!bounds || !Number.isSafeInteger(bounds.maxPages) || bounds.maxPages < 0) {
    return { ok: false, code: 'INVALID_BOUNDS' }
  }
  const checkedBounds = normalizePimScheduleObservations([], bounds)
  if (!checkedBounds.ok) return checkedBounds
  if (!context || typeof context.tenantId !== 'string' || context.tenantId.length === 0 ||
      (context.plane !== 'ACTIVE' && context.plane !== 'ELIGIBLE')) {
    return { ok: false, code: 'INVALID_CONTEXT' }
  }
  if (!Array.isArray(pages)) return { ok: false, code: 'INVALID_INPUT' }
  if (pages.length === 0) return { ok: false, code: 'NO_PAGES' }
  if (pages.length > bounds.maxPages) return { ok: false, code: 'PAGE_LIMIT_EXCEEDED' }
  const seen = new Set<string>()
  const rowPages: unknown[][] = []
  let rowCount = 0
  let expected: string | null = null
  for (let index = 0; index < pages.length; index++) {
    if (index > 0 && expected === null) return { ok: false, code: 'PAGE_AFTER_TERMINATION' }
    const page = pages[index]
    if (!dataObject(page) || !Object.hasOwn(page, 'requestedPageToken') ||
        typeof page.requestedPageToken !== 'string' || !page.requestedPageToken.trim()) {
      return { ok: false, code: 'INVALID_PAGE_TOKEN' }
    }
    const token = page.requestedPageToken
    if (seen.has(token)) return { ok: false, code: 'REPEATED_PAGE_TOKEN' }
    if (index > 0 && token !== expected) return { ok: false, code: 'PAGE_TOKEN_MISMATCH' }
    seen.add(token)
    const envelope = page.envelope
    if (!dataObject(envelope) || !Object.hasOwn(envelope, 'value') || !Array.isArray(envelope.value)) {
      return { ok: false, code: 'INVALID_PAGE_ENVELOPE' }
    }
    const rows: unknown[] = envelope.value
    if (rows.length > bounds.maxInputRows - rowCount) return { ok: false, code: 'INPUT_ROW_LIMIT_EXCEEDED' }
    // Reject sparse/accessor/non-JSON array containers without reading a getter.
    const keys = Reflect.ownKeys(rows).filter(key => key !== 'length')
    if (keys.length !== rows.length || keys.some((key, i) => key !== String(i) ||
        !Object.hasOwn(Object.getOwnPropertyDescriptor(rows, key)!, 'value') ||
        !Object.getOwnPropertyDescriptor(rows, key)!.enumerable)) {
      return { ok: false, code: 'INVALID_PAGE_ENVELOPE' }
    }
    rowCount += rows.length
    rowPages.push(rows)
    const continuation = Object.hasOwn(envelope, '@odata.nextLink') ? envelope['@odata.nextLink'] : null
    if (continuation === null) expected = null
    else if (typeof continuation === 'string' && continuation.trim()) expected = continuation
    else return { ok: false, code: 'INVALID_CONTINUATION' }
  }
  if (expected !== null) return { ok: false, code: 'MISSING_CONTINUATION_PAGE' }
  const input: PimScheduleInput[] = []
  for (const rows of rowPages) for (const record of rows) {
    input.push({ tenantId: context.tenantId, plane: context.plane, record })
  }
  const observations = normalizePimScheduleObservations(input, bounds)
  if (!observations.ok) return observations
  return { ok: true, pageCount: pages.length, paginationTerminated: true, observations }
}
