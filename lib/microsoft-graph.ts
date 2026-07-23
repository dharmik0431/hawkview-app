import { ClientSecretCredential } from '@azure/identity'
import { Client } from '@microsoft/microsoft-graph-client'

export interface MicrosoftConfig {
  tenantId: string
  clientId: string
  clientSecret: string
}

export function getMicrosoftCredentials(): MicrosoftConfig {
  const tenantId = process.env.MICROSOFT_TENANT_ID
  const clientId = process.env.MICROSOFT_CLIENT_ID
  const clientSecret = process.env.MICROSOFT_CLIENT_SECRET

  if (!tenantId || !clientId || !clientSecret) {
    const missing: string[] = []
    if (!tenantId) missing.push('MICROSOFT_TENANT_ID')
    if (!clientId) missing.push('MICROSOFT_CLIENT_ID')
    if (!clientSecret) missing.push('MICROSOFT_CLIENT_SECRET')
    throw new Error(`Missing required Microsoft credentials: ${missing.join(', ')}`)
  }

  return { tenantId, clientId, clientSecret }
}

function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string
): Promise<T> {
  let timeoutId: NodeJS.Timeout
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(new Error(`[Microsoft Graph] ${label} timed out after ${timeoutMs}ms.`))
    }, timeoutMs)
  })

  return Promise.race([promise, timeoutPromise]).finally(() => {
    clearTimeout(timeoutId!)
  })
}

export async function getGraphClient(): Promise<Client> {
  const { tenantId, clientId, clientSecret } = getMicrosoftCredentials()

  const credential = new ClientSecretCredential(tenantId, clientId, clientSecret)

  const tokenStart = performance.now()
  const tokenResponse = await withTimeout(
    credential.getToken('https://graph.microsoft.com/.default'),
    8000,
    'Token acquisition'
  )

  const tokenDuration = Math.round(performance.now() - tokenStart)
  if (process.env.NODE_ENV !== 'production') {
    console.log(`[Microsoft Graph] Token acquisition took ${tokenDuration}ms`)
  }

  if (!tokenResponse || !tokenResponse.token) {
    throw new Error('Failed to acquire Microsoft Graph access token.')
  }

  return Client.init({
    authProvider: (done) => {
      done(null, tokenResponse.token)
    },
  })
}

export interface MicrosoftConnectionResult {
  connected: boolean
  tenantId: string | null
  displayName: string | null
  verifiedDomains: Array<{
    name: string
    isDefault?: boolean
    isInitial?: boolean
    type?: string
    capabilities?: string
  }> | null
  error?: string
}

export async function checkMicrosoftConnection(): Promise<MicrosoftConnectionResult> {
  try {
    const { tenantId } = getMicrosoftCredentials()
    const client = await getGraphClient()

    const response = await client
      .api('/organization')
      .select('id,displayName,verifiedDomains')
      .get()

    const org = response?.value?.[0]
    if (!org) {
      return {
        connected: false,
        tenantId: null,
        displayName: null,
        verifiedDomains: null,
        error: 'No organization details returned from Microsoft Graph.',
      }
    }

    return {
      connected: true,
      tenantId: org.id || tenantId,
      displayName: org.displayName || null,
      verifiedDomains: Array.isArray(org.verifiedDomains)
        ? org.verifiedDomains.map((d: any) => ({
            name: d.name,
            isDefault: d.isDefault,
            isInitial: d.isInitial,
            type: d.type,
            capabilities: d.capabilities,
          }))
        : [],
    }
  } catch (error: any) {
    let safeMessage = 'An error occurred while connecting to Microsoft Graph.'

    if (error?.message) {
      const msg: string = error.message
      if (msg.includes('Missing required Microsoft credentials')) {
        safeMessage = msg
      } else if (
        msg.includes('AADSTS700016') ||
        msg.includes('not found in the directory')
      ) {
        safeMessage = 'Application (Client) ID not found in directory.'
      } else if (
        msg.includes('AADSTS7000215') ||
        msg.includes('Invalid client secret')
      ) {
        safeMessage = 'Invalid client secret provided.'
      } else if (
        msg.includes('AADSTS50011') ||
        msg.includes('reply URL')
      ) {
        safeMessage = 'Redirect URL / Reply address mismatch.'
      } else if (
        msg.includes('Authorization_RequestDenied') ||
        msg.includes('Insufficient privileges')
      ) {
        safeMessage =
          'Insufficient privileges or missing admin consent for Organization.Read.All permission in Microsoft Graph.'
      } else if (
        msg.includes('ENOTFOUND') ||
        msg.includes('ETIMEDOUT') ||
        msg.includes('fetch failed')
      ) {
        safeMessage =
          'Network error attempting to reach Microsoft identity/Graph endpoint.'
      } else {
        safeMessage = msg
          .replace(/Bearer\s+[A-Za-z0-9\-._~+/]+=*/gi, 'Bearer [REDACTED]')
          .replace(/client_secret=[^&]+/gi, 'client_secret=[REDACTED]')
      }
    }

    return {
      connected: false,
      tenantId: null,
      displayName: null,
      verifiedDomains: null,
      error: safeMessage,
    }
  }
}

