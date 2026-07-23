import { ClientSecretCredential } from '@azure/identity'
import { Client, ResponseType } from '@microsoft/microsoft-graph-client'

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

function graphValues(result: PromiseSettledResult<any>): any[] {
  return result.status === 'fulfilled' && Array.isArray(result.value?.value)
    ? result.value.value
    : []
}

function graphDataStatus(result: PromiseSettledResult<any>) {
  if (result.status === 'fulfilled') {
    return {
      ok: true,
      count: Array.isArray(result.value?.value)
        ? result.value.value.length
        : undefined,
    }
  }
  return {
    ok: false,
    error: sanitizeGraphError(result.reason),
  }
}

function splitCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let value = ''
  let quoted = false

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]
    const next = text[index + 1]

    if (char === '"' && quoted && next === '"') {
      value += '"'
      index += 1
    } else if (char === '"') {
      quoted = !quoted
    } else if (char === ',' && !quoted) {
      row.push(value)
      value = ''
    } else if ((char === '\n' || char === '\r') && !quoted) {
      if (char === '\r' && next === '\n') index += 1
      row.push(value)
      value = ''
      if (row.some((cell) => cell.length > 0)) rows.push(row)
      row = []
    } else {
      value += char
    }
  }

  row.push(value)
  if (row.some((cell) => cell.length > 0)) rows.push(row)
  return rows
}

function csvRecords(csv: unknown): Array<Record<string, string>> {
  if (typeof csv !== 'string' || csv.trim().length === 0) return []
  const rows = splitCsv(csv)
  if (rows.length < 2) return []

  const headers = rows[0].map((header) =>
    header.replace(/^\uFEFF/, '').trim().toLowerCase()
  )
  return rows.slice(1).map((cells) => {
    const record: Record<string, string> = {}
    headers.forEach((header, index) => {
      record[header] = cells[index] ?? ''
    })
    return record
  })
}

function reportValue(
  record: Record<string, string> | undefined,
  ...keys: string[]
): string {
  if (!record) return ''
  for (const key of keys) {
    const value = record[key.toLowerCase()]
    if (value != null && value !== '') return value
  }
  return ''
}

function reportNumber(
  record: Record<string, string> | undefined,
  ...keys: string[]
): number {
  const value = Number(reportValue(record, ...keys).replace(/,/g, ''))
  return Number.isFinite(value) ? value : 0
}

function bytesToGigabytes(value: number): number {
  return Number((Math.max(value, 0) / 1024 / 1024 / 1024).toFixed(2))
}

function nameFromWebUrl(url: string): string {
  try {
    const pathname = new URL(url).pathname
    const part = pathname.split('/').filter(Boolean).pop()
    return part ? decodeURIComponent(part).replace(/[-_]+/g, ' ') : 'Site'
  } catch {
    return 'Site'
  }
}

function mailboxUsageByUpn(csv: unknown): Map<string, Record<string, string>> {
  const result = new Map<string, Record<string, string>>()
  for (const record of csvRecords(csv)) {
    const upn = record['user principal name']?.trim().toLowerCase()
    if (!upn) continue
    result.set(upn, record)
  }
  return result
}

function graphLabel(value: string): string {
  return value
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .replace(/\b\w/g, (letter) => letter.toUpperCase())
}

function flattenGraphValue(value: any): string[] {
  if (value == null || value === false || value === '') return []
  if (value === true) return ['Yes']
  if (typeof value === 'string' || typeof value === 'number') {
    return [String(value)]
  }
  if (Array.isArray(value)) {
    return value.flatMap((item) => flattenGraphValue(item))
  }
  if (typeof value === 'object') {
    if (value.emailAddress?.address) {
      return [value.emailAddress.address]
    }
    return Object.entries(value).flatMap(([key, nested]) =>
      flattenGraphValue(nested).map((item) => `${graphLabel(key)}: ${item}`)
    )
  }
  return []
}

function summarizeRuleObject(value: any): string[] {
  if (!value || typeof value !== 'object') return []

  return Object.entries(value).flatMap(([key, nested]) => {
    const values = flattenGraphValue(nested)
    if (values.length === 0) return []
    return [`${graphLabel(key)}: ${values.join(', ')}`]
  })
}

function mailboxTypeFromPurpose(
  purpose: unknown,
  user: any
): 'User' | 'Shared' | 'Room' | 'Equipment' {
  const normalized = String(purpose || '').toLowerCase()
  if (normalized === 'shared') return 'Shared'
  if (normalized === 'room') return 'Room'
  if (normalized === 'equipment') return 'Equipment'

  const searchable =
    `${user?.displayName || ''} ${user?.userPrincipalName || ''}`.toLowerCase()
  if (searchable.includes('room')) return 'Room'
  if (searchable.includes('equipment')) return 'Equipment'
  if (
    user?.accountEnabled === false &&
    (!Array.isArray(user?.assignedLicenses) ||
      user.assignedLicenses.length === 0)
  ) {
    return 'Shared'
  }
  return 'User'
}

