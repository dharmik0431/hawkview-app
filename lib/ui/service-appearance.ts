import { Layers3 } from 'lucide-react'
import { baselineServiceIcons } from './product-icons'

/** One service palette for Baseline and tenant views. Status colours stay separate. */
export const serviceAppearance = {
  Entra: {
    icon: baselineServiceIcons.Entra,
    hue: 'indigo',
    mark: 'bg-indigo-100 text-indigo-700 ring-indigo-200 dark:bg-indigo-950 dark:text-indigo-200 dark:ring-indigo-800',
    card: 'border-indigo-200 bg-indigo-50/60 dark:border-indigo-900 dark:bg-indigo-950/30',
    pill: 'bg-indigo-100 text-indigo-800 dark:bg-indigo-950 dark:text-indigo-200',
    accent: 'border-l-indigo-400',
    tenant: {
      bladeActiveBg: 'bg-indigo-50/90 dark:bg-indigo-950/50',
      bladeActiveText: 'text-indigo-700 dark:text-indigo-300 font-semibold',
      bladeActiveIcon: 'text-indigo-600 dark:text-indigo-400',
      bladeLeftRail: 'before:bg-indigo-600 dark:before:bg-indigo-400',
      headerIconBg:
        'bg-indigo-50 dark:bg-indigo-950/60 border-indigo-200 dark:border-indigo-900/60',
      headerIconText: 'text-indigo-600 dark:text-indigo-400',
      headerBorderAccent:
        'border-l-4 border-l-indigo-600 dark:border-l-indigo-400',
      tabActiveBorder: 'border-indigo-600 dark:border-indigo-400',
      tabActiveText: 'text-indigo-600 dark:text-indigo-400',
      tableHoverRail:
        'hover:border-l-2 hover:border-l-indigo-600 dark:hover:border-l-indigo-400',
      cardTopAccent: 'border-t-2 border-t-indigo-600 dark:border-t-indigo-400',
    },
  },
  SharePoint: {
    icon: baselineServiceIcons.SharePoint,
    hue: 'emerald',
    mark: 'bg-emerald-100 text-emerald-700 ring-emerald-200 dark:bg-emerald-950 dark:text-emerald-200 dark:ring-emerald-800',
    card: 'border-emerald-200 bg-emerald-50/60 dark:border-emerald-900 dark:bg-emerald-950/30',
    pill: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200',
    accent: 'border-l-emerald-400',
    tenant: {
      bladeActiveBg: 'bg-emerald-50/90 dark:bg-emerald-950/50',
      bladeActiveText: 'text-emerald-700 dark:text-emerald-300 font-semibold',
      bladeActiveIcon: 'text-emerald-600 dark:text-emerald-400',
      bladeLeftRail: 'before:bg-emerald-600 dark:before:bg-emerald-400',
      headerIconBg:
        'bg-emerald-50 dark:bg-emerald-950/60 border-emerald-200 dark:border-emerald-900/60',
      headerIconText: 'text-emerald-600 dark:text-emerald-400',
      headerBorderAccent:
        'border-l-4 border-l-emerald-600 dark:border-l-emerald-400',
      tabActiveBorder: 'border-emerald-600 dark:border-emerald-400',
      tabActiveText: 'text-emerald-600 dark:text-emerald-400',
      tableHoverRail:
        'hover:border-l-2 hover:border-l-emerald-600 dark:hover:border-l-emerald-400',
      cardTopAccent:
        'border-t-2 border-t-emerald-600 dark:border-t-emerald-400',
    },
  },
  OneDrive: {
    icon: baselineServiceIcons.OneDrive,
    hue: 'cyan',
    mark: 'bg-cyan-100 text-cyan-700 ring-cyan-200 dark:bg-cyan-950 dark:text-cyan-200 dark:ring-cyan-800',
    card: 'border-cyan-200 bg-cyan-50/60 dark:border-cyan-900 dark:bg-cyan-950/30',
    pill: 'bg-cyan-100 text-cyan-800 dark:bg-cyan-950 dark:text-cyan-200',
    accent: 'border-l-cyan-400',
  },
  Exchange: {
    icon: baselineServiceIcons.Exchange,
    hue: 'teal',
    mark: 'bg-teal-100 text-teal-700 ring-teal-200 dark:bg-teal-950 dark:text-teal-200 dark:ring-teal-800',
    card: 'border-teal-200 bg-teal-50/60 dark:border-teal-900 dark:bg-teal-950/30',
    pill: 'bg-teal-100 text-teal-800 dark:bg-teal-950 dark:text-teal-200',
    accent: 'border-l-teal-400',
    tenant: {
      bladeActiveBg: 'bg-teal-50/90 dark:bg-teal-950/50',
      bladeActiveText: 'text-teal-700 dark:text-teal-300 font-semibold',
      bladeActiveIcon: 'text-teal-600 dark:text-teal-400',
      bladeLeftRail: 'before:bg-teal-600 dark:before:bg-teal-400',
      headerIconBg:
        'bg-teal-50 dark:bg-teal-950/60 border-teal-200 dark:border-teal-900/60',
      headerIconText: 'text-teal-600 dark:text-teal-400',
      headerBorderAccent: 'border-l-4 border-l-teal-600 dark:border-l-teal-400',
      tabActiveBorder: 'border-teal-600 dark:border-teal-400',
      tabActiveText: 'text-teal-600 dark:text-teal-400',
      tableHoverRail:
        'hover:border-l-2 hover:border-l-teal-600 dark:hover:border-l-teal-400',
      cardTopAccent: 'border-t-2 border-t-teal-600 dark:border-t-teal-400',
    },
  },
  'Microsoft 365': {
    icon: baselineServiceIcons['Microsoft 365'],
    hue: 'sky',
    mark: 'bg-sky-100 text-sky-700 ring-sky-200 dark:bg-sky-950 dark:text-sky-200 dark:ring-sky-800',
    card: 'border-sky-200 bg-sky-50/60 dark:border-sky-900 dark:bg-sky-950/30',
    pill: 'bg-sky-100 text-sky-800 dark:bg-sky-950 dark:text-sky-200',
    accent: 'border-l-sky-400',
    tenant: {
      bladeActiveBg: 'bg-sky-50/90 dark:bg-sky-950/50',
      bladeActiveText: 'text-sky-700 dark:text-sky-300 font-semibold',
      bladeActiveIcon: 'text-sky-600 dark:text-sky-400',
      bladeLeftRail: 'before:bg-sky-600 dark:before:bg-sky-400',
      headerIconBg:
        'bg-sky-50 dark:bg-sky-950/60 border-sky-200 dark:border-sky-900/60',
      headerIconText: 'text-sky-600 dark:text-sky-400',
      headerBorderAccent: 'border-l-4 border-l-sky-600 dark:border-l-sky-400',
      tabActiveBorder: 'border-sky-600 dark:border-sky-400',
      tabActiveText: 'text-sky-600 dark:text-sky-400',
      tableHoverRail:
        'hover:border-l-2 hover:border-l-sky-600 dark:hover:border-l-sky-400',
      cardTopAccent: 'border-t-2 border-t-sky-600 dark:border-t-sky-400',
    },
  },
} as const

export const fallbackServiceAppearance = {
  icon: Layers3,
  hue: 'slate',
  mark: 'bg-slate-100 text-slate-700 ring-slate-200 dark:bg-slate-800 dark:text-slate-200 dark:ring-slate-700',
  card: 'border-slate-200 bg-slate-50/60 dark:border-slate-700 dark:bg-slate-800/30',
  pill: 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-200',
  accent: 'border-l-slate-400',
} as const

export function serviceStyleFor(name: string) {
  return (
    serviceAppearance[name as keyof typeof serviceAppearance] ??
    fallbackServiceAppearance
  )
}
