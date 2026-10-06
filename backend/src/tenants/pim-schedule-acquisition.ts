import type { ManagedAuthority } from '../microsoft/managed-connector-authority.js'
import { MicrosoftCollectionBudget, readBoundedResponseText, cancelBoundedStream } from './microsoft-collection-budget.js'
import { copyPimAttempt, copyPimLimits, PIM_ENDPOINTS, pimJsonText, type ParsedEnvelope, type PimAttempt,
  type PimFailure, type PimFailureKind, type PimLimits, type PimTerminalTraversal, type PreparedPimCollection } from './pim-schedule-contract.js'
import { copyPimEnvelopes, preparePimCollection } from './pim-schedule-preparation.js'

export interface PimTransport {
  token(authority: Readonly<ManagedAuthority>, microsoftTenantId: string, deadlineAt: number, signal: AbortSignal): Promise<string>
  /** Must honor redirect:'error': no credentials may follow a provider redirect. */
  fetchPage(request: Readonly<{ url: string; token: string; microsoftTenantId: string;
    method: 'GET'; redirect: 'error'; deadlineAt: number; signal: AbortSignal }>): Promise<Response>
}
class Refused extends Error {
  constructor(readonly kind: PimFailureKind, readonly traversal: PimTerminalTraversal = 'ERRORED') { super(kind) }
}
/** Validation does not extract or rebuild continuation tokens. The original URL is sent verbatim. */
export function validatePimContinuation(value: string, attempt: PimAttempt, initial = false): string {
  if (typeof value !== 'string' || value !== value.trim() || /[\\\s]/.test(value)) throw new Refused('INVALID_CONTINUATION')
  let url: URL
  try { url = new URL(value) } catch { throw new Refused('INVALID_CONTINUATION') }
  if (url.origin !== 'https://graph.microsoft.com' || url.username || url.password || url.hash
    || url.pathname !== new URL(PIM_ENDPOINTS[attempt.plane]).pathname || (initial && value !== PIM_ENDPOINTS[attempt.plane])) {
    throw new Refused('INVALID_CONTINUATION')
  }
  const keys = [...url.searchParams.keys()]
  if (new Set(keys).size !== keys.length || keys.some(k => !['$skiptoken', '$skip'].includes(k) || !url.searchParams.get(k))) throw new Refused('INVALID_CONTINUATION')
  return value
}
async function beforeDeadline<T>(deadlineAt: number, run: (signal: AbortSignal) => Promise<T>, late?: (value: T) => void): Promise<T> {
  const remaining = deadlineAt - Date.now()
  if (remaining <= 0) throw new Refused('DEADLINE', 'TRUNCATED_DEADLINE')
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined, timedOut = false
  const work = Promise.resolve().then(() => run(controller.signal))
  void work.then(value => { if (timedOut) late?.(value) }, () => {})
  try {
    return await Promise.race([work, new Promise<never>((_, reject) => {
      timer = setTimeout(() => { timedOut = true; controller.abort(); reject(new Refused('DEADLINE', 'TRUNCATED_DEADLINE')) }, remaining)
    })])
  } finally { if (timer) clearTimeout(timer) }
}

