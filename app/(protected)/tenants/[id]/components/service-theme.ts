export type ServiceKey =
  | 'overview'
  | 'home'
  | 'entra'
  | 'exchange'
  | 'sharepoint'
  | 'teams'
  | 'settings'
  | string

export interface ServiceTheme {
  key: ServiceKey
  name: string
  accentColor: string
  // Navigation blade styles
  bladeActiveBg: string
  bladeActiveText: string
  bladeActiveIcon: string
  bladeLeftRail: string
  // Module header icon container
  headerIconBg: string
  headerIconText: string
  headerBorderAccent: string
  // Tabs & secondary nav
  tabActiveBorder: string
  tabActiveText: string
  // Table row hover rail
  tableHoverRail: string
  // Card top accent
  cardTopAccent: string
}

export const SERVICE_THEMES: Record<string, ServiceTheme> = {
  overview: {
    key: 'overview',
    name: 'Tenant Overview',
    accentColor: 'blue',
    bladeActiveBg: 'bg-blue-50/90 dark:bg-blue-950/50',
    bladeActiveText: 'text-blue-700 dark:text-blue-300 font-semibold',
    bladeActiveIcon: 'text-blue-600 dark:text-blue-400',
    bladeLeftRail: 'before:bg-blue-600 dark:before:bg-blue-400',
    headerIconBg: 'bg-blue-50 dark:bg-blue-950/60 border-blue-200 dark:border-blue-900/60',
    headerIconText: 'text-blue-600 dark:text-blue-400',
    headerBorderAccent: 'border-l-4 border-l-blue-600 dark:border-l-blue-400',
    tabActiveBorder: 'border-blue-600 dark:border-blue-400',
    tabActiveText: 'text-blue-600 dark:text-blue-400',
    tableHoverRail: 'hover:border-l-2 hover:border-l-blue-600 dark:hover:border-l-blue-400',
    cardTopAccent: 'border-t-2 border-t-blue-600 dark:border-t-blue-400',
  },
  home: {
    key: 'home',
    name: 'Office 365',
    accentColor: 'sky',
    bladeActiveBg: 'bg-sky-50/90 dark:bg-sky-950/50',
    bladeActiveText: 'text-sky-700 dark:text-sky-300 font-semibold',
    bladeActiveIcon: 'text-sky-600 dark:text-sky-400',
    bladeLeftRail: 'before:bg-sky-600 dark:before:bg-sky-400',
    headerIconBg: 'bg-sky-50 dark:bg-sky-950/60 border-sky-200 dark:border-sky-900/60',
    headerIconText: 'text-sky-600 dark:text-sky-400',
    headerBorderAccent: 'border-l-4 border-l-sky-600 dark:border-l-sky-400',
    tabActiveBorder: 'border-sky-600 dark:border-sky-400',
    tabActiveText: 'text-sky-600 dark:text-sky-400',
    tableHoverRail: 'hover:border-l-2 hover:border-l-sky-600 dark:hover:border-l-sky-400',
    cardTopAccent: 'border-t-2 border-t-sky-600 dark:border-t-sky-400',
  },
  entra: {
    key: 'entra',
    name: 'Entra ID',
    accentColor: 'indigo',
    bladeActiveBg: 'bg-indigo-50/90 dark:bg-indigo-950/50',
    bladeActiveText: 'text-indigo-700 dark:text-indigo-300 font-semibold',
    bladeActiveIcon: 'text-indigo-600 dark:text-indigo-400',
    bladeLeftRail: 'before:bg-indigo-600 dark:before:bg-indigo-400',
    headerIconBg: 'bg-indigo-50 dark:bg-indigo-950/60 border-indigo-200 dark:border-indigo-900/60',
    headerIconText: 'text-indigo-600 dark:text-indigo-400',
    headerBorderAccent: 'border-l-4 border-l-indigo-600 dark:border-l-indigo-400',
    tabActiveBorder: 'border-indigo-600 dark:border-indigo-400',
    tabActiveText: 'text-indigo-600 dark:text-indigo-400',
    tableHoverRail: 'hover:border-l-2 hover:border-l-indigo-600 dark:hover:border-l-indigo-400',
    cardTopAccent: 'border-t-2 border-t-indigo-600 dark:border-t-indigo-400',
  },
  exchange: {
    key: 'exchange',
    name: 'Exchange',
    accentColor: 'teal',
    bladeActiveBg: 'bg-teal-50/90 dark:bg-teal-950/50',
    bladeActiveText: 'text-teal-700 dark:text-teal-300 font-semibold',
    bladeActiveIcon: 'text-teal-600 dark:text-teal-400',
    bladeLeftRail: 'before:bg-teal-600 dark:before:bg-teal-400',
    headerIconBg: 'bg-teal-50 dark:bg-teal-950/60 border-teal-200 dark:border-teal-900/60',
    headerIconText: 'text-teal-600 dark:text-teal-400',
    headerBorderAccent: 'border-l-4 border-l-teal-600 dark:border-l-teal-400',
    tabActiveBorder: 'border-teal-600 dark:border-teal-400',
    tabActiveText: 'text-teal-600 dark:text-teal-400',
    tableHoverRail: 'hover:border-l-2 hover:border-l-teal-600 dark:hover:border-l-teal-400',
    cardTopAccent: 'border-t-2 border-t-teal-600 dark:border-t-teal-400',
  },
  sharepoint: {
    key: 'sharepoint',
    name: 'SharePoint / OneDrive',
    accentColor: 'emerald',
    bladeActiveBg: 'bg-emerald-50/90 dark:bg-emerald-950/50',
    bladeActiveText: 'text-emerald-700 dark:text-emerald-300 font-semibold',
    bladeActiveIcon: 'text-emerald-600 dark:text-emerald-400',
    bladeLeftRail: 'before:bg-emerald-600 dark:before:bg-emerald-400',
    headerIconBg: 'bg-emerald-50 dark:bg-emerald-950/60 border-emerald-200 dark:border-emerald-900/60',
    headerIconText: 'text-emerald-600 dark:text-emerald-400',
    headerBorderAccent: 'border-l-4 border-l-emerald-600 dark:border-l-emerald-400',
    tabActiveBorder: 'border-emerald-600 dark:border-emerald-400',
    tabActiveText: 'text-emerald-600 dark:text-emerald-400',
    tableHoverRail: 'hover:border-l-2 hover:border-l-emerald-600 dark:hover:border-l-emerald-400',
    cardTopAccent: 'border-t-2 border-t-emerald-600 dark:border-t-emerald-400',
  },
  teams: {
    key: 'teams',
    name: 'Teams',
    accentColor: 'violet',
    bladeActiveBg: 'bg-violet-50/90 dark:bg-violet-950/50',
    bladeActiveText: 'text-violet-700 dark:text-violet-300 font-semibold',
    bladeActiveIcon: 'text-violet-600 dark:text-violet-400',
    bladeLeftRail: 'before:bg-violet-600 dark:before:bg-violet-400',
    headerIconBg: 'bg-violet-50 dark:bg-violet-950/60 border-violet-200 dark:border-violet-900/60',
    headerIconText: 'text-violet-600 dark:text-violet-400',
    headerBorderAccent: 'border-l-4 border-l-violet-600 dark:border-l-violet-400',
    tabActiveBorder: 'border-violet-600 dark:border-violet-400',
    tabActiveText: 'text-violet-600 dark:text-violet-400',
    tableHoverRail: 'hover:border-l-2 hover:border-l-violet-600 dark:hover:border-l-violet-400',
    cardTopAccent: 'border-t-2 border-t-violet-600 dark:border-t-violet-400',
  },
  'license-activity': {
    key: 'license-activity',
    name: 'License Activity',
    accentColor: 'amber',
    bladeActiveBg: 'bg-amber-50/90 dark:bg-amber-950/50',
    bladeActiveText: 'text-amber-700 dark:text-amber-300 font-semibold',
    bladeActiveIcon: 'text-amber-600 dark:text-amber-400',
    bladeLeftRail: 'before:bg-amber-600 dark:before:bg-amber-400',
    headerIconBg: 'bg-amber-50 dark:bg-amber-950/60 border-amber-200 dark:border-amber-900/60',
    headerIconText: 'text-amber-600 dark:text-amber-400',
    headerBorderAccent: 'border-l-4 border-l-amber-600 dark:border-l-amber-400',
    tabActiveBorder: 'border-amber-600 dark:border-amber-400',
    tabActiveText: 'text-amber-600 dark:text-amber-400',
    tableHoverRail: 'hover:border-l-2 hover:border-l-amber-600 dark:hover:border-l-amber-400',
    cardTopAccent: 'border-t-2 border-t-amber-600 dark:border-t-amber-400',
  },
  settings: {
    key: 'settings',
    name: 'Tenant Settings',
    accentColor: 'slate',
    bladeActiveBg: 'bg-slate-100 dark:bg-slate-800',
    bladeActiveText: 'text-slate-900 dark:text-white font-semibold',
    bladeActiveIcon: 'text-slate-700 dark:text-slate-300',
    bladeLeftRail: 'before:bg-slate-600 dark:before:bg-slate-400',
    headerIconBg: 'bg-slate-100 dark:bg-slate-800 border-slate-300 dark:border-slate-700',
    headerIconText: 'text-slate-700 dark:text-slate-300',
    headerBorderAccent: 'border-l-4 border-l-slate-600 dark:border-l-slate-400',
    tabActiveBorder: 'border-slate-600 dark:border-slate-400',
    tabActiveText: 'text-slate-800 dark:text-slate-200',
    tableHoverRail: 'hover:border-l-2 hover:border-l-slate-600 dark:hover:border-l-slate-400',
    cardTopAccent: 'border-t-2 border-t-slate-600 dark:border-t-slate-400',
  },
}

export function getServiceTheme(key: string): ServiceTheme {
  return SERVICE_THEMES[key] || SERVICE_THEMES.overview
}