async function getMailboxPurposesAndRules(
  client: Client,
  mailboxUsers: any[]
): Promise<{
  purposes: Map<string, string>
  rules: any[]
}> {
  const purposes = new Map<string, string>()
  const rules: any[] = []
  const requestMetadata = new Map<
    string,
    { kind: 'purpose' | 'rules'; user: any }
  >()
  const requests: Array<{ id: string; method: string; url: string }> = []

  mailboxUsers.forEach((user, index) => {
    const encodedId = encodeURIComponent(user.id)
    const purposeId = `purpose-${index}`
    const rulesId = `rules-${index}`
    requests.push(
      {
        id: purposeId,
        method: 'GET',
        url: `/users/${encodedId}/mailboxSettings/userPurpose`,
      },
      {
        id: rulesId,
        method: 'GET',
        url: `/users/${encodedId}/mailFolders/inbox/messageRules?$select=id,displayName,sequence,isEnabled,conditions,actions`,
      }
    )
    requestMetadata.set(purposeId, { kind: 'purpose', user })
    requestMetadata.set(rulesId, { kind: 'rules', user })
  })

  const batches: Array<Array<{ id: string; method: string; url: string }>> = []
  for (let index = 0; index < requests.length; index += 20) {
    batches.push(requests.slice(index, index + 20))
  }

  const batchResults = await Promise.allSettled(
    batches.map((batch, index) =>
      withTimeout(
        client.api('/$batch').post({ requests: batch }),
        8000,
        `Exchange mailbox batch ${index + 1}`
      )
    )
  )

  for (const result of batchResults) {
    if (result.status !== 'fulfilled') continue

    for (const response of result.value?.responses || []) {
      if (response?.status < 200 || response?.status >= 300) continue
      const metadata = requestMetadata.get(String(response.id))
      if (!metadata) continue

      if (metadata.kind === 'purpose') {
        const value = response.body?.value
        if (value) purposes.set(metadata.user.id, value)
        continue
      }

      for (const rule of response.body?.value || []) {
        const conditions = summarizeRuleObject(rule.conditions)
        const actions = summarizeRuleObject(rule.actions)
        rules.push({
          id: `${metadata.user.id}:${rule.id}`,
          name: rule.displayName || 'Inbox rule',
          mailboxUpn:
            metadata.user.userPrincipalName || metadata.user.mail || '',
          enabled: rule.isEnabled !== false,
          priority: Number(rule.sequence || 0),
          description:
            conditions.length || actions.length
              ? `${conditions.join('; ')}${conditions.length && actions.length ? ' → ' : ''}${actions.join('; ')}`
              : 'Inbox rule',
          actions,
          conditions,
        })
      }
    }
  }

  return { purposes, rules }
}

async function getMailGroupDetails(
  client: Client,
  groups: any[]
): Promise<
  {
    details: Map<string, { membersCount: number; owners: string[] }>
    ok: boolean
    error?: string
  }
> {
  const details = new Map<
    string,
    { membersCount: number; owners: string[] }
  >()
  let failedRequests = 0
  const metadata = new Map<
    string,
    { groupId: string; kind: 'members' | 'owners' }
  >()
  const requests: any[] = []

  groups.forEach((group, index) => {
    if (!group?.id) return
    const groupId = String(group.id)
    details.set(groupId, { membersCount: 0, owners: [] })

    const membersId = `mail-group-members-${index}`
    const ownersId = `mail-group-owners-${index}`
    metadata.set(membersId, { groupId, kind: 'members' })
    metadata.set(ownersId, { groupId, kind: 'owners' })
    requests.push(
      {
        id: membersId,
        method: 'GET',
        url: `/groups/${encodeURIComponent(groupId)}/members/$count`,
        headers: { ConsistencyLevel: 'eventual' },
      },
      {
        id: ownersId,
        method: 'GET',
        url: `/groups/${encodeURIComponent(groupId)}/owners?$select=id,displayName,userPrincipalName`,
      }
    )
  })

  for (let start = 0; start < requests.length; start += 20) {
    try {
      const batch = requests.slice(start, start + 20)
      const result = await withTimeout(
        client.api('/$batch').post({ requests: batch }),
        12000,
        `Mail groups batch ${start / 20 + 1}`
      )

      for (const response of result?.responses || []) {
        if (response?.status < 200 || response?.status >= 300) {
          failedRequests += 1
          continue
        }
        const request = metadata.get(String(response.id))
        if (!request) continue
        const current = details.get(request.groupId) || {
          membersCount: 0,
          owners: [],
        }

        if (request.kind === 'members') {
          const count = Number(response.body)
          current.membersCount = Number.isFinite(count) ? count : 0
        } else {
          current.owners = (response.body?.value || [])
            .map(
              (owner: any) =>
                owner.displayName || owner.userPrincipalName || undefined
            )
            .filter(Boolean)
        }
        details.set(request.groupId, current)
      }
    } catch {
      failedRequests += requests.slice(start, start + 20).length
    }
  }

  return {
    details,
    ok: failedRequests === 0,
    error:
      failedRequests > 0
        ? 'Some group membership or owner details could not be read.'
        : undefined,
  }
}

