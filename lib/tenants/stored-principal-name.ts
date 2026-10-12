/** Labels from an already loaded, tenant-bound directory bundle. No network lookup. */
const record = (value: unknown): Record<string, any> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value : null
const key = (value: unknown) => typeof value === 'string' ? value.trim().toLowerCase() : ''
const guid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i
export function storedPrincipalNames(bundle: unknown, customerTenantId: string): ReadonlyMap<string, string | null> {
  const names = new Map<string, string | null>()
  const data = record(bundle)
  if (!customerTenantId || data?.tenant?.id !== customerTenantId) return names
  const add = (id: unknown, ...labels: unknown[]) => {
    const identity = key(id)
    const name = labels.find(label => typeof label === 'string' && label.trim()
      && key(label) !== identity && !guid.test(label.trim()))
    if (!identity || typeof name !== 'string') return
    const text = name.trim()
    if (!names.has(identity)) names.set(identity, text)
    else if (names.get(identity) !== text) names.set(identity, null)
  }
  const rows = (value: unknown) => Array.isArray(value) ? value.filter(record) : []
  for (const user of rows(data.users)) add(user.id, user.name, user.email)
  // Follow the section's selected dataset; never merge multiple snapshots or use appId.
  const groups = data.entra?.groups || data.exchange?.groups || data.groups
  for (const group of rows(groups)) add(group.objectId ?? group.id, group.displayName, group.name, group.mail)
  const apps = data.entra?.enterpriseApplications || data.entra?.servicePrincipals
    || data.enterpriseApplications || data.servicePrincipals
  for (const app of rows(apps)) add(app.objectId ?? app.id, app.displayName, app.name)
  return names
}
export function storedPrincipalName(names: ReadonlyMap<string, string | null>, id: unknown): string | null {
  return names.get(key(id)) ?? null
}
