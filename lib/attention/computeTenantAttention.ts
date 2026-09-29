import type { AttentionItem } from '../../types/attention.ts'
import { customerAttention, type CustomerAttention } from './customer-attention.ts'

export type TenantActionableHealthProjection = {
  status: 'VERIFIED' | 'UNAVAILABLE'
  items: AttentionItem[]
  customer?: CustomerAttention
}

/** Customer actions require validated ownership. Positive findings survive partial evidence. */
export function tenantActionableHealthProjection(value: unknown): TenantActionableHealthProjection {
  const customer = customerAttention(value)
  return { status: customer.incomplete ? 'UNAVAILABLE' : 'VERIFIED',
    items: [...customer.findings, ...customer.accessActions], customer }
}

export function computeTenantAttention(value: unknown): AttentionItem[] {
  return tenantActionableHealthProjection(value).items
}