export function sanitizeGraphError(error: any): string {
  if (!error) return 'Unknown error occurred.'
  const msg: string = error?.message || String(error)

  if (msg.includes('Missing required Microsoft credentials')) {
    return msg
  } else if (
    msg.includes('AADSTS700016') ||
    msg.includes('not found in the directory')
  ) {
    return 'Application (Client) ID not found in directory.'
  } else if (
    msg.includes('AADSTS7000215') ||
    msg.includes('Invalid client secret')
  ) {
    return 'Invalid client secret provided.'
  } else if (
    msg.includes('Authorization_RequestDenied') ||
    msg.includes('Insufficient privileges') ||
    msg.includes('403') ||
    msg.includes('Forbidden')
  ) {
    return 'Insufficient privileges or missing admin consent for required permission in Microsoft Graph.'
  } else if (
    msg.includes('ENOTFOUND') ||
    msg.includes('ETIMEDOUT') ||
    msg.includes('fetch failed')
  ) {
    return 'Network error attempting to reach Microsoft identity/Graph endpoint.'
  }

  return msg
    .replace(/Bearer\s+[A-Za-z0-9\-._~+/]+=*/gi, 'Bearer [REDACTED]')
    .replace(/client_secret=[^&]+/gi, 'client_secret=[REDACTED]')
    .replace(/access_token=[^&]+/gi, 'access_token=[REDACTED]')
}

export interface ReadinessCheckResult {
  ok: boolean
  error?: string
}

export interface MicrosoftReadinessResults {
  overallStatus: 'ready' | 'partial' | 'failed'
  checks: {
    organization: ReadinessCheckResult
    users: ReadinessCheckResult
    licenses: ReadinessCheckResult
    signIns: ReadinessCheckResult
    secureScore: ReadinessCheckResult
  }
}

