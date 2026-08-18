import * as React from 'react'
import {
  LogIn,
  User,
  Users,
  AppWindow,
  Building2,
  Globe,
  Shield,
  Key,
  Mail,
  Folder,
  Monitor,
  UserCheck,
  Activity,
  type LucideIcon,
} from 'lucide-react'
import type { ChangeEvent } from './change-types'

export type EventCategoryKey =
  | 'app-registration'
  | 'enterprise-app'
  | 'user'
  | 'group'
  | 'dns-domain'
  | 'security-policy'
  | 'license'
  | 'sign-in'
  | 'exchange'
  | 'sharepoint'
  | 'device'
  | 'admin-role'
  | 'general-audit'

export type CategoryConfig = {
  key: EventCategoryKey
  label: string
  Icon: LucideIcon
  // Container & Icon styling (restrained 32-36px tinted container)
  containerBgClass: string
  iconTextClass: string
  containerBorderClass: string

  // Timeline marker dot styling
  dotClass: string
  dotRingClass: string

  // Accent styling
  badgeBgClass: string
}

export type EventResultStatus = 'success' | 'failure' | 'unknown'

export type EventClassification = {
  category: CategoryConfig
  result: EventResultStatus
  resultText: string
  isHighRisk: boolean
  accessibleLabel: string
}

