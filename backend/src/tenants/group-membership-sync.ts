export interface GroupMembershipTarget {
  id: string
  displayName?: string | null
}

export interface GroupMembershipFailure {
  groupId: string
  groupName: string
  error: unknown
}

export interface GroupOwner {
  id?: string
  displayName?: string | null
  userPrincipalName?: string | null
}

export interface GroupPrincipalLabelSource {
  id?: string | null
  microsoftUserId?: string | null
  displayName?: string | null
  userPrincipalName?: string | null
}

export function uniquePrincipalLabels(
  principals: GroupPrincipalLabelSource[]
): string[] {
  const labels: string[] = []
  const seen = new Set<string>()

  for (const principal of principals) {
    const label =
      principal.displayName?.trim() ||
      principal.userPrincipalName?.trim() ||
      principal.microsoftUserId?.trim() ||
      principal.id?.trim()

    if (!label) continue

    const key = label.toLocaleLowerCase()
    if (seen.has(key)) continue

    seen.add(key)
    labels.push(label)
  }

  return labels
}

export async function collectGroupMemberships<
  T extends GroupMembershipTarget,
>(
  groups: T[],
  fetchMemberIds: (group: T) => Promise<string[]>,
  batchSize = 5
) {
  const memberIdsByGroupId = new Map<string, string[]>()
  const failures: GroupMembershipFailure[] = []
  const effectiveBatchSize = Math.max(1, Math.floor(batchSize))

  for (let index = 0; index < groups.length; index += effectiveBatchSize) {
    await Promise.all(
      groups.slice(index, index + effectiveBatchSize).map(async (group) => {
        try {
          const memberIds = await fetchMemberIds(group)
          memberIdsByGroupId.set(group.id, [...new Set(memberIds)])
        } catch (error) {
          failures.push({
            groupId: group.id,
            groupName: group.displayName?.trim() || group.id,
            error,
          })
        }
      })
    )
  }

  return { memberIdsByGroupId, failures }
}

export async function collectGroupOwners<T extends GroupMembershipTarget>(
  groups: T[],
  fetchOwners: (group: T) => Promise<GroupOwner[]>,
  batchSize = 5
) {
  const ownersByGroupId = new Map<string, GroupOwner[]>()
  const failures: GroupMembershipFailure[] = []
  const effectiveBatchSize = Math.max(1, Math.floor(batchSize))

  for (let index = 0; index < groups.length; index += effectiveBatchSize) {
    await Promise.all(
      groups.slice(index, index + effectiveBatchSize).map(async (group) => {
        try {
          ownersByGroupId.set(group.id, await fetchOwners(group))
        } catch (error) {
          failures.push({
            groupId: group.id,
            groupName: group.displayName?.trim() || group.id,
            error,
          })
        }
      })
    )
  }

  return { ownersByGroupId, failures }
}
