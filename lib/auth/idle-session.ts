export const IDLE_TIMEOUT_SECONDS = 60 * 60
export const IDLE_WARNING_SECONDS = 2 * 60

export type IdleIdentity = { subject: string; sessionId: string }
export type IdleReceipt = {
  sessionId: string
  serverNow: string
  idleExpiresAt: string
  idleTimeoutSeconds: number
  warningSeconds: number
}
export type IdleView = {
  phase: 'signed-out' | 'checking' | 'active' | 'warning' | 'expired'
  sessionId: string | null
  remainingSeconds: number
  verificationFailed: boolean
}
type StoredDeadline = { expiresAt: number; observedAt: number; expired: boolean }
export interface IdleEnvironment {
  now(): number
  read(key: string): string | null
  write(key: string, value: string): void
  request(action: 'status' | 'activity' | 'end', token: string): Promise<unknown>
}

export class IdleSessionError extends Error {
  readonly code: string
  constructor(code = 'SESSION_IDLE_EXPIRED') {
    super('Your HawkView session ended. Sign in again to continue.')
    this.name = 'IdleSessionError'
    this.code = code
  }
}

// Decoding here only selects a local cache key. The API verifies the signature,
// subject, session and MFA before authorizing any access or activity receipt.
export function idleIdentity(token: string): IdleIdentity | null {
  try {
    const part = token.split('.')[1]
    const value = JSON.parse(atob(part.replace(/-/g, '+').replace(/_/g, '/')))
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    return uuid.test(value.sub) && uuid.test(value.session_id)
      ? { subject: value.sub, sessionId: value.session_id }
      : null
  } catch { return null }
}

export class IdleSessionController {
  private identity: IdleIdentity | null = null
  private token = ''
  private generation = 0
  private verified = false
  private hidden = false
  private deadline: StoredDeadline | null = null
  private pending: Promise<void> | null = null
  private listeners = new Set<() => void>()
  private expiryListeners = new Set<(identity: IdleIdentity) => void>()
  private notifiedExpired = false
  private verificationFailed = false

  private readonly environment: IdleEnvironment
  constructor(environment: IdleEnvironment) { this.environment = environment }