export const CATEGORY_CONFIGS: Record<EventCategoryKey, CategoryConfig> = {
  'sign-in': {
    key: 'sign-in',
    label: 'Sign-in',
    Icon: LogIn,
    containerBgClass: 'bg-teal-500/10 dark:bg-teal-500/20',
    iconTextClass: 'text-teal-700 dark:text-teal-300',
    containerBorderClass: 'border-teal-500/30 dark:border-teal-500/40',
    dotClass: 'bg-teal-500',
    dotRingClass: 'ring-teal-500/20',
    badgeBgClass: 'bg-teal-500/10 text-teal-800 dark:text-teal-300 border-teal-500/30',
  },
  'user': {
    key: 'user',
    label: 'User account',
    Icon: User,
    containerBgClass: 'bg-blue-500/10 dark:bg-blue-500/20',
    iconTextClass: 'text-blue-700 dark:text-blue-300',
    containerBorderClass: 'border-blue-500/30 dark:border-blue-500/40',
    dotClass: 'bg-blue-500',
    dotRingClass: 'ring-blue-500/20',
    badgeBgClass: 'bg-blue-500/10 text-blue-800 dark:text-blue-300 border-blue-500/30',
  },
  'group': {
    key: 'group',
    label: 'Group',
    Icon: Users,
    containerBgClass: 'bg-violet-500/10 dark:bg-violet-500/20',
    iconTextClass: 'text-violet-700 dark:text-violet-300',
    containerBorderClass: 'border-violet-500/30 dark:border-violet-500/40',
    dotClass: 'bg-violet-500',
    dotRingClass: 'ring-violet-500/20',
    badgeBgClass: 'bg-violet-500/10 text-violet-800 dark:text-violet-300 border-violet-500/30',
  },
  'app-registration': {
    key: 'app-registration',
    label: 'App registration',
    Icon: AppWindow,
    containerBgClass: 'bg-indigo-500/10 dark:bg-indigo-500/20',
    iconTextClass: 'text-indigo-700 dark:text-indigo-300',
    containerBorderClass: 'border-indigo-500/30 dark:border-indigo-500/40',
    dotClass: 'bg-indigo-500',
    dotRingClass: 'ring-indigo-500/20',
    badgeBgClass: 'bg-indigo-500/10 text-indigo-800 dark:text-indigo-300 border-indigo-500/30',
  },
  'enterprise-app': {
    key: 'enterprise-app',
    label: 'Enterprise application',
    Icon: Building2,
    containerBgClass: 'bg-indigo-500/10 dark:bg-indigo-500/20',
    iconTextClass: 'text-indigo-700 dark:text-indigo-300',
    containerBorderClass: 'border-indigo-500/30 dark:border-indigo-500/40',
    dotClass: 'bg-indigo-500',
    dotRingClass: 'ring-indigo-500/20',
    badgeBgClass: 'bg-indigo-500/10 text-indigo-800 dark:text-indigo-300 border-indigo-500/30',
  },
  'dns-domain': {
    key: 'dns-domain',
    label: 'DNS / Domain',
    Icon: Globe,
    containerBgClass: 'bg-cyan-500/10 dark:bg-cyan-500/20',
    iconTextClass: 'text-cyan-700 dark:text-cyan-300',
    containerBorderClass: 'border-cyan-500/30 dark:border-cyan-500/40',
    dotClass: 'bg-cyan-500',
    dotRingClass: 'ring-cyan-500/20',
    badgeBgClass: 'bg-cyan-500/10 text-cyan-800 dark:text-cyan-300 border-cyan-500/30',
  },
  'security-policy': {
    key: 'security-policy',
    label: 'Conditional Access',
    Icon: Shield,
    containerBgClass: 'bg-amber-500/10 dark:bg-amber-500/20',
    iconTextClass: 'text-amber-800 dark:text-amber-300',
    containerBorderClass: 'border-amber-500/30 dark:border-amber-500/40',
    dotClass: 'bg-amber-500',
    dotRingClass: 'ring-amber-500/20',
    badgeBgClass: 'bg-amber-500/10 text-amber-900 dark:text-amber-200 border-amber-500/30',
  },
  'license': {
    key: 'license',
    label: 'License',
    Icon: Key,
    containerBgClass: 'bg-purple-500/10 dark:bg-purple-500/20',
    iconTextClass: 'text-purple-700 dark:text-purple-300',
    containerBorderClass: 'border-purple-500/30 dark:border-purple-500/40',
    dotClass: 'bg-purple-500',
    dotRingClass: 'ring-purple-500/20',
    badgeBgClass: 'bg-purple-500/10 text-purple-800 dark:text-purple-300 border-purple-500/30',
  },
  'exchange': {
    key: 'exchange',
    label: 'Exchange / Mail',
    Icon: Mail,
    containerBgClass: 'bg-sky-500/10 dark:bg-sky-500/20',
    iconTextClass: 'text-sky-700 dark:text-sky-300',
    containerBorderClass: 'border-sky-500/30 dark:border-sky-500/40',
    dotClass: 'bg-sky-500',
    dotRingClass: 'ring-sky-500/20',
    badgeBgClass: 'bg-sky-500/10 text-sky-800 dark:text-sky-300 border-sky-500/30',
  },
  'sharepoint': {
    key: 'sharepoint',
    label: 'SharePoint / OneDrive',
    Icon: Folder,
    containerBgClass: 'bg-emerald-500/10 dark:bg-emerald-500/20',
    iconTextClass: 'text-emerald-700 dark:text-emerald-300',
    containerBorderClass: 'border-emerald-500/30 dark:border-emerald-500/40',
    dotClass: 'bg-emerald-500',
    dotRingClass: 'ring-emerald-500/20',
    badgeBgClass: 'bg-emerald-500/10 text-emerald-800 dark:text-emerald-300 border-emerald-500/30',
  },
  'device': {
    key: 'device',
    label: 'Device',
    Icon: Monitor,
    containerBgClass: 'bg-slate-500/10 dark:bg-slate-500/20',
    iconTextClass: 'text-slate-700 dark:text-slate-300',
    containerBorderClass: 'border-slate-500/30 dark:border-slate-500/40',
    dotClass: 'bg-slate-500',
    dotRingClass: 'ring-slate-500/20',
    badgeBgClass: 'bg-slate-500/10 text-slate-800 dark:text-slate-300 border-slate-500/30',
  },
  'admin-role': {
    key: 'admin-role',
    label: 'Administrative role',
    Icon: UserCheck,
    containerBgClass: 'bg-violet-500/10 dark:bg-violet-500/20',
    iconTextClass: 'text-violet-800 dark:text-violet-300',
    containerBorderClass: 'border-violet-500/30 dark:border-violet-500/40',
    dotClass: 'bg-violet-500',
    dotRingClass: 'ring-violet-500/20',
    badgeBgClass: 'bg-violet-500/10 text-violet-900 dark:text-violet-200 border-violet-500/30',
  },
  'general-audit': {
    key: 'general-audit',
    label: 'General audit event',
    Icon: Activity,
    containerBgClass: 'bg-slate-500/10 dark:bg-slate-500/20',
    iconTextClass: 'text-slate-700 dark:text-slate-300',
    containerBorderClass: 'border-slate-500/30 dark:border-slate-500/40',
    dotClass: 'bg-slate-500',
    dotRingClass: 'ring-slate-500/20',
    badgeBgClass: 'bg-slate-500/10 text-slate-800 dark:text-slate-300 border-slate-500/30',
  },
}