export async function checkMicrosoftReadiness(): Promise<MicrosoftReadinessResults> {
  const checks: MicrosoftReadinessResults['checks'] = {
    organization: { ok: false },
    users: { ok: false },
    licenses: { ok: false },
    signIns: { ok: false },
    secureScore: { ok: false },
  }

  let client: Client
  try {
    client = await getGraphClient()
  } catch (err: any) {
    const errMessage = sanitizeGraphError(err)
    checks.organization = { ok: false, error: errMessage }
    checks.users = { ok: false, error: errMessage }
    checks.licenses = { ok: false, error: errMessage }
    checks.signIns = { ok: false, error: errMessage }
    checks.secureScore = { ok: false, error: errMessage }

    return {
      overallStatus: 'failed',
      checks,
    }
  }

  // 1. Organization check (/v1.0/organization)
  try {
    await client.api('/organization').select('id').get()
    checks.organization = { ok: true }
  } catch (err: any) {
    checks.organization = { ok: false, error: sanitizeGraphError(err) }
  }

  // 2. Users check (/v1.0/users?$top=1&$select=id)
  try {
    await client.api('/users').top(1).select('id').get()
    checks.users = { ok: true }
  } catch (err: any) {
    checks.users = { ok: false, error: sanitizeGraphError(err) }
  }

  // 3. Licenses check (/v1.0/subscribedSkus)
  try {
    await client.api('/subscribedSkus').get()
    checks.licenses = { ok: true }
  } catch (err: any) {
    checks.licenses = { ok: false, error: sanitizeGraphError(err) }
  }

  // 4. Sign-ins check (/v1.0/auditLogs/signIns?$top=1&$select=id)
  try {
    await client.api('/auditLogs/signIns').top(1).select('id').get()
    checks.signIns = { ok: true }
  } catch (err: any) {
    checks.signIns = { ok: false, error: sanitizeGraphError(err) }
  }

  // 5. Secure Score check (/v1.0/security/secureScores?$top=1)
  try {
    await client.api('/security/secureScores').top(1).get()
    checks.secureScore = { ok: true }
  } catch (err: any) {
    checks.secureScore = { ok: false, error: sanitizeGraphError(err) }
  }

  const values = Object.values(checks)
  const passCount = values.filter((c) => c.ok).length

  let overallStatus: 'ready' | 'partial' | 'failed' = 'failed'
  if (passCount === values.length) {
    overallStatus = 'ready'
  } else if (passCount > 0) {
    overallStatus = 'partial'
  }

  return {
    overallStatus,
    checks,
  }
}

export interface MicrosoftTenantSummary {
  id: string
  name: string
  domain: string
  domains: string[]
  provider: 'microsoft'
  status: 'healthy' | 'warning' | 'critical'
  secureScore: number
  licenseCount: number
  lastSync: string
}

interface CacheEntry {
  data: any
  expiresAt: number
}

const bundleCache = new Map<string, CacheEntry>()
const pendingBundleRequests = new Map<string, Promise<any>>()
let summaryCache: CacheEntry | null = null
let pendingSummaryRequest: Promise<MicrosoftTenantSummary> | null = null

const CACHE_TTL_MS = 5 * 60 * 1000 // 5 minutes

import { getFriendlySkuName } from './microsoft-sku-mapper'
import { checkDomainDnsHealth } from './dns-lookup'