  subscribe(listener: () => void) {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }
  onExpired(listener: (identity: IdleIdentity) => void) {
    this.expiryListeners.add(listener)
    return () => { this.expiryListeners.delete(listener) }
  }
  private emit() { this.listeners.forEach((listener) => listener()) }
  private key() { return `hawkview:idle:v1:${this.identity?.sessionId}` }
  private read() {
    try {
      const raw = this.environment.read(this.key())
      if (!raw) return
      const stored = JSON.parse(raw) as StoredDeadline
      if (!Number.isFinite(stored.expiresAt) || !Number.isFinite(stored.observedAt)
        || typeof stored.expired !== 'boolean') return
      if (stored.expired || (!this.deadline?.expired &&
        (!this.deadline || stored.expiresAt > this.deadline.expiresAt))) this.deadline = stored
    } catch { /* The server remains authoritative if browser storage fails. */ }
  }
  private persist() {
    try { this.environment.write(this.key(), JSON.stringify(this.deadline)) } catch { /* See read(). */ }
  }
  bind(identity: IdleIdentity, token: string) {
    const changed = identity.sessionId !== this.identity?.sessionId || identity.subject !== this.identity?.subject
    if (changed) {
      this.generation++
      this.identity = identity
      this.verified = false
      this.deadline = null
      this.pending = null
      this.notifiedExpired = false
      this.verificationFailed = false
      this.read()
    }
    this.token = token
    if (changed) this.emit()
  }
  clear() {
    this.generation++
    this.identity = null
    this.token = ''
    this.deadline = null
    this.pending = null
    this.verified = false
    this.notifiedExpired = false
    this.verificationFailed = false
    this.emit()
  }
  currentIdentity() { return this.identity }
  view(): IdleView {
    const remainingSeconds = this.deadline
      ? Math.max(0, Math.ceil((this.deadline.expiresAt - this.environment.now()) / 1000)) : 0
    return {
      phase: !this.identity ? 'signed-out' : this.deadline?.expired ? 'expired'
        : !this.verified || this.hidden ? 'checking'
          : remainingSeconds <= IDLE_WARNING_SECONDS ? 'warning' : 'active',
      sessionId: this.identity?.sessionId ?? null,
      remainingSeconds,
      verificationFailed: this.verificationFailed,
    }
  }
  expire(notify = true) {
    if (!this.identity) return
    if (this.deadline?.expired && this.notifiedExpired) return
    const identity = this.identity
    const token = this.token
    this.notifiedExpired = true
    this.deadline = { expiresAt: this.environment.now(), observedAt: this.environment.now(), expired: true }
    this.verified = false
    this.persist()
    this.emit()
    // Local access closes before either network request. Failure cannot open it.
    void this.environment.request('end', token).catch(() => {})
    if (notify) this.expiryListeners.forEach((listener) => listener(identity))
  }
  check() {
    if (!this.identity) return false
    this.read()
    if (this.deadline && (this.deadline.expired || this.environment.now() >= this.deadline.expiresAt
      || this.environment.now() < this.deadline.observedAt)) {
      this.expire()
      return false
    }
    return true
  }
  tick() { this.check(); this.emit() }
  suspend() { this.hidden = true; this.emit() }
  async resume() {
    this.hidden = false
    if (!this.identity || !this.check()) return
    this.verified = false
    this.verificationFailed = false
    this.emit()
    await this.ensure(this.identity, this.token)
  }
  async ensure(identity: IdleIdentity, token: string): Promise<void> {
    if (this.identity && (this.identity.sessionId !== identity.sessionId || this.identity.subject !== identity.subject)) {
      throw new IdleSessionError('SESSION_CHANGED')
    }
    this.bind(identity, token)
    if (!this.check()) throw new IdleSessionError()
    if (this.verified) return
    if (this.pending) return this.pending
    const generation = this.generation
    const work = this.refresh('status', generation)
    this.pending = work
    try { await work } finally { if (this.pending === work) this.pending = null }
  }
  async activity(): Promise<void> {
    if (!this.identity || this.hidden || !this.verified) return
    if (!this.check()) throw new IdleSessionError()
    await this.refresh('activity', this.generation)
  }
  private async refresh(action: 'status' | 'activity', generation: number) {
    const identity = this.identity!
    const startedAt = this.environment.now()
    try {
      const result = await this.environment.request(action, this.token) as IdleReceipt
      if (generation !== this.generation) throw new IdleSessionError('SESSION_CHANGED')
      if (!this.check()) throw new IdleSessionError()
      const serverNow = Date.parse(result?.serverNow)
      const expires = Date.parse(result?.idleExpiresAt)
      const remaining = expires - serverNow
      if (result?.sessionId !== identity.sessionId || !Number.isFinite(remaining) || remaining <= 0
        || remaining > IDLE_TIMEOUT_SECONDS * 1000
        || result?.idleTimeoutSeconds !== IDLE_TIMEOUT_SECONDS || result?.warningSeconds !== IDLE_WARNING_SECONDS) {
        throw new Error('HawkView could not verify the session timeout policy.')
      }
      // Start at dispatch, not response receipt, so network delay cannot extend it.
      const expiresAt = startedAt + remaining
      if (expiresAt <= this.environment.now()) { this.expire(); throw new IdleSessionError() }
      if (!this.deadline || expiresAt > this.deadline.expiresAt) {
        this.deadline = { expiresAt, observedAt: this.environment.now(), expired: false }
      }
      this.verified = true
      this.verificationFailed = false
      this.persist()
      this.emit()
    } catch (error) {
      if (generation === this.generation) {
        if (error instanceof IdleSessionError && error.code !== 'SESSION_CHANGED') this.expire()
        else this.verificationFailed = true
        this.emit()
      }
      throw error
    }
  }
}
