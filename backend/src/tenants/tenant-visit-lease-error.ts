/**
 * Signals that a tenant visit no longer owns its distributed lease.
 * Callers must stop the visit without recording a resource or provider failure.
 */
export class TenantVisitLeaseLostError extends Error {
  constructor() {
    super('Tenant visit lease ownership was lost.')
    this.name = 'TenantVisitLeaseLostError'
  }
}

/** The bounded direct-pg risk transaction closes errors under one public code
 * while retaining its original cause. Only unwrap this exact ownership loss. */
export function tenantVisitLeaseLoss(error: unknown): TenantVisitLeaseLostError | null {
  if (error instanceof TenantVisitLeaseLostError) return error
  return error instanceof Error && error.cause instanceof TenantVisitLeaseLostError ? error.cause : null
}
