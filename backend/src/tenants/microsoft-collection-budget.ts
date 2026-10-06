export type EntraCollectionLimits = {
  pages: number
  rows: number
  pageBytes: number
  materializedBytes: number
  requestTimeoutMs: number
  collectorDeadlineMs: number
}

async function cancelBoundedStream(cancel: () => Promise<unknown> | undefined) {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      Promise.resolve().then(cancel).catch(() => undefined),
      new Promise<void>((resolve) => { timer = setTimeout(resolve, 100) }),
    ])
  } finally { if (timer) clearTimeout(timer) }
}

export async function readBoundedResponseText(
  response: Response,
  maximumBytes: number,
  failureMessage = 'Microsoft Graph response exceeded the bounded response-size limit.',
  deadlineAt = Date.now() + 30_000,
) {
  const declaredLength = Number(response.headers.get('content-length') ?? '0')
  if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) {
    try {
      await cancelBoundedStream(() => response.body?.cancel())
    } catch {
      // A hostile/corrupt stream must not replace the safe bounded failure.
    }
    throw new Error(failureMessage)
  }
  if (!response.body) throw new Error('Microsoft Graph response body was unavailable.')
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    while (true) {
      const remainingMs = deadlineAt - Date.now()
      if (remainingMs <= 0) {
        await cancelBoundedStream(() => reader.cancel())
        throw new Error('Microsoft response exceeded its bounded collection deadline.')
      }
      let timer: ReturnType<typeof setTimeout> | undefined
      const { done, value } = await Promise.race([
        reader.read(),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            reject(new Error('Microsoft response exceeded its bounded collection deadline.'))
            void cancelBoundedStream(() => reader.cancel())
          }, remainingMs)
        }),
      ]).finally(() => { if (timer) clearTimeout(timer) })
      if (done) break
      if (!value) continue
      total += value.byteLength
      if (total > maximumBytes) {
        try {
          await cancelBoundedStream(() => reader.cancel('Microsoft response exceeded bounded limit'))
        } catch {
          // A hostile/corrupt stream must not replace the stable bounded error.
        }
        throw new Error(failureMessage)
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder().decode(bytes)
}

/** Shared whole-collector budget. It is checked before requests and retention. */
export class MicrosoftCollectionBudget {
  readonly deadlineAt: number
  private pages = 0
  private rows = 0
  private retainedBytes = 0
  private wireBytes = 0
  private readonly seen = new Set<string>()
  constructor(readonly limits: Readonly<EntraCollectionLimits>, readonly label: string) {
    this.deadlineAt = Date.now() + limits.collectorDeadlineMs
  }
  assertTime() {
    if (Date.now() >= this.deadlineAt) throw new Error(`Microsoft ${this.label} synchronization exceeded a bounded collection limit.`)
  }
  begin(url: string) {
    this.assertTime()
    if (++this.pages > this.limits.pages || this.seen.has(url)) throw new Error(`Microsoft ${this.label} synchronization exceeded a bounded collection limit.`)
    this.seen.add(url)
  }
  retain(values: readonly unknown[]) {
    this.assertTime()
    for (const value of values) {
      const bytes = Buffer.byteLength(JSON.stringify(value), 'utf8')
      if (++this.rows > this.limits.rows || this.retainedBytes + bytes > this.limits.materializedBytes) throw new Error(`Microsoft ${this.label} synchronization exceeded a bounded collection limit.`)
      this.retainedBytes += bytes
    }
  }
  async read(response: Response): Promise<unknown> {
    const text = await readBoundedResponseText(response, this.limits.pageBytes, `Microsoft ${this.label} synchronization exceeded a bounded page-size limit (capacity guard).`, this.deadlineAt)
    this.assertTime()
    this.wireBytes += Buffer.byteLength(text, 'utf8')
    if (this.wireBytes > this.limits.materializedBytes * 4) throw new Error(`Microsoft ${this.label} synchronization exceeded a bounded collection limit.`)
    try { return JSON.parse(text) as unknown } catch { throw new Error(`Microsoft ${this.label} synchronization returned an unreadable bounded response.`) }
  }
}

/** @internal Shared with existing collectors that cancel without reading a body. */
export { cancelBoundedStream }
