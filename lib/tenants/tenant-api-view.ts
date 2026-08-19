type PlainRecord = Record<string, unknown>

function record(value: unknown): PlainRecord | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
    ? (value as PlainRecord)
    : null
}

function own(value: PlainRecord | null, key: string): unknown {
  return value && Object.prototype.hasOwnProperty.call(value, key)
    ? value[key]
    : undefined
}

/** Reads the canonical GET /api/tenants/:id response without accepting inherited data. */
export function tenantNameFromBundleResponse(value: unknown): string | null {
  const response = record(value)
  const bundle = record(own(response, 'bundle'))
  const tenant = record(own(bundle, 'tenant'))
  const name = own(tenant, 'name')
  if (typeof name !== 'string') return null
  const normalized = name.replace(/[\u0000-\u001F\u007F]/g, ' ').trim()
  return normalized ? normalized.slice(0, 320) : null
}