export async function getLiveMicrosoftTenantBundle(
  tenantId?: string,
  options?: { forceRefresh?: boolean }
): Promise<any> {
  const cacheKey = (tenantId || 'default').toLowerCase().trim()

  if (options?.forceRefresh) {
    bundleCache.delete(cacheKey)
  } else {
    const cached = bundleCache.get(cacheKey)
    if (cached && Date.now() < cached.expiresAt) {
      return cached.data
    }
  }

  if (pendingBundleRequests.has(cacheKey)) {
    return pendingBundleRequests.get(cacheKey)!
  }

  const requestPromise = (async () => {
    try {
      const fetchBundle = async () => {
        const client = await getGraphClient()

        const orgStart = performance.now()
        const scoreStart = performance.now()
        const skusStart = performance.now()

        const orgCall = withTimeout(
          client.api('/organization').select('id,displayName,verifiedDomains').get(),
          8000,
          'Organization request'
        ).then((res) => {
          if (process.env.NODE_ENV !== 'production') {
            console.log(`[Microsoft Graph] Organization request took ${Math.round(performance.now() - orgStart)}ms`)
          }
          return res
        })

        const scoreCall = withTimeout(
          client.api('/security/secureScores').top(1).get(),
          8000,
          'Secure Score request'
        ).then((res) => {
          if (process.env.NODE_ENV !== 'production') {
            console.log(`[Microsoft Graph] Secure Score request took ${Math.round(performance.now() - scoreStart)}ms`)
          }
          return res
        })

        const skusCall = withTimeout(
          client.api('/subscribedSkus').get(),
          8000,
          'subscribedSkus request'
        ).then((res) => {
          if (process.env.NODE_ENV !== 'production') {
            console.log(`[Microsoft Graph] subscribedSkus request took ${Math.round(performance.now() - skusStart)}ms`)
          }
          return res
        })

        const usersCall = withTimeout(
          client.api('/users').top(999).select('id,displayName,userPrincipalName,userType,accountEnabled,createdDateTime,signInActivity').get(),
          8000,
          'Users request'
        )

        const signInsCall = withTimeout(
          client.api('/auditLogs/signIns').top(50).select('id,userId,userDisplayName,userPrincipalName,createdDateTime,ipAddress,status,appDisplayName,clientAppUsed,location').get(),
          8000,
          'Sign-ins request'
        )

        // Execute independent Graph calls in parallel
        const [
          orgResult,
          scoreResult,
          skusResult,
          usersResult,
          signInsResult,
        ] = await Promise.allSettled([
          orgCall,
          scoreCall,
          skusCall,
          usersCall,
          signInsCall,
        ])

      // 1. Organization (Required for identity)
      if (orgResult.status === 'rejected') {
        throw orgResult.reason
      }
      const org = orgResult.value?.value?.[0]
      if (!org) {
        throw new Error('No organization details returned from Microsoft Graph.')
      }

      let domain = 'unknown'
      let domains: string[] = []
      if (Array.isArray(org.verifiedDomains)) {
        domains = org.verifiedDomains.map((d: any) => d.name).filter(Boolean)
        const defaultDom =
          org.verifiedDomains.find((d: any) => d.isDefault) ||
          org.verifiedDomains.find((d: any) => d.isInitial) ||
          org.verifiedDomains[0]
        if (defaultDom?.name) {
          domain = defaultDom.name
        }
      }

      // 2. Secure Score
      let secureScore = 0
      if (scoreResult.status === 'fulfilled') {
        const scoreItem = scoreResult.value?.value?.[0]
        if (
          scoreItem?.currentScore != null &&
          scoreItem?.maxScore != null &&
          scoreItem.maxScore > 0
        ) {
          secureScore = Math.round((scoreItem.currentScore / scoreItem.maxScore) * 100)
        }
      }

      // 3. Subscribed SKUs / Licenses with official SKU friendly name mapping
      let licenseCount = 0
      const licenseRows: Array<{
        name: string
        skuPartNumber: string
        used: number
        total: number
        available: number
        utilization: number
      }> = []

      if (skusResult.status === 'fulfilled' && Array.isArray(skusResult.value?.value)) {
        for (const sku of skusResult.value.value) {
          const used = sku.consumedUnits || 0
          const total = sku.prepaidUnits?.enabled || 0
          const available = Math.max(total - used, 0)
          const utilization = total > 0 ? (used / total) * 100 : 0
          const skuPartNumber = sku.skuPartNumber || sku.skuId || 'UNKNOWN_SKU'
          const friendlyName = getFriendlySkuName(sku.skuPartNumber, sku.skuId)

          licenseCount += used
          licenseRows.push({
            name: friendlyName,
            skuPartNumber,
            used,
            total,
            available,
            utilization,
          })
        }
      }

      // 4. Server-side live DNS check
      const dnsHealth = await checkDomainDnsHealth(domain, options?.forceRefresh)

      // 5. Users
      const users: any[] = []
      if (usersResult.status === 'fulfilled' && Array.isArray(usersResult.value?.value)) {
        for (const u of usersResult.value.value) {
          users.push({
            id: u.id,
            name: u.displayName || u.userPrincipalName || 'User',
            email: u.userPrincipalName || '',
            type: u.userType === 'Guest' ? 'Guest' : 'Member',
            role: 'User',
            status: u.accountEnabled !== false ? 'Enabled' : 'Disabled',
            mfa: 'Disabled',
            lastLogin: u.signInActivity?.lastSignInDateTime || u.createdDateTime || new Date().toISOString(),
            driveUsage: '0 GB',
            mailUsage: '0 MB',
            authMethods: [],
            licenses: [],
            groups: [],
            devices: [],
          })
        }
      }

      // 6. Sign-ins
      const signIns: any[] = []
      if (signInsResult.status === 'fulfilled' && Array.isArray(signInsResult.value?.value)) {
        for (const item of signInsResult.value.value) {
          signIns.push({
            id: item.id,
            userId: item.userId || '',
            userDisplayName: item.userDisplayName || 'Unknown',
            userPrincipalName: item.userPrincipalName || '',
            createdAt: item.createdDateTime || new Date().toISOString(),
            ipAddress: item.ipAddress || '0.0.0.0',
            result: item.status?.errorCode === 0 ? 'Success' : 'Failure',
            appDisplayName: item.appDisplayName || 'Microsoft App',
            clientAppUsed: item.clientAppUsed || 'Browser',
            country: item.location?.countryOrRegion || 'United States',
            city: item.location?.city || '',
            latitude: item.location?.geoCoordinates?.latitude || 37.7749,
            longitude: item.location?.geoCoordinates?.longitude || -122.4194,
            riskLevel: 'low',
          })
        }
      }

      // 7. Health Calculation
      // Critical: Microsoft Graph connection fails, required endpoints unreachable, no successful sync, or last sync > 24h
      // Warning: Graph connected & current, but Secure Score < 50%, or SPF/DKIM/DMARC warning, or SKU >= 90% utilization
      // Healthy: Connected, current, no known warning condition
      let status: 'healthy' | 'warning' | 'critical' = 'healthy'

      const isDnsWarning =
        dnsHealth.spf.status === 'warning' ||
        dnsHealth.dkim.status === 'warning' ||
        dnsHealth.dmarc.status === 'warning'

      const isHighUtilization = licenseRows.some(
        (l) => l.total > 0 && l.used / l.total >= 0.9
      )

      if (secureScore < 50 || isDnsWarning || isHighUtilization) {
        status = 'warning'
      }

      const nowIso = new Date().toISOString()

      const bundle = {
        tenant: {
          id: org.id || 'microsoft-tenant',
          name: org.displayName || 'Microsoft Tenant',
          domain,
          domains,
          provider: 'microsoft',
          status,
          secureScore,
          licenseCount,
          lastSync: nowIso,
        },
        users,
        signIns,
        licenses: {
          rows: licenseRows,
        },
        dns: {
          spf: dnsHealth.spf,
          dkim: dnsHealth.dkim,
          dmarc: dnsHealth.dmarc,
          blacklist: dnsHealth.blacklist,
        },
        entra: {
          caPolicies: [],
          authMethods: [],
          namedLocations: [],
        },
        exchange: {
          mailboxes: [],
          rules: [],
          acceptedDomains: [],
          groups: [],
        },
        sharepoint: {
          overview: {
            totalSites: 0,
            totalStorageQuotaGB: 0,
            oneDriveStorageLimitGB: 0,
            siteStorageLimitsMode: 'Automatic',
            sharingSharePoint: 'ONLY_PEOPLE_IN_ORG',
            sharingOneDrive: 'ONLY_PEOPLE_IN_ORG',
          },
          sites: [],
          deletedSites: [],
        },
        teams: {
          stats: {
            teamsCount: 0,
            channelsCount: 0,
            privateChannels: 0,
            sharedChannels: 0,
            guestUsers: 0,
            externalUsers: 0,
          },
          policySummary: {
            messagingPolicies: 0,
            meetingPolicies: 0,
            callingPolicies: 0,
            appPermissionPolicies: 0,
            appSetupPolicies: 0,
          },
          externalAccess: {
            enabled: false,
            allowTeamsConsumer: false,
            allowedTenants: [],
            allowedDomains: [],
          },
          meetingSettings: {
            anonymousJoin: 'Blocked',
            cloudRecording: 'Blocked',
            transcription: 'Blocked',
            lobbyBypass: 'Everyone',
          },
          phoneOverview: {
            totalNumbers: 0,
            assignedToUsers: 0,
            resourceAccounts: 0,
            autoAttendants: 0,
            callQueues: 0,
          },
          appGovernance: {
            allowedAppsCount: 0,
            blockedAppsCount: 0,
            customAppsCount: 0,
            highRiskApps: [],
          },
          lifecycle: {
            activeTeams: 0,
            inactiveTeams90d: 0,
            inactiveTeams180d: 0,
            staleTeams: [],
          },
        },
      }

      }

      const bundle = await withTimeout(fetchBundle(), 20000, 'Overall bundle request')

      bundleCache.set(cacheKey, {
        data: bundle,
        expiresAt: Date.now() + CACHE_TTL_MS,
      })

      return bundle
    } catch (err) {
      bundleCache.delete(cacheKey)
      throw err
    } finally {
      pendingBundleRequests.delete(cacheKey)
    }
  })()

  pendingBundleRequests.set(cacheKey, requestPromise)
  return requestPromise
}