function authMethodName(id: unknown): string {
  const names: Record<string, string> = {
    microsoftAuthenticator: 'Microsoft Authenticator',
    fido2: 'FIDO2 Security Key',
    temporaryAccessPass: 'Temporary Access Pass',
    sms: 'SMS',
    voice: 'Voice Call',
    email: 'Email OTP',
    hardwareOath: 'Hardware OATH Tokens',
    softwareOath: 'Software OATH Tokens',
    x509Certificate: 'Certificate-based Authentication',
    passKeyDeviceBound: 'Passkeys',
    qrCode: 'QR Code',
  }
  const key = String(id || '')
  return names[key] || graphLabel(key || 'Authentication method')
}

function grantControlLabel(value: unknown): string {
  const labels: Record<string, string> = {
    block: 'Block access',
    mfa: 'Require multifactor authentication',
    compliantDevice: 'Require device to be marked as compliant',
    domainJoinedDevice: 'Require Microsoft Entra hybrid joined device',
    approvedApplication: 'Require approved client app',
    compliantApplication: 'Require app protection policy',
    passwordChange: 'Require password change',
    termsOfUse: 'Require terms of use',
  }
  const key = String(value || '')
  return labels[key] || graphLabel(key)
}

function conditionalAccessTargetSummary(conditions: any): string {
  const users = conditions?.users || {}
  const includedUsers = Array.isArray(users.includeUsers)
    ? users.includeUsers
    : []
  if (includedUsers.includes('All')) return 'All Users'
  if (includedUsers.includes('GuestsOrExternalUsers')) {
    return 'Guests and external users'
  }

  const total =
    includedUsers.length +
    (Array.isArray(users.includeGroups) ? users.includeGroups.length : 0) +
    (Array.isArray(users.includeRoles) ? users.includeRoles.length : 0)
  return total > 0 ? `${total} Users, Groups, or Roles` : 'Selected identities'
}

type ConditionalAccessResolvers = {
  users: Map<string, string>
  groups: Map<string, string>
  roles: Map<string, string>
  applications: Map<string, string>
}

function resolveConditionalAccessReference(
  value: unknown,
  kind: 'user' | 'group' | 'role' | 'application',
  resolvers: ConditionalAccessResolvers
): string {
  const id = String(value || '')
  const specialValues: Record<string, string> = {
    All: kind === 'application' ? 'All Cloud Apps' : 'All Users',
    GuestsOrExternalUsers: 'Guests and external users',
    Office365: 'Office 365',
    MicrosoftAdminPortals: 'Microsoft Admin Portals',
    AllTrusted: 'All trusted locations',
    None: 'None',
  }
  if (specialValues[id]) return specialValues[id]

  const lookup =
    kind === 'user'
      ? resolvers.users
      : kind === 'group'
        ? resolvers.groups
        : kind === 'role'
          ? resolvers.roles
          : resolvers.applications
  const resolved = lookup.get(id.toLowerCase())
  if (resolved) {
    if (kind === 'group') return `Group: ${resolved}`
    if (kind === 'role') return `Directory role: ${resolved}`
    return resolved
  }

  // Never expose raw directory GUIDs in the portal. An unresolved reference
  // usually means the object was deleted or the app cannot read that type.
  const unavailableLabels = {
    user: 'Deleted or unavailable user',
    group: 'Deleted or unavailable group',
    role: 'Unavailable directory role',
    application: 'Unavailable cloud application',
  }
  return unavailableLabels[kind]
}

