import { DAILY_INVENTORY_REFRESH_MS, TWENTY_MINUTE_INVENTORY_REFRESH_MS } from './scheduled-sync-selection.js'

/** Freshness describes stored evidence; it never changes retry eligibility. */
export const LEGACY_SYNC_FRESHNESS_WINDOWS = {
  incremental: { currentMs: 15 * 60 * 1000, agingMs: 2 * 60 * 60 * 1000 },
  dailyInventory: { currentMs: DAILY_INVENTORY_REFRESH_MS, agingMs: DAILY_INVENTORY_REFRESH_MS + 2 * 60 * 60 * 1000 },
} as const

const fullTwentyMinuteWindow = {
  currentMs: TWENTY_MINUTE_INVENTORY_REFRESH_MS,
  // Retain the existing two-hour inventory grace after healthy eligibility.
  agingMs: TWENTY_MINUTE_INVENTORY_REFRESH_MS +
    LEGACY_SYNC_FRESHNESS_WINDOWS.dailyInventory.agingMs - LEGACY_SYNC_FRESHNESS_WINDOWS.dailyInventory.currentMs,
} as const
const incrementalResources = new Set(['USERS', 'SIGN_INS', 'AUDIT_LOGS', 'M365_AUDIT'])

export function syncFreshnessWindow(cadence: 'incremental' | 'daily') {
  if (cadence === 'incremental') return LEGACY_SYNC_FRESHNESS_WINDOWS.incremental
  // Use the scheduler's exact opt-in value. Absent or malformed values retain
  // the daily policy, and merely building the candidate cannot activate it.
  return process.env.HAWKVIEW_FULL_SYNC_20_MINUTES_ENABLED === 'true'
    ? fullTwentyMinuteWindow : LEGACY_SYNC_FRESHNESS_WINDOWS.dailyInventory
}

export function resourceFreshnessWindow(resourceType: string) {
  return syncFreshnessWindow(incrementalResources.has(resourceType) ? 'incremental' : 'daily')
}
