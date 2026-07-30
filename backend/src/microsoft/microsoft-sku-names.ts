/**
 * Friendly product names for Microsoft license SKU part numbers.
 *
 * Microsoft Graph returns identifiers such as DEVELOPERPACK_E5 in
 * subscribedSkus. Keep that identifier in PostgreSQL, but use Microsoft's
 * customer-facing product name in API responses.
 */
const MICROSOFT_SKU_NAMES: Record<string, string> = {
  DEVELOPERPACK_E5:
    'Microsoft 365 E5 Developer (without Windows and Audio Conferencing)',
  FLOW_FREE: 'Microsoft Power Automate Free',
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
  EMSPACK: 'Enterprise Mobility + Security E3',
  EMSPACK_E5: 'Enterprise Mobility + Security E5',
  AAD_PREMIUM: 'Microsoft Entra ID P1',
  AAD_PREMIUM_P2: 'Microsoft Entra ID P2',
  M365_E5_SECURITY: 'Microsoft 365 E5 Security',
  M365_E5_COMPLIANCE: 'Microsoft 365 E5 Compliance',
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

export function getMicrosoftSkuName(skuPartNumber: string): string {
  const normalizedSku = skuPartNumber.trim().toUpperCase()
  return MICROSOFT_SKU_NAMES[normalizedSku] ?? skuPartNumber
}
