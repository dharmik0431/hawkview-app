export type ConditionalAccessDisplayTarget = {
  id: string; kind: 'User' | 'Group' | 'Role'; name: string | null
}
/** Additive display references must still match the original ordered selectors. */
export function ConditionalAccessTargets({ ids, targets }: {
  ids: string[]; targets?: ConditionalAccessDisplayTarget[]
}) {
  return <>{ids.map((id, index) => {
    const target = targets?.[index]
    const name = target?.id === id && typeof target.name === 'string' && target.name.trim()
      && target.name.trim().toLowerCase() !== id.trim().toLowerCase() ? target.name.trim() : null
    return <span key={`${index}:${id}`} className="inline-flex flex-col rounded-md bg-slate-100 px-2 py-1 text-xs text-slate-700 dark:bg-slate-800 dark:text-slate-200">
      <span>{name ?? id}</span>
      {name && <span className="font-mono text-[10px] text-slate-500 dark:text-slate-400">{id}</span>}
    </span>
  })}</>
}