function determineCategoryKey(e: ChangeEvent): EventCategoryKey {
  // 1. Explicit Sign-in event type or category
  if (e.eventType === 'sign-in' || e.category === 'Sign-ins') {
    return 'sign-in'
  }

  // 2. Structured API category match
  if (e.category === 'Conditional Access' || e.category === 'MFA') {
    return 'security-policy'
  }
  if (e.category === 'Licenses') {
    return 'license'
  }
  if (e.category === 'Domains') {
    return 'dns-domain'
  }
  if (e.category === 'Exchange') {
    return 'exchange'
  }
  if (e.category === 'SharePoint') {
    return 'sharepoint'
  }
  if (e.category === 'Users' || e.category === 'Passwords') {
    return 'user'
  }
  if (e.category === 'Groups') {
    return 'group'
  }
  if (e.category === 'Devices') {
    return 'device'
  }
  if (e.category === 'Roles') {
    return 'admin-role'
  }

  // 3. Structured evidence target types
  const targetTypes = (e.evidence?.targets ?? []).map((t) => (t.targetType ?? '').toLowerCase())
  if (targetTypes.includes('serviceprincipal')) {
    return 'enterprise-app'
  }

  // 4. Activity name, target name, summary & service string matching
  const title = (e.title ?? '').toLowerCase()
  const summary = (e.summary ?? '').toLowerCase()
  const target = (e.target ?? '').toLowerCase()
  const source = (e.source ?? '').toLowerCase()
  const loggedService = (e.evidence?.loggedByService ?? '').toLowerCase()
  const text = `${title} ${summary} ${target} ${source} ${loggedService}`

  // DNS / Domain
  if (/dns|dmarc|spf|dkim|cname|mx record|txt record|domain|custom domain/i.test(text)) {
    return 'dns-domain'
  }

  // App registration
  if (
    /app registration|credential added|client secret|certificate|key credential|register app|add application|application updated/i.test(
      text
    ) ||
    (e.category === 'Apps' && /registration|credential|secret|certificate/i.test(text))
  ) {
    return 'app-registration'
  }

  // Enterprise application / Service principal
  if (
    /service principal|serviceprincipal|enterprise app|enterprise application|permission grant|consent to application|approle/i.test(
      text
    ) ||
    (e.category === 'Apps' && /service principal|enterprise|permission|grant|consent/i.test(text))
  ) {
    return 'enterprise-app'
  }

  // Generic Apps fallback
  if (e.category === 'Apps') {
    if (/registration|credential|secret|certificate/i.test(text)) {
      return 'app-registration'
    }
    return 'enterprise-app'
  }

  // Exchange / Mail
  if (/exchange|mailbox|mail flow|transport rule|anti-spam|anti-phishing|inbox rule|outlook/i.test(text)) {
    return 'exchange'
  }

  // SharePoint / OneDrive
  if (/sharepoint|onedrive|site collection|document library|sharing policy/i.test(text)) {
    return 'sharepoint'
  }

  // Conditional Access / Security policy
  if (/conditional access|security policy|authentication method|named location|risk policy|identity protection|security baseline|password policy/i.test(text)) {
    return 'security-policy'
  }

  // Administrative role
  if (/admin role|directory role|global administrator|privileged|pim|role assignment/i.test(text)) {
    return 'admin-role'
  }

  // Group
  if (/group|group membership|added to group|removed from group/i.test(text)) {
    return 'group'
  }

  // User
  if (/user|user account|account disabled|user created|password reset|mfa registered/i.test(text)) {
    return 'user'
  }

  // License
  if (/license|sku|subscription/i.test(text)) {
    return 'license'
  }

  // Device
  if (/device|intune|mdm|compliant device/i.test(text)) {
    return 'device'
  }

  // Fallback to General audit event
  return 'general-audit'
}

function determineResultStatus(e: ChangeEvent): EventResultStatus {
  const resultVal = (e.evidence?.result ?? '').toLowerCase()
  const title = (e.title ?? '').toLowerCase()
  const summary = (e.summary ?? '').toLowerCase()
  const text = `${title} ${summary} ${resultVal}`

  if (
    resultVal.includes('fail') ||
    resultVal.includes('interrupted') ||
    resultVal.includes('blocked') ||
    text.includes('failed') ||
    text.includes('failure') ||
    text.includes('blocked') ||
    text.includes('denied')
  ) {
    return 'failure'
  }

  if (
    resultVal.includes('success') ||
    e.evidence?.result === 'success' ||
    e.evidence?.result === 'Success'
  ) {
    return 'success'
  }

  if (e.evidence?.result) {
    return 'success'
  }

  if (e.eventType === 'sign-in') {
    return 'success'
  }

  // Default for standard executed changes
  return 'success'
}

function formatResultText(status: EventResultStatus, e: ChangeEvent): string {
  if (status === 'failure') return 'Failed'
  if (status === 'success') return 'Success'
  return 'Unknown'
}

export function classifyEvent(e: ChangeEvent): EventClassification {
  const catKey = determineCategoryKey(e)
  const categoryConfig = CATEGORY_CONFIGS[catKey]

  const resultStatus = determineResultStatus(e)
  const resultText = formatResultText(resultStatus, e)
  const isHighRisk = e.severity === 'High'

  const accessibleLabel = `${categoryConfig.label} event, ${resultText.toLowerCase()}${
    isHighRisk ? ', high risk' : ''
  }`

  return {
    category: categoryConfig,
    result: resultStatus,
    resultText,
    isHighRisk,
    accessibleLabel,
  }
}