export async function getLiveMicrosoftTenantSummary(options?: {
  forceRefresh?: boolean
}): Promise<MicrosoftTenantSummary> {
  if (options?.forceRefresh) {
    summaryCache = null
  } else if (summaryCache && Date.now() < summaryCache.expiresAt) {
    return summaryCache.data as MicrosoftTenantSummary
  }

  if (pendingSummaryRequest) {
    return pendingSummaryRequest
  }

  pendingSummaryRequest = withTimeout(
    (async () => {
      const client = await getGraphClient()

      // The directory card needs only these three lightweight calls. Users,
      // sign-ins, DNS, and the full tenant bundle load after Manage Tenant.
      const [orgResult, scoreResult, skusResult] = await Promise.allSettled([
        withTimeout(
          client
            .api('/organization')
            .select('id,displayName,verifiedDomains')
            .get(),
          8000,
          'Organization summary request'
        ),
        withTimeout(
          client.api('/security/secureScores').top(1).get(),
          8000,
          'Secure Score summary request'
        ),
        withTimeout(
          client.api('/subscribedSkus').get(),
          8000,
          'License summary request'
        ),
      ])

      if (orgResult.status === 'rejected') {
        throw orgResult.reason
      }

      const org = orgResult.value?.value?.[0]
      if (!org) {
        throw new Error('No organization details returned from Microsoft Graph.')
      }

      const verifiedDomains = Array.isArray(org.verifiedDomains)
        ? org.verifiedDomains
        : []
      const domains = verifiedDomains
        .map((domain: any) => domain?.name)
        .filter(Boolean)
      const defaultDomain =
        verifiedDomains.find((domain: any) => domain?.isDefault) ||
        verifiedDomains.find((domain: any) => domain?.isInitial) ||
        verifiedDomains[0]

      let secureScore = 0
      let hasWarning = scoreResult.status === 'rejected'
      if (scoreResult.status === 'fulfilled') {
        const score = scoreResult.value?.value?.[0]
        if (score?.maxScore > 0) {
          secureScore = Math.round(
            (Number(score.currentScore || 0) / Number(score.maxScore)) * 100
          )
          if (secureScore < 50) hasWarning = true
        }
      }

      let licenseCount = 0
      if (
        skusResult.status === 'fulfilled' &&
        Array.isArray(skusResult.value?.value)
      ) {
        for (const sku of skusResult.value.value) {
          const used = Number(sku?.consumedUnits || 0)
          const total = Number(sku?.prepaidUnits?.enabled || 0)
          licenseCount += used
          if (total > 0 && used / total >= 0.9) hasWarning = true
        }
      } else {
        hasWarning = true
      }

      const summary: MicrosoftTenantSummary = {
        id: org.id || 'microsoft-tenant',
        name: org.displayName || 'Microsoft Tenant',
        domain: defaultDomain?.name || domains[0] || 'unknown',
        domains,
        provider: 'microsoft',
        status: hasWarning ? 'warning' : 'healthy',
        secureScore,
        licenseCount,
        lastSync: new Date().toISOString(),
      }

      summaryCache = {
        data: summary,
        expiresAt: Date.now() + CACHE_TTL_MS,
      }

      return summary
    })(),
    18000,
    'Tenant directory summary request'
  ).finally(() => {
    pendingSummaryRequest = null
  })

  return pendingSummaryRequest
}