/** Actual acquisition caller, with only injected token/transport effects. No database locks here. */
export async function acquirePimSchedule(input: PimAttempt, capturedAuthority: Readonly<ManagedAuthority>,
  requestedLimits: PimLimits, transport: PimTransport, bindingUnchanged: () => boolean = () => true): Promise<
    { status: 'exhausted'; prepared: PreparedPimCollection } | { status: 'failed'; failure: PimFailure }> {
  const attempt = copyPimAttempt(input), limits = copyPimLimits(requestedLimits)
  const authority = Object.freeze({ ...capturedAuthority })
  if (authority.configurationRevision !== attempt.configurationRevision) throw new Error('INVALID_PIM_CAPTURE')
  const fingerprint = () => JSON.stringify([copyPimAttempt(input), capturedAuthority])
  const initialBinding = fingerprint()
  const tokenFor = transport.token.bind(transport), fetchPage = transport.fetchPage.bind(transport)
  const budget = new MicrosoftCollectionBudget(limits, 'PIM schedule')
  // Preserve the shared policy's cumulative-wire ceiling as well as the caller's explicit cap.
  // We use its exported reader directly to distinguish parsed envelopes from wire failures.
  const wireLimit = Math.min(limits.wireBytes, limits.materializedBytes * 4)
  const deadlineAt = Math.min(budget.deadlineAt, Date.now() + attempt.expiresAt.getTime() - attempt.startedAt.getTime())
  const envelopes: ParsedEnvelope[] = [], wireFailures: PimFailure['wireFailures'][number][] = []
  let wireBytes = 0, requests = 0
  const check = () => {
    let unchanged = false
    try { unchanged = bindingUnchanged() && fingerprint() === initialBinding } catch { /* invalid mutation */ }
    if (!unchanged) throw new Refused('CONTEXT_CHANGED')
    if (Date.now() >= deadlineAt) throw new Refused('DEADLINE', 'TRUNCATED_DEADLINE')
    budget.assertTime()
  }
  const capacity = () => { throw new Refused('CAPACITY', 'TRUNCATED_BUDGET') }
  try {
    check()
    let next: string | null = validatePimContinuation(attempt.endpointDescriptor, attempt, true)
    // No token acquisition precedes initial request validation or the finite deadline check.
    const token = await beforeDeadline(Math.min(deadlineAt, Date.now() + limits.requestTimeoutMs),
      signal => tokenFor(authority, attempt.microsoftTenantId, deadlineAt, signal))
    check()
    if (typeof token !== 'string' || !token) throw new Refused('PROVIDER_FAILED')
    while (next !== null) {
      check()
      const url = validatePimContinuation(next, attempt, envelopes.length === 0)
      try { budget.begin(url) } catch { check(); capacity() }
      let response: Response | undefined, requestDeadline = deadlineAt
      for (let retry = 0; ; retry++) {
        check(); validatePimContinuation(url, attempt, envelopes.length === 0)
        if (requests >= limits.requests || wireBytes >= wireLimit) capacity()
        requests++
        requestDeadline = Math.min(deadlineAt, Date.now() + limits.requestTimeoutMs)
        response = await beforeDeadline(requestDeadline,
          signal => fetchPage(Object.freeze({ url, token, microsoftTenantId: attempt.microsoftTenantId,
            method: 'GET', redirect: 'error', deadlineAt: requestDeadline, signal })),
          late => { void cancelBoundedStream(() => late.body?.cancel()) })
        try { check() } catch (e) { await cancelBoundedStream(() => response?.body?.cancel()); throw e }
        if (response.redirected || (response.url && response.url !== url)) {
          await cancelBoundedStream(() => response?.body?.cancel()); throw new Refused('INVALID_CONTINUATION')
        }
        if (response.status !== 429) break
        await cancelBoundedStream(() => response?.body?.cancel()); check()
        if (retry >= limits.retryAttempts) throw new Refused('THROTTLED')
        const header = response.headers.get('retry-after')
        const seconds = header && /^\d+(?:\.\d+)?$/.test(header) ? Number(header) : null
        const delay = seconds !== null && Number.isFinite(seconds) ? seconds * 1000 : limits.retryDelayMs
        if (delay >= deadlineAt - Date.now() || delay > 2_147_483_647) throw new Refused('DEADLINE', 'TRUNCATED_DEADLINE')
        await beforeDeadline(deadlineAt, () => new Promise<void>(resolve => setTimeout(resolve, delay)))
        check()
      }
      if (!response.ok) { await cancelBoundedStream(() => response?.body?.cancel()); throw new Refused('PROVIDER_FAILED') }
      if (!response.body) throw new Refused('PROVIDER_FAILED')
      let byteLength = 0
      // Counting the original chunks keeps wire size independent of UTF-8 decoding.
      const counted = new Response(response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) { byteLength += chunk.byteLength; controller.enqueue(chunk) },
      })), { headers: response.headers })
      const maximum = Math.min(limits.pageBytes, wireLimit - wireBytes)
      let text: string
      try { text = await readBoundedResponseText(counted, maximum, 'PIM_CAPACITY', requestDeadline) }
      catch (e) {
        check()
        if (Date.now() >= requestDeadline) throw new Refused('DEADLINE', 'TRUNCATED_DEADLINE')
        if (e instanceof Error && e.message === 'PIM_CAPACITY') capacity()
        throw new Refused('PROVIDER_FAILED')
      }
      check(); wireBytes += byteLength
      if (wireBytes > wireLimit) capacity()
      let parsed: unknown
      try { parsed = JSON.parse(text) } catch {
        wireFailures.push({ pageIndex: envelopes.length, byteLength, failureKind: 'INVALID_JSON' })
        throw new Refused('INVALID_JSON')
      }
      // Copy ordinary parsed values, retaining the envelope even when its shape is invalid.
      let page: ParsedEnvelope
      try {
        const envelope = JSON.parse(pimJsonText(parsed, limits.materializedBytes))
        page = { pageIndex: envelopes.length, requestedToken: url, envelope, byteLength }
        copyPimEnvelopes([...envelopes, page], limits)
      } catch (e) {
        // Parsing may succeed with nonfinite numbers (for example 1e999). Such
        // a page cannot be preserved as parsed JSON; retain metadata, never a coerced body.
        if (e instanceof Error && e.message === 'INVALID_PIM_JSON') {
          wireFailures.push({ pageIndex: envelopes.length, byteLength, failureKind: 'INVALID_JSON' })
          throw new Refused('INVALID_JSON')
        }
        capacity()
      }
      envelopes.push(page!)
      const body = page!.envelope
      if (body === null || typeof body !== 'object' || Array.isArray(body) || !Array.isArray(body.value)) throw new Refused('INVALID_ENVELOPE')
      try { budget.retain(body.value) } catch { check(); capacity() }
      const continuation = Object.hasOwn(body, '@odata.nextLink') ? body['@odata.nextLink'] : null
      if (continuation !== null && (typeof continuation !== 'string' || !continuation.trim())) throw new Refused('INVALID_CONTINUATION')
      next = continuation as string | null
      // Check even a final continuation before any subsequent token-bearing transport.
      if (next !== null) validatePimContinuation(next, attempt)
    }
    check()
    let prepared: PreparedPimCollection
    try { prepared = preparePimCollection(attempt, envelopes, limits) }
    catch (e) {
      if (e instanceof Error && /LIMIT|CAPACITY/.test(e.message)) capacity()
      throw new Refused('INVALID_OBSERVATIONS')
    }
    check()
    return { status: 'exhausted', prepared }
  } catch (e) {
    const failure = e instanceof Refused ? e : new Refused('PROVIDER_FAILED')
    return { status: 'failed', failure: { failureKind: failure.kind, traversalOutcome: failure.traversal,
      envelopes, wireFailures } }
  }
}
