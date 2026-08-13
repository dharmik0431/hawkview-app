/**
 * Admin panel paths shared by server-side route validation and the client UI.
 * Keep this module free of React/client imports so dynamic admin routes can
 * validate a path before rendering the client component.
 */
export const adminTabs = [
  'overview',
  'users',
  'workspace',
  'security',
  'notifications',
  'audit',
] as const

export type AdminTab = (typeof adminTabs)[number]

export function isAdminTab(value: string): value is AdminTab {
  return adminTabs.includes(value as AdminTab)
}
