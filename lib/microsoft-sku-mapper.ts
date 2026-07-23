/**
 * Centralized SKU-name mapping utility for Microsoft 365 / Entra SKUs.
 * Maps raw skuPartNumbers to official Microsoft product names.
 */
export const MICROSOFT_SKU_MAP: Record<string, string> = {
  // Required mappings explicitly specified
  FLOW_FREE: 'Microsoft Power Automate Free',
  DEVELOPERPACK_E5: 'Microsoft 365 E5 Developer (without Windows and Audio Conferencing)',

  // Common Microsoft 365 / Office 365 SKUs
  ENTERPRISEPACK: 'Office 365 E3',
  ENTERPRISEPREMIUM: 'Office 365 E5',
  DESKLESSPACK: 'Office 365 F3',
  SPE_E3: 'Microsoft 365 E3',
  SPE_E5: 'Microsoft 365 E5',
  SPE_F1: 'Microsoft 365 F1',
  SPE_F3: 'Microsoft 365 F3',
  BUSINESS_PREMIUM: 'Microsoft 365 Business Premium',
  O365_BUSINESS_PREMIUM: 'Microsoft 365 Business Premium',
  O365_BUSINESS_ESSENTIALS: 'Microsoft 365 Business Basic',
  M365_BUSINESS_ESSENTIALS: 'Microsoft 365 Business Basic',
  M365_BUSINESS_PREMIUM: 'Microsoft 365 Business Premium',
  SMB_BUSINESS_PREMIUM: 'Microsoft 365 Business Premium',
  SMB_BUSINESS_ESSENTIALS: 'Microsoft 365 Business Basic',

  // Security, Identity & Compliance SKUs
  EMSPACK: 'Enterprise Mobility + Security E3',
  EMSPACK_E5: 'Enterprise Mobility + Security E5',
  AAD_PREMIUM: 'Microsoft Entra ID P1',
  AAD_PREMIUM_P2: 'Microsoft Entra ID P2',
  M365_E5_SECURITY: 'Microsoft 365 E5 Security',
  M365_E5_COMPLIANCE: 'Microsoft 365 E5 Compliance',

  // Voice & Power Platform / Add-ons
  POWER_BI_PRO: 'Power BI Pro',
  PBI_TASK_PER_USER: 'Power BI Premium Per User',
  TEAMS_PHONE_STANDARD: 'Microsoft Teams Phone Standard',
  MCOEV: 'Microsoft Teams Phone Standard',
  MCOPSTN1: 'Microsoft Teams Calling Plan',
  MCOPSTN2: 'Microsoft Teams International Calling Plan',
  VISIOCLIENT: 'Visio Plan 2',
  PROJECTCLIENT: 'Project Plan 3',
  EXCHANGESTANDARD: 'Exchange Online (Plan 1)',
  EXCHANGEENTERPRISE: 'Exchange Online (Plan 2)',
  TEAMS_EXPLORATORY: 'Microsoft Teams Exploratory',
  POWER_APPS_VIRAL: 'Microsoft Power Apps Plan',
}

/**
 * Returns a friendly official Microsoft product name for a given SKU part number.
 * Falls back to a clean Title Case string derived from the part number if unknown.
 * Never returns a blank name.
 */
export function getFriendlySkuName(
  skuPartNumber?: string | null,
  skuId?: string | null
): string {
  if (!skuPartNumber && !skuId) {
    return 'Microsoft License'
  }

  const rawKey = (skuPartNumber || skuId || '').trim()
  if (!rawKey) return 'Microsoft License'

  const uppercaseKey = rawKey.toUpperCase()
  if (MICROSOFT_SKU_MAP[uppercaseKey]) {
    return MICROSOFT_SKU_MAP[uppercaseKey]
  }

  // Readable fallback: convert underscores and hyphens to spaces and Title Case each word
  const words = rawKey
    .replace(/[_-]+/g, ' ')
    .split(' ')
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())

  const fallback = words.join(' ')
  return fallback || rawKey || 'Microsoft License'
}
