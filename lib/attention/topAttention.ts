import type { AttentionItem } from '@/types/attention'

export function topAttention(items: AttentionItem[]) {
  const order = { critical: 0, high: 1, medium: 2 } as const

  return [...items]
    .sort((a, b) => order[a.severity] - order[b.severity])
    .slice(0, 2)
}