function mapConditionalAccessPolicies(
  rawPolicies: any[],
  resolvers: ConditionalAccessResolvers
): any[] {
  return rawPolicies.map((policy) => {
    const builtInControls = Array.isArray(policy?.grantControls?.builtInControls)
      ? policy.grantControls.builtInControls
      : []
    const grantLabels = builtInControls.map(grantControlLabel)
    const includePlatforms = Array.isArray(
      policy?.conditions?.platforms?.includePlatforms
    )
      ? policy.conditions.platforms.includePlatforms
      : []
    const platformNames = includePlatforms
      .map((platform: string) => {
        const mapping: Record<string, string> = {
          windows: 'Windows',
          macOS: 'macOS',
          iOS: 'iOS',
          android: 'Android',
        }
        return mapping[platform]
      })
      .filter(Boolean)

    return {
      id: policy.id,
      name: policy.displayName || 'Conditional Access policy',
      state:
        policy.state === 'enabled'
          ? 'ON'
          : policy.state === 'enabledForReportingButNotEnforced'
            ? 'REPORT_ONLY'
            : 'OFF',
      origin: policy.templateId ? 'MICROSOFT_TEMPLATE' : 'CUSTOM',
      targetSummary: conditionalAccessTargetSummary(policy.conditions),
      grantSummary:
        grantLabels.join(
          policy?.grantControls?.operator === 'OR' ? ' or ' : ' and '
        ) || 'Session or authentication controls',
      assignments: {
        usersAndGroups: {
          include: [
            ...(policy?.conditions?.users?.includeUsers || []).map(
              (id: string) =>
                resolveConditionalAccessReference(id, 'user', resolvers)
            ),
            ...(policy?.conditions?.users?.includeGroups || []).map(
              (id: string) =>
                resolveConditionalAccessReference(id, 'group', resolvers)
            ),
            ...(policy?.conditions?.users?.includeRoles || []).map(
              (id: string) =>
                resolveConditionalAccessReference(id, 'role', resolvers)
            ),
          ],
          exclude: [
            ...(policy?.conditions?.users?.excludeUsers || []).map(
              (id: string) =>
                resolveConditionalAccessReference(id, 'user', resolvers)
            ),
            ...(policy?.conditions?.users?.excludeGroups || []).map(
              (id: string) =>
                resolveConditionalAccessReference(id, 'group', resolvers)
            ),
            ...(policy?.conditions?.users?.excludeRoles || []).map(
              (id: string) =>
                resolveConditionalAccessReference(id, 'role', resolvers)
            ),
          ],
        },
        cloudApps: {
          include: (
            policy?.conditions?.applications?.includeApplications || []
          ).map((id: string) =>
            resolveConditionalAccessReference(id, 'application', resolvers)
          ),
        },
      },
      conditions:
        platformNames.length > 0 ? { platforms: platformNames } : undefined,
      accessControls: {
        grant: grantLabels,
      },
    }
  })
}

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
          client.api('/users').top(500).select('id,displayName,userPrincipalName,mail,proxyAddresses,userType,accountEnabled,createdDateTime,signInActivity,assignedLicenses').get(),
          8000,
          'Users request'
        )

        const signInFields =
          'id,userId,userDisplayName,userPrincipalName,createdDateTime,ipAddress,status,appDisplayName,clientAppUsed,location'
        const signInsCall = withTimeout(
          client
            .api('/auditLogs/signIns')
            .top(100)
            .orderby('createdDateTime desc')
            .select(signInFields)
            .get(),
          15000,
          'Sign-ins request'
        ).catch(() =>
          withTimeout(
            client
              .api('/auditLogs/signIns')
              .top(25)
              .select(signInFields)
              .get(),
            8000,
            'Sign-ins retry'
          )
        )

        // These enrichments are deliberately optional. A missing permission
        // leaves only that section empty instead of taking down the tenant.
        const caPoliciesCall = withTimeout(
          client.api('/identity/conditionalAccess/policies').get(),
          8000,
          'Conditional Access policies request'
        )
        const authMethodsPolicyCall = withTimeout(
          client.api('/policies/authenticationMethodsPolicy').get(),
          8000,
          'Authentication methods policy request'
        )
        const namedLocationsCall = withTimeout(
          client.api('/identity/conditionalAccess/namedLocations').get(),
          8000,
          'Named locations request'
        )
        const registrationDetailsCall = withTimeout(
          client.api('/reports/authenticationMethods/userRegistrationDetails').top(999).get(),
          8000,
          'Authentication registration details request'
        )
        const roleAssignmentsCall = withTimeout(
          client.api('/roleManagement/directory/roleAssignments').expand('roleDefinition').top(999).get(),
          8000,
          'Directory roles request'
        )
        const roleDefinitionsCall = withTimeout(
          client
            .api('/roleManagement/directory/roleDefinitions')
            .select('id,templateId,displayName')
            .top(999)
            .get(),
          8000,
          'Directory role definitions request'
        )
        const groupsCall = withTimeout(
          client
            .api('/groups')
            .select('id,displayName,description,mail,mailEnabled,securityEnabled,groupTypes,membershipRule,proxyAddresses,resourceProvisioningOptions,visibility')
            .top(999)
            .get(),
          8000,
          'Groups request'
        )
        const groupMembershipsCall = withTimeout(
          client
            .api('/groups')
            .select('id,displayName,mail')
            .expand('members($select=id)')
            .top(999)
            .get(),
          12000,
          'Group memberships request'
        )
        const servicePrincipalsCall = withTimeout(
          client
            .api('/servicePrincipals')
            .select('id,appId,displayName')
            .top(999)
            .get(),
          8000,
          'Cloud applications request'
        )
        const domainsCall = withTimeout(
          client.api('/domains').get(),
          8000,
          'Domains request'
        )
        const devicesCall = withTimeout(
          client
            .api('/devices')
            .select('id,displayName,operatingSystem,approximateLastSignInDateTime,accountEnabled')
            .expand('registeredOwners($select=id)')
            .top(999)
            .get(),
          8000,
          'Devices request'
        )
        const mailboxUsageCall = withTimeout(
          client
            .api("/reports/getMailboxUsageDetail(period='D7')")
            .responseType(ResponseType.TEXT)
            .get(),
          8000,
          'Mailbox usage report request'
        )
        const sharePointSitesCall = withTimeout(
          client
            .api('/sites')
            .query({ search: '*' })
            .select('id,name,displayName,webUrl,createdDateTime,siteCollection')
            .top(999)
            .get(),
          12000,
          'SharePoint sites request'
        )
        const sharePointUsageCall = withTimeout(
          client
            .api("/reports/getSharePointSiteUsageDetail(period='D30')")
            .responseType(ResponseType.TEXT)
            .get(),
          12000,
          'SharePoint usage report request'
        )
        const oneDriveUsageCall = withTimeout(
          client
            .api("/reports/getOneDriveUsageAccountDetail(period='D30')")
            .responseType(ResponseType.TEXT)
            .get(),
          12000,
          'OneDrive usage report request'
        )
        // Execute independent Graph calls in parallel.
        const [
          orgResult,
          scoreResult,
          skusResult,
          usersResult,
          signInsResult,
          caPoliciesResult,
          authMethodsPolicyResult,
          namedLocationsResult,
          registrationDetailsResult,
          roleAssignmentsResult,
          roleDefinitionsResult,
          groupsResult,
          groupMembershipsResult,
          servicePrincipalsResult,
          domainsResult,
          devicesResult,
          mailboxUsageResult,
          sharePointSitesResult,
          sharePointUsageResult,
          oneDriveUsageResult,
        ] = await Promise.allSettled([
          orgCall,
          scoreCall,
          skusCall,
          usersCall,
          signInsCall,
          caPoliciesCall,
          authMethodsPolicyCall,
          namedLocationsCall,
          registrationDetailsCall,
          roleAssignmentsCall,
          roleDefinitionsCall,
          groupsCall,
          groupMembershipsCall,
          servicePrincipalsCall,
          domainsCall,
          devicesCall,
          mailboxUsageCall,
          sharePointSitesCall,
          sharePointUsageCall,
          oneDriveUsageCall,
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
      const skuNamesById = new Map<string, string>()

      if (skusResult.status === 'fulfilled' && Array.isArray(skusResult.value?.value)) {
        for (const sku of skusResult.value.value) {
          const used = sku.consumedUnits || 0
          const total = sku.prepaidUnits?.enabled || 0
          const available = Math.max(total - used, 0)
          const utilization = total > 0 ? (used / total) * 100 : 0
          const skuPartNumber = sku.skuPartNumber || sku.skuId || 'UNKNOWN_SKU'
          const friendlyName = getFriendlySkuName(sku.skuPartNumber, sku.skuId)
          if (sku.skuId) {
            skuNamesById.set(String(sku.skuId).toLowerCase(), friendlyName)
          }

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

      // 4. Server-side live DNS check and per-mailbox Graph data.
      const rawUsers = graphValues(usersResult)
      const rawGroups = graphValues(groupsResult)
      const mailEnabledGroups = rawGroups.filter(
        (group) => group?.mailEnabled === true
      )
      const mailboxUsers = rawUsers.filter(
        (user) => user?.id && (user?.userPrincipalName || user?.mail)
      )
      const [dnsHealth, mailboxDetailsResult, mailGroupDetails] =
        await Promise.all([
          checkDomainDnsHealth(domain, options?.forceRefresh),
          getMailboxPurposesAndRules(client, mailboxUsers).catch(() => ({
            purposes: new Map<string, string>(),
            rules: [],
          })),
          getMailGroupDetails(client, mailEnabledGroups),
        ])

      const registrationByUpn = new Map<string, any>()
      for (const registration of graphValues(registrationDetailsResult)) {
        const key = String(registration.userPrincipalName || '').toLowerCase()
        if (key) registrationByUpn.set(key, registration)
      }

      const roleByUserId = new Map<string, string>()
      for (const assignment of graphValues(roleAssignmentsResult)) {
        const principalId = String(assignment.principalId || '')
        const roleName = String(assignment.roleDefinition?.displayName || '')
        if (!principalId || !roleName) continue
        if (roleName === 'Global Administrator') {
          roleByUserId.set(principalId, 'Global Administrator')
        } else if (roleName === 'External Identity Provider Administrator') {
          roleByUserId.set(principalId, 'External Auditor')
        } else if (!roleByUserId.has(principalId)) {
          roleByUserId.set(principalId, 'User')
        }
      }

      const groupNamesByUserId = new Map<string, string[]>()
      for (const group of graphValues(groupMembershipsResult)) {
        for (const member of group.members || []) {
          const current = groupNamesByUserId.get(member.id) || []
          current.push(group.displayName || group.mail || 'Group')
          groupNamesByUserId.set(member.id, current)
        }
      }

      const devicesByUserId = new Map<string, any[]>()
      for (const device of graphValues(devicesResult)) {
        for (const owner of device.registeredOwners || []) {
          const current = devicesByUserId.get(owner.id) || []
          current.push({
            name: device.displayName || 'Registered device',
            os: device.operatingSystem || 'Unknown',
            lastSync:
              device.approximateLastSignInDateTime || new Date(0).toISOString(),
            status: device.accountEnabled === false ? 'Disabled' : 'Compliant',
          })
          devicesByUserId.set(owner.id, current)
        }
      }

      const mailboxUsage = mailboxUsageByUpn(
        mailboxUsageResult.status === 'fulfilled'
          ? mailboxUsageResult.value
          : ''
      )

      // 5. Users
      const users: any[] = rawUsers.map((user) => {
        const upn = String(user.userPrincipalName || user.mail || '')
        const registration = registrationByUpn.get(upn.toLowerCase())
        const usage = mailboxUsage.get(upn.toLowerCase())
        const storageBytes = Number(
          usage?.['storage used (byte)'] ||
            usage?.['storage used (bytes)'] ||
            0
        )

        return {
          id: user.id,
          name: user.displayName || upn || 'User',
          email: upn,
          type: user.userType === 'Guest' ? 'Guest' : 'Member',
          role: roleByUserId.get(user.id) || 'User',
          status: user.accountEnabled !== false ? 'Enabled' : 'Disabled',
          mfa: registration?.isMfaRegistered ? 'Enabled' : 'Disabled',
          lastLogin:
            user.signInActivity?.lastSignInDateTime ||
            user.createdDateTime ||
            new Date().toISOString(),
          driveUsage: '0 GB',
          mailUsage:
            storageBytes > 0
              ? `${(storageBytes / 1024 / 1024 / 1024).toFixed(2)} GB`
              : '0 GB',
          authMethods: Array.isArray(registration?.methodsRegistered)
            ? registration.methodsRegistered.map(authMethodName)
            : [],
          licenses: (user.assignedLicenses || [])
            .map((license: any) =>
              skuNamesById.get(String(license.skuId || '').toLowerCase())
            )
            .filter(Boolean),
          groups: groupNamesByUserId.get(user.id) || [],
          devices: devicesByUserId.get(user.id) || [],
        }
      })

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

      // 7. Entra ID security data
      const rawCaPolicies = graphValues(caPoliciesResult)
      const conditionalAccessResolvers: ConditionalAccessResolvers = {
        users: new Map(
          rawUsers
            .filter((user) => user?.id)
            .map((user) => [
              String(user.id).toLowerCase(),
              user.displayName || user.userPrincipalName || 'User',
            ])
        ),
        groups: new Map(
          rawGroups
            .filter((group) => group?.id)
            .map((group) => [
              String(group.id).toLowerCase(),
              group.displayName || group.mail || 'Group',
            ])
        ),
        roles: new Map(),
        applications: new Map(),
      }
      for (const role of graphValues(roleDefinitionsResult)) {
        const name = role.displayName || 'Directory role'
        if (role.id) {
          conditionalAccessResolvers.roles.set(
            String(role.id).toLowerCase(),
            name
          )
        }
        if (role.templateId) {
          conditionalAccessResolvers.roles.set(
            String(role.templateId).toLowerCase(),
            name
          )
        }
      }
      for (const application of graphValues(servicePrincipalsResult)) {
        const name = application.displayName || 'Cloud application'
        if (application.id) {
          conditionalAccessResolvers.applications.set(
            String(application.id).toLowerCase(),
            name
          )
        }
        if (application.appId) {
          conditionalAccessResolvers.applications.set(
            String(application.appId).toLowerCase(),
            name
          )
        }
      }
      const caPolicies = mapConditionalAccessPolicies(
        rawCaPolicies,
        conditionalAccessResolvers
      )

      const authPolicy =
        authMethodsPolicyResult.status === 'fulfilled'
          ? authMethodsPolicyResult.value
          : null
      const rawAuthMethods =
        authPolicy?.authenticationMethodConfigurations ||
        authPolicy?.configurations ||
        []
      const authMethods = (Array.isArray(rawAuthMethods) ? rawAuthMethods : []).map(
        (method: any) => {
          const includeTargets = Array.isArray(method.includeTargets)
            ? method.includeTargets
            : []
          const targetsAllUsers = includeTargets.some(
            (target: any) =>
              target.targetType === 'group' && target.id === 'all_users'
          )
          return {
            id: method.id || method['@odata.type'] || crypto.randomUUID(),
            name: authMethodName(method.id),
            target: targetsAllUsers
              ? 'All users'
              : includeTargets.length > 0
                ? `${includeTargets.length} selected group${includeTargets.length === 1 ? '' : 's'}`
                : 'No users',
            status: method.state === 'enabled' ? 'ENABLED' : 'DISABLED',
          }
        }
      )

      const blockedLocationIds = new Set<string>()
      for (const policy of rawCaPolicies) {
        if (
          policy?.grantControls?.builtInControls?.includes('block') &&
          Array.isArray(policy?.conditions?.locations?.includeLocations)
        ) {
          for (const locationId of policy.conditions.locations.includeLocations) {
            if (locationId !== 'All' && locationId !== 'AllTrusted') {
              blockedLocationIds.add(locationId)
            }
          }
        }
      }

      const namedLocations = graphValues(namedLocationsResult).map(
        (location: any) => ({
          id: location.id,
          name: location.displayName || 'Named location',
          type: blockedLocationIds.has(location.id) ? 'BLOCKED' : 'TRUSTED',
          addresses: [
            ...(location.ipRanges || [])
              .map((range: any) => range.cidrAddress)
              .filter(Boolean),
            ...(location.countriesAndRegions || []),
          ],
        })
      )

      // 8. Exchange data available through Microsoft Graph.
      const mailboxes = mailboxUsers.map((user) => {
        const upn = String(user.userPrincipalName || user.mail || '')
        const usage = mailboxUsage.get(upn.toLowerCase())
        const storageBytes = Number(
          usage?.['storage used (byte)'] ||
            usage?.['storage used (bytes)'] ||
            0
        )
        const aliases = (user.proxyAddresses || [])
          .map((address: string) => address.replace(/^smtp:/i, ''))
          .filter(
            (address: string) =>
              address && address.toLowerCase() !== upn.toLowerCase()
          )

        return {
          id: user.id,
          displayName: user.displayName || upn || 'Mailbox',
          userPrincipalName: upn,
          aliases,
          mailboxType: mailboxTypeFromPurpose(
            mailboxDetailsResult.purposes.get(user.id),
            user
          ),
          sizeGB: Number((storageBytes / 1024 / 1024 / 1024).toFixed(2)),
          itemCount: Number(usage?.['item count'] || 0),
          archiveEnabled:
            String(usage?.['has archive'] || '').toLowerCase() === 'true' ||
            Number(usage?.['archive item count'] || 0) > 0,
          delegation: {},
          lastLogon:
            usage?.['last activity date'] ||
            user.signInActivity?.lastSignInDateTime ||
            undefined,
        }
      })

      const acceptedDomains = graphValues(domainsResult).map((item: any) => ({
        id: item.id || item.domainName,
        domain: item.id || item.domainName,
        // Graph exposes verified Entra domains. Exchange accepted-domain relay
        // type requires Exchange Online administration APIs.
        type: 'Authoritative',
        isDefault: item.isDefault === true,
      }))

      const exchangeGroups = mailEnabledGroups
        .map((group: any) => ({
          ...(mailGroupDetails.details.get(String(group.id)) || {
            membersCount: 0,
            owners: [],
          }),
          id: group.id,
          name: group.displayName || group.mail || 'Mail-enabled group',
          type:
            Array.isArray(group.groupTypes) &&
            group.groupTypes.includes('Unified')
              ? 'Microsoft365'
              : group.securityEnabled
                ? 'MailEnabledSecurity'
                : 'DistributionList',
          email: group.mail || '',
          description: group.description || undefined,
        }))

      // 9. SharePoint and OneDrive inventory from Graph plus usage reports.
      const directorySites = graphValues(sharePointSitesResult)
      const directorySiteByUrl = new Map(
        directorySites
          .filter((site) => site?.webUrl)
          .map((site) => [
            String(site.webUrl).replace(/\/$/, '').toLowerCase(),
            site,
          ])
      )
      const sharePointUsageRecords = csvRecords(
        sharePointUsageResult.status === 'fulfilled'
          ? sharePointUsageResult.value
          : ''
      )
      const oneDriveUsageRecords = csvRecords(
        oneDriveUsageResult.status === 'fulfilled'
          ? oneDriveUsageResult.value
          : ''
      )

      const sharePointSiteMap = new Map<string, any>()
      for (const site of directorySites) {
        const url = String(site.webUrl || '')
        if (!url || url.toLowerCase().includes('/personal/')) continue
        sharePointSiteMap.set(url.replace(/\/$/, '').toLowerCase(), {
          id: site.id || url,
          name: site.displayName || site.name || nameFromWebUrl(url),
          url,
          type: 'Team site',
          owners: 0,
          externalSharing: null,
          guestsCount: null,
          storageUsedGB: 0,
          storageQuotaGB: 0,
          lastActivity: site.createdDateTime || '',
          sensitivityLabel: undefined,
        })
      }

      const sharePointUsageSites = sharePointUsageRecords
        .filter(
          (record) =>
            reportValue(record, 'is deleted').toLowerCase() !== 'true'
        )
        .map((record) => {
          const url = reportValue(record, 'site url')
          const directorySite = directorySiteByUrl.get(
            url.replace(/\/$/, '').toLowerCase()
          )
          const template = reportValue(record, 'root web template')
          const owner = reportValue(
            record,
            'owner display name',
            'owner principal name'
          )
          return {
            id:
              reportValue(record, 'site id') ||
              directorySite?.id ||
              url ||
              crypto.randomUUID(),
            name:
              directorySite?.displayName ||
              directorySite?.name ||
              nameFromWebUrl(url),
            url,
            type: template.toUpperCase().includes('SITEPAGEPUBLISHING')
              ? 'Communication site'
              : 'Team site',
            owners: owner ? 1 : 0,
            externalSharing: null,
            guestsCount: null,
            storageUsedGB: bytesToGigabytes(
              reportNumber(record, 'storage used (byte)', 'storage used (bytes)')
            ),
            storageQuotaGB: bytesToGigabytes(
              reportNumber(
                record,
                'storage allocated (byte)',
                'storage allocated (bytes)'
              )
            ),
            lastActivity:
              reportValue(record, 'last activity date') ||
              directorySite?.createdDateTime ||
              '',
            sensitivityLabel: undefined,
          }
        })
      for (const site of sharePointUsageSites) {
        const key = String(site.url || '').replace(/\/$/, '').toLowerCase()
        const existing = sharePointSiteMap.get(key)
        sharePointSiteMap.set(key, { ...existing, ...site })
      }
      const sharePointSites = Array.from(sharePointSiteMap.values())

      const oneDriveSites = oneDriveUsageRecords
        .filter(
          (record) =>
            reportValue(record, 'is deleted').toLowerCase() !== 'true'
        )
        .map((record) => {
          const url = reportValue(record, 'site url', 'url')
          const owner = reportValue(
            record,
            'owner display name',
            'owner principal name'
          )
          return {
            id:
              reportValue(record, 'site id') ||
              reportValue(record, 'owner principal name') ||
              url ||
              crypto.randomUUID(),
            name: owner || nameFromWebUrl(url),
            url,
            type: 'OneDrive',
            owners: owner ? 1 : 0,
            externalSharing: null,
            guestsCount: null,
            storageUsedGB: bytesToGigabytes(
              reportNumber(record, 'storage used (byte)', 'storage used (bytes)')
            ),
            storageQuotaGB: bytesToGigabytes(
              reportNumber(
                record,
                'storage allocated (byte)',
                'storage allocated (bytes)'
              )
            ),
            lastActivity: reportValue(record, 'last activity date'),
            sensitivityLabel: undefined,
          }
        })

      const allSharePointSites = [...sharePointSites, ...oneDriveSites]
      const totalSharePointQuotaGB = Number(
        sharePointSites
          .reduce(
            (total, site) => total + Number(site.storageQuotaGB || 0),
            0
          )
          .toFixed(2)
      )
      const oneDriveStorageLimitGB = oneDriveSites.reduce(
        (largest, site) =>
          Math.max(largest, Number(site.storageQuotaGB || 0)),
        0
      )

      // 10. Health Calculation
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
        dataStatus: {
          users: graphDataStatus(usersResult),
          signIns: graphDataStatus(signInsResult),
          conditionalAccess: graphDataStatus(caPoliciesResult),
          authenticationMethods: graphDataStatus(authMethodsPolicyResult),
          namedLocations: graphDataStatus(namedLocationsResult),
          directoryRoles: graphDataStatus(roleDefinitionsResult),
          groups: graphDataStatus(groupsResult),
          groupMemberships: graphDataStatus(groupMembershipsResult),
          mailGroupDetails: {
            ok: mailGroupDetails.ok,
            count: exchangeGroups.length,
            error: mailGroupDetails.error,
          },
          dynamicDistributionGroups: {
            ok: false,
            supported: false,
            error:
              'Dynamic distribution groups require an Exchange Online administrative collector.',
          },
          applications: graphDataStatus(servicePrincipalsResult),
          devices: graphDataStatus(devicesResult),
          mailboxUsage: graphDataStatus(mailboxUsageResult),
          sharePointSites: graphDataStatus(sharePointSitesResult),
          sharePointUsage: {
            ...graphDataStatus(sharePointUsageResult),
            count: sharePointSites.length,
          },
          oneDriveUsage: {
            ...graphDataStatus(oneDriveUsageResult),
            count: oneDriveSites.length,
          },
          sharePointAdminSettings: {
            ok: false,
            supported: false,
            error:
              'Tenant sharing settings and deleted sites require a SharePoint Online administrative collector.',
          },
        },
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
          caPolicies,
          authMethods,
          namedLocations,
        },
        exchange: {
          mailboxes,
          rules: mailboxDetailsResult.rules,
          acceptedDomains,
          groups: exchangeGroups,
        },
        sharepoint: {
          overview: {
            totalSites: allSharePointSites.length,
            totalStorageQuotaGB: totalSharePointQuotaGB,
            oneDriveStorageLimitGB,
            siteStorageLimitsMode: null,
            sharingSharePoint: null,
            sharingOneDrive: null,
          },
          sites: allSharePointSites,
          deletedSites: [],
          availability: {
            inventory: sharePointSitesResult.status === 'fulfilled',
            usage: sharePointUsageResult.status === 'fulfilled',
            oneDriveUsage: oneDriveUsageResult.status === 'fulfilled',
            adminSettings: false,
            deletedSites: false,
          },
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

      return bundle
      }

      const bundle = await withTimeout(fetchBundle(), 40000, 'Overall bundle request')

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
