import { serviceAppearance } from '@/lib/ui/service-appearance'

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
    accentColor: serviceAppearance['Microsoft 365'].hue,
    ...serviceAppearance['Microsoft 365'].tenant,
  },
  entra: {
    key: 'entra',
    name: 'Entra ID',
    accentColor: serviceAppearance.Entra.hue,
    ...serviceAppearance.Entra.tenant,
  },
  exchange: {
    key: 'exchange',
    name: 'Exchange',
    accentColor: serviceAppearance.Exchange.hue,
    ...serviceAppearance.Exchange.tenant,
  },
  sharepoint: {
    key: 'sharepoint',
    name: 'SharePoint / OneDrive',
    accentColor: serviceAppearance.SharePoint.hue,
    ...serviceAppearance.SharePoint.tenant,
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
