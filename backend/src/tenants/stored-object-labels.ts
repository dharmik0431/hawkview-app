/** Presentation-only lookup over one authorized tenant bundle's existing reads. */
export type PrincipalKind = 'User' | 'Group' | 'ServicePrincipal' | 'Role'
export type DisplayTarget = { id: string; kind: PrincipalKind; name: string | null }
type Row = Record<string, any>
const key = (value: unknown) => typeof value === 'string' ? value.trim().toLowerCase() : ''
const guid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i
export function observedName(id: unknown, ...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value !== 'string') continue
    const name = value.trim()
    if (name && key(name) !== key(id) && !guid.test(name)) return name
  }
  return null
}
function nameIndex() {
  const names = new Map<string, string | null>()
  return {
    add(id: unknown, name: string | null) {
      const identity = key(id)
      if (!identity || !name) return
      if (!names.has(identity)) names.set(identity, name)
      else if (names.get(identity) !== name) names.set(identity, null)
    },
    get(id: unknown) { return names.get(key(id)) ?? null },
  }
}
const USER_SELECTIONS: Record<string, string> = {
  All: 'All users', None: 'No users', GuestsOrExternalUsers: 'Guests or external users',
}
const APP_SELECTIONS: Record<string, string> = {
  All: 'All cloud apps', Office365: 'Office 365', MicrosoftAdminPortals: 'Microsoft Admin Portals',
}
export function storedObjectLabels(input: {
  users: Row[]; groups: Row[]; servicePrincipals: Row[]; roleAssignments: Row[]
}) {
  const byKind = { User: nameIndex(), Group: nameIndex(), ServicePrincipal: nameIndex(), Role: nameIndex() }
  const principals = nameIndex(), userIdentities = nameIndex(), appIds = nameIndex()
  for (const user of input.users) {
    const name = observedName(user.microsoftUserId, user.displayName, user.userPrincipalName, user.mail)
    byKind.User.add(user.microsoftUserId, name)
    principals.add(user.microsoftUserId, name)
    for (const id of [user.microsoftUserId, user.userPrincipalName, user.mail]) userIdentities.add(id, name)
  }
  for (const group of input.groups) {
    const name = observedName(group.microsoftGroupId, group.displayName, group.mail)
    byKind.Group.add(group.microsoftGroupId, name)
    principals.add(group.microsoftGroupId, name)
  }
  for (const principal of input.servicePrincipals) {
    if (!principal || typeof principal !== 'object') continue
    const name = observedName(principal.id, principal.displayName)
    byKind.ServicePrincipal.add(principal.id, name)
    principals.add(principal.id, name)
    appIds.add(principal.appId, observedName(principal.appId, principal.displayName))
  }
  for (const assignment of input.roleAssignments) {
    const role = assignment?.roleDefinition
    byKind.Role.add(role?.templateId, observedName(role?.templateId, role?.displayName))
  }
  return {
    userIdentityName: (id: unknown) => userIdentities.get(id),
    assignmentName: (kind: PrincipalKind, id: unknown, reported: unknown) =>
      observedName(id, reported) ?? byKind[kind].get(id) ?? id,
    ownerName: (owner: Row) => observedName(owner?.id, owner?.displayName, owner?.userPrincipalName)
      ?? principals.get(owner?.id) ?? owner?.id,
    principalTarget: (kind: PrincipalKind, id: string): DisplayTarget => ({
      id, kind,
      name: (kind === 'User' && Object.hasOwn(USER_SELECTIONS, id) ? USER_SELECTIONS[id] : null)
        ?? byKind[kind].get(id),
    }),
    applicationTarget: (id: unknown) => typeof id !== 'string' ? String(id ?? '')
      : (Object.hasOwn(APP_SELECTIONS, id) ? APP_SELECTIONS[id] : null) ?? appIds.get(id) ?? id,
  }
}
export function principalTargetSummary(targets: DisplayTarget[]): string {
  const all = targets.find(target => target.kind === 'User' && target.id === 'All')
  if (all) return all.name ?? 'All users'
  if (targets.length === 1 && targets[0].kind === 'User' && targets[0].id === 'None') return 'No users'
  return `${targets.length} target${targets.length === 1 ? '' : 's'}`
}
