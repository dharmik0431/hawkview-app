import { DAILY_DUE_AFTER_MS, DAILY_OUTDATED_AFTER_MS } from './dataset-age'

// Explicit resource mapping from the repository's daily inventory collector.
// Unknown/composite resources never inherit a daily window by default.
const daily = new Set(['GROUPS', 'DEVICES', 'DIRECTORY_ROLES', 'AUTH_REGISTRATIONS', 'AUTH_METHOD_POLICIES', 'CONDITIONAL_ACCESS', 'AUTHENTICATION_STRENGTHS', 'NAMED_LOCATIONS', 'APPLICATIONS', 'SERVICE_PRINCIPALS', 'SECURITY_DEFAULTS', 'SECURE_SCORES', 'RISKY_USERS', 'ORGANIZATION_CONFIGURATION', 'DOMAINS', 'LICENSES', 'DOMAIN_DNS_HEALTH', 'SHAREPOINT_SITES', 'SHAREPOINT_SETTINGS', 'SHAREPOINT_USAGE', 'EXCHANGE_MAILBOXES', 'EXCHANGE_MAILBOX_SETTINGS', 'EXCHANGE_MAILBOX_USAGE', 'EXCHANGE_ACCEPTED_DOMAINS', 'EXCHANGE_MAILBOX_RULES', 'EXCHANGE_MAILBOX_CONFIGURATION'])
export function datasetCadence(resources: string[]) {
  if (resources.length && resources.every(resource => daily.has(resource))) return {
    label: 'Expected daily (24 hours).',
    dueAfterMs: DAILY_DUE_AFTER_MS, outdatedAfterMs: DAILY_OUTDATED_AFTER_MS,
  }
  if (resources.length === 1 && resources[0] === 'USERS') return {
    label: 'Expected every 5 minutes.',
    dueAfterMs: 5 * 60 * 1000, outdatedAfterMs: 2 * 60 * 60 * 1000,
  }
  return { label: 'Collection interval not reported for this source.', outdatedAfterMs: null }
}
