import { AsyncLocalStorage } from 'node:async_hooks'
import { ServiceUnavailableException } from '@nestjs/common'

interface Ticket { active: boolean }

/** Process-local admission boundary. This is a shutdown witness, not a tenant lease. */
export class SyncDrainRegistry {
  private readonly context = new AsyncLocalStorage<Ticket>()
  private accepting = true
  private active = 0
  private completed = 0
  private resolveDrain: (() => void) | undefined
  private drain: Promise<void> | undefined

  snapshot() {
    return { accepting: this.accepting, active: this.active, completed: this.completed }
  }

  async run<T>(work: () => Promise<T>): Promise<T> {
    const inherited = this.context.getStore()
    if (inherited) {
      if (!inherited.active) throw new ServiceUnavailableException('Tenant synchronization is shutting down.')
      return work()
    }
    if (!this.accepting) throw new ServiceUnavailableException('Tenant synchronization is shutting down.')
    const ticket: Ticket = { active: true }
    this.active += 1
    return this.context.run(ticket, async () => {
      try { return await work() }
      finally {
        ticket.active = false
        this.active -= 1
        this.completed += 1
        if (!this.accepting && this.active === 0) this.resolveDrain?.()
      }
    })
  }

  /** Closes new admissions synchronously, then awaits every already admitted scope. */
  closeAdmissionsAndDrain(): Promise<void> {
    this.accepting = false
    if (this.active === 0) return Promise.resolve()
    this.drain ??= new Promise<void>(resolve => { this.resolveDrain = resolve })
    return this.drain
  }
}

export const syncDrainRegistry = new SyncDrainRegistry()
