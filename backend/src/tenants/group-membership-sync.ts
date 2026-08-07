export interface GroupMembershipTarget {
  id: string
  displayName?: string | null
}

export interface GroupMembershipFailure {
  groupId: string
  groupName: string
  error: unknown
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
