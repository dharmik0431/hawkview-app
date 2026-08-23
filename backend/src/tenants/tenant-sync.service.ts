import {
  BadRequestException,
  BadGatewayException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common'
import type { AuthenticatedIdentity } from '../auth/auth.types.js'
import { MicrosoftConsentService } from '../microsoft/microsoft-consent.service.js'
import {
  classifyMicrosoftFailure,
  customerCollectionFailureMessage,
  fetchMicrosoftWithRetry,
  MicrosoftRequestError,
} from '../microsoft/microsoft-request.js'
import { getMicrosoftSkuName } from '../microsoft/microsoft-sku-names.js'
import { Prisma } from '../generated/prisma/client.js'
import { PrismaService } from '../prisma/prisma.service.js'
import { NotificationsService } from '../notifications/notifications.service.js'
import { resolveDomainDnsHealth } from './domain-dns-health.js'
import {
  collectGroupMemberships,
  collectGroupOwners,
  uniquePrincipalLabels,
} from './group-membership-sync.js'
import {
  IpGeolocationService,
  type SignInLocation,
} from './ip-geolocation.service.js'
import { getMicrosoftSecureScore } from './secure-score.util.js'
import { deriveTenantSyncFreshness } from './service-sync-freshness.js'
import {
  deriveAuditReconciliationResources,
  type AuditReconciliationResource,
} from './audit-change-reconciliation.js'
import { ChangeEvidenceService, redactSensitiveValues } from '../changes/change-evidence.service.js'
import { bytesToGigabytes, deriveCollectionFieldState } from './collection-field-state.js'
import { sanitizeHealthMessage } from './sanitize-health-message.js'
import {
  deriveSignInEntitlement,
  type SignInEntitlement,
} from './sign-in-entitlement.js'
import { buildSharePointDataContract } from './sharepoint-data-contract.js'
import {
  exchangeMailboxRuleCompoundId,
  projectExchangeMailboxRuleDetails,
  safeExchangeMailboxRuleCollectedAt,
  safeExchangeMailboxRuleText,
  summarizeExchangeMailboxRuleActions,
} from './exchange-mailbox-rule-details.js'
import {
  projectExchangeReadOnlyPage,
  type ExchangeReadOnlyMailbox,
} from './exchange-readonly-projection.js'
import {
  buildRelatedExchangeRuleAuditResponse,
  normalizeRelatedExchangeRuleAuditRequest,
  RELATED_EXCHANGE_RULE_AUDIT_CANDIDATE_LIMIT,
  RELATED_EXCHANGE_RULE_AUDIT_OPERATIONS,
  RELATED_EXCHANGE_RULE_AUDIT_WINDOW_DAYS,
} from './exchange-rule-related-audit.js'
import {
  DAILY_INVENTORY_ANCHORS,
  requiresDailyInventoryRefresh,
  scheduledSyncTenantWhere,
  selectScheduledTenantWork,
  shouldRunTargetedTransientRetry,
  TARGETED_TRANSIENT_RETRY_RESOURCES,
  TENANT_SYNC_LEASE_MS,
} from './scheduled-sync-selection.js'
import {
  M365ManagementActivityService,
  m365AuditUsageDate,
  m365AuditUsageLimits,
  validateManagementUrl,
} from './m365-management-activity.service.js'

const USER_SELECT =
  'id,displayName,userPrincipalName,mail,accountEnabled,userType,assignedLicenses'
const MANAGEMENT_ACTIVITY_SOURCE = 'MICROSOFT_365_MANAGEMENT_ACTIVITY'
const MANAGEMENT_ACTIVITY_MAX_LOOKBACK_DAYS = 7
const DEFAULT_FAST_MAILBOX_RULE_REFRESH_MINUTES = 15
const DEFAULT_FAST_MAILBOX_RULE_MAX_USERS = 250
/** Hard ceilings keep a targeted SharePoint retry below the 15 minute USERS lease. */
export const SHAREPOINT_COLLECTION_LIMITS = Object.freeze({
  sitePages: 50,
  sites: 10_000,
  siteUserPages: 20,
  siteUserRecords: 50_000,
  responseBytes: 5 * 1024 * 1024,
  requestTimeoutMs: 20_000,
  collectorDeadlineMs: 10 * 60_000,
})

export const NON_PREMIUM_AUTH_REGISTRATION_ERROR_CODE =
  'Authentication_RequestFromNonPremiumTenantOrB2CTenant'

/**
 * An upstream dependency is still being provisioned. This is an expected,
 * retryable lifecycle state, not a failed collection attempt.
 */
export class CollectionInitializingError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'CollectionInitializingError'
  }
}

/**
 * A bounded secondary source completed successfully, but it is not equivalent
 * to the workload's preferred authoritative source. Persist fresh evidence
 * while keeping readiness explicitly partial.
 */
export class CollectionPartialError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'CollectionPartialError'
  }
}

export type AuthRegistrationFallbackLimits = {
  batchSize: number
  maxUserPages: number
  maxUsers: number
  maxBatches: number
  responseBytes: number
  requestTimeoutMs: number
  collectorDeadlineMs: number
}

/**
 * The non-premium fallback is intentionally bounded below the tenant-wide
 * scheduler lease. Microsoft Graph JSON batches accept at most 20 requests,
 * so 20,000 users is a hard 1,000-request ceiling rather than an unbounded
 * per-user loop.
 */
export const AUTH_REGISTRATION_FALLBACK_LIMITS: Readonly<AuthRegistrationFallbackLimits> = Object.freeze({
  batchSize: 20,
  maxUserPages: 50,
  maxUsers: 20_000,
  maxBatches: 1_000,
  responseBytes: 2 * 1024 * 1024,
  requestTimeoutMs: 30_000,
  collectorDeadlineMs: 10 * 60_000,
})

function assertAuthRegistrationFallbackLimits(
  limits: Readonly<AuthRegistrationFallbackLimits>,
) {
  const positiveIntegers = [
    limits.batchSize,
    limits.maxUserPages,
    limits.maxUsers,
    limits.maxBatches,
    limits.responseBytes,
    limits.requestTimeoutMs,
    limits.collectorDeadlineMs,
  ]
  if (
    positiveIntegers.some(
      (value) => !Number.isSafeInteger(value) || value <= 0,
    ) ||
    limits.batchSize > 20
  ) {
    throw new Error(
      'Microsoft per-user authentication-method synchronization has an invalid bounded collection configuration.',
    )
  }
}

/**
 * The only durable tenant-wide lease used by the scheduler and manual sync.
 * Keeping this compare-and-set in one helper makes a test exercise the exact
 * updateMany/create race used by syncConnectedTenant rather than a parallel
 * in-memory lock model.
 */
export async function claimTenantUsersLease(
  prisma: any,
  tenant: { id: string; organizationId: string },
  now = new Date(),
) {
  const existingState = await prisma.syncState.findUnique({
    where: { customerTenantId_resourceType: { customerTenantId: tenant.id, resourceType: 'USERS' } },
  })
  const staleLeaseBefore = new Date(now.getTime() - TENANT_SYNC_LEASE_MS)
  if (existingState) {
    const claim = await prisma.syncState.updateMany({
      where: {
        id: existingState.id,
        OR: [
          { status: { not: 'RUNNING' } },
          { lastAttemptAt: null },
          { lastAttemptAt: { lt: staleLeaseBefore } },
        ],
      },
      data: { status: 'RUNNING', lastAttemptAt: now, lastErrorCode: null, lastErrorMessage: null },
    })
    return { claimed: claim.count === 1, existingState }
  }
  try {
    await prisma.syncState.create({
      data: { organizationId: tenant.organizationId, customerTenantId: tenant.id, resourceType: 'USERS', status: 'RUNNING', lastAttemptAt: now },
    })
    return { claimed: true, existingState: null }
  } catch (error) {
    const competingClaim = await prisma.syncState.findUnique({
      where: { customerTenantId_resourceType: { customerTenantId: tenant.id, resourceType: 'USERS' } },
      select: { id: true },
    })
    if (!competingClaim) throw error
    return { claimed: false, existingState: null }
  }
}
/**
 * These collectors anchor the daily full-inventory run. They are deliberately
 * separate from the five-minute users/activity delta loop.
 */
const AUTH_METHOD_NAMES: Record<string, string> = {
  fido2: 'Passkey (FIDO2)',
  microsoftAuthenticator: 'Microsoft Authenticator',
  sms: 'SMS',
  temporaryAccessPass: 'Temporary Access Pass',
  email: 'Email OTP',
  x509Certificate: 'Certificate-based authentication',
  voice: 'Voice call',
  softwareOath: 'Software OATH token',
  hardwareOath: 'Hardware OATH token',
  qrCodePin: 'QR code PIN',
}

function boundedPositiveInteger(
  value: string | undefined,
  fallback: number,
  maximum: number
) {
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed > 0
    ? Math.min(parsed, maximum)
    : fallback
}

export type MailboxRuleRefreshState = {
  status: string
  lastAttemptAt: Date | null
  lastSuccessfulAt: Date | null
} | null

export function shouldRunFastMailboxRuleRefresh(input: {
  state: MailboxRuleRefreshState
  activeMailboxUsers: number
  now: Date
  intervalMinutes?: number
  maximumUsers?: number
}) {
  const intervalMinutes = Math.max(
    1,
    input.intervalMinutes ?? DEFAULT_FAST_MAILBOX_RULE_REFRESH_MINUTES
  )
  const maximumUsers = Math.max(
    1,
    input.maximumUsers ?? DEFAULT_FAST_MAILBOX_RULE_MAX_USERS
  )
  if (input.activeMailboxUsers > maximumUsers) return false

  const reference = input.state?.status === 'FAILED'
    ? input.state.lastAttemptAt
    : input.state?.lastSuccessfulAt
  return !reference ||
    input.now.getTime() - reference.getTime() >= intervalMinutes * 60_000
}

function formatAuthenticationMethodName(id: unknown) {
  if (typeof id !== 'string' || !id) return 'Authentication method'
  return AUTH_METHOD_NAMES[id] ?? id.replace(/([a-z])([A-Z])/g, '$1 $2')
}

function summarizeAuthenticationMethodTargets(method: any) {
  const targets = Array.isArray(method?.includeTargets)
    ? method.includeTargets
    : []
  if (targets.some((target: any) => target?.id === 'all_users')) {
    return 'All users'
  }
  const ids = targets
    .map((target: any) => target?.id)
    .filter((id: unknown): id is string => typeof id === 'string')
  return ids.length > 0
    ? `${ids.length} selected group(s)`
    : 'No users targeted'
}

function parseCsvRows(csv: string): Record<string, string>[] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false

  for (let index = 0; index < csv.length; index += 1) {
    const character = csv[index]
    if (character === '"') {
      if (quoted && csv[index + 1] === '"') {
        field += '"'
        index += 1
      } else {
        quoted = !quoted
      }
    } else if (character === ',' && !quoted) {
      row.push(field)
      field = ''
    } else if ((character === '\n' || character === '\r') && !quoted) {
      if (character === '\r' && csv[index + 1] === '\n') index += 1
      row.push(field)
      if (row.some((value) => value.length > 0)) rows.push(row)
      row = []
      field = ''
    } else {
      field += character
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field)
    rows.push(row)
  }

  const [rawHeaders, ...values] = rows
  if (!rawHeaders) return []
  const headers = rawHeaders.map((header, index) =>
    (index === 0 ? header.replace(/^\uFEFF/, '') : header).trim()
  )
  return values.map((columns) =>
    Object.fromEntries(
      headers.map((header, index) => [header, columns[index]?.trim() ?? ''])
    )
  )
}

/**
 * Microsoft usage reports use human-readable CSV headers and can use a UPN,
 * primary SMTP address, or proxy address for the same mailbox. Normalize those
 * values once so enrichment never depends on a particular report header or
 * address casing.
 */
function normalizeExchangeIdentity(value: unknown) {
  if (typeof value !== 'string') return ''
  return value.trim().replace(/^smtp:/i, '').toLowerCase()
}

function usageValue(row: Record<string, string> | undefined, ...names: string[]) {
  if (!row) return undefined
  const expected = new Set(names.map((name) => name.trim().toLowerCase()))
  for (const [key, value] of Object.entries(row)) {
    if (expected.has(key.trim().toLowerCase())) return value
  }
  return undefined
}

function parseUsageNumber(value: unknown) {
  if (typeof value !== 'string' || !value.trim()) return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function parseUsageBoolean(value: unknown) {
  if (typeof value !== 'string') return null
  if (/^(yes|true|active)$/i.test(value.trim())) return true
  if (/^(no|false|inactive)$/i.test(value.trim())) return false
  return null
}

export function graphMailboxPurposeToType(value: unknown) {
  const purpose =
    value && typeof value === 'object' && 'value' in value
      ? (value as { value?: unknown }).value
      : value
  switch (String(purpose ?? '').trim().toLowerCase()) {
    case 'shared':
      return 'Shared'
    case 'room':
      return 'Room'
    case 'equipment':
      return 'Equipment'
    case 'user':
    case 'linked':
      return 'User'
    default:
      return null
  }
}

function normalizeSharePointUrl(value: unknown) {
  if (typeof value !== 'string') return ''
  const raw = value.trim()
  if (!raw) return ''
  try {
    const url = new URL(raw)
    url.hash = ''
    url.search = ''
    return decodeURIComponent(url.toString())
      .replace(/\/$/, '')
      .toLowerCase()
  } catch {
    return raw.replace(/[?#].*$/, '').replace(/\/$/, '').toLowerCase()
  }
}

function normalizeSharePointSiteId(value: unknown) {
  if (typeof value !== 'string') return ''
  return value.trim().replace(/[{}]/g, '').toLowerCase()
}

function isCustomerFacingSharePointSite(site: any) {
  const url = normalizeSharePointUrl(site?.webUrl)
  if (!url) return true
  return !(
    url.includes('/contentstorage/') ||
    url.endsWith('/sites/contenttypehub') ||
    url.includes('/sites/contenttypehub/')
  )
}

function managementActivityExtendedProperty(record: any, ...names: string[]) {
  const expected = new Set(names.map((name) => name.toLowerCase()))
  const property = (
    Array.isArray(record?.ExtendedProperties) ? record.ExtendedProperties : []
  ).find(
    (item: any) =>
      typeof item?.Name === 'string' && expected.has(item.Name.toLowerCase())
  )
  return property?.Value
}

function isManagementActivityLogin(record: any) {
  const recordType = Number(record?.RecordType)
  if (recordType === 9 || recordType === 15) return true
  const operation = String(record?.Operation ?? '').toLowerCase()
  return /(login|logon|sign.?in)/.test(operation)
}

function managementActivityLoginSucceeded(record: any) {
  const loginStatus =
    record?.LoginStatus ??
    managementActivityExtendedProperty(record, 'LoginStatus')
  if (loginStatus !== undefined && loginStatus !== null && loginStatus !== '') {
    return Number(loginStatus) === 0
  }
  const errorCode =
    record?.ErrorCode ?? managementActivityExtendedProperty(record, 'ErrorCode')
  if (errorCode !== undefined && errorCode !== null && errorCode !== '') {
    return Number(errorCode) === 0
  }
  if (String(record?.Operation ?? '') === 'UserLoggedIn') return true
  return ['success', 'succeeded'].includes(
    String(record?.ResultStatus ?? '').toLowerCase()
  )
}

interface GraphUser {
  id?: string
  displayName?: string | null
  userPrincipalName?: string | null
  mail?: string | null
  accountEnabled?: boolean | null
  userType?: string | null
  assignedLicenses?: Array<{ skuId?: string | null }> | null
  '@removed'?: { reason?: string }
}

interface GraphUsersPage {
  value?: GraphUser[]
  '@odata.nextLink'?: string
  '@odata.deltaLink'?: string
}

interface GraphSubscribedSku {
  skuId?: string
  skuPartNumber?: string | null
  consumedUnits?: number | null
  capabilityStatus?: string | null
  prepaidUnits?: {
    enabled?: number | null
    warning?: number | null
    suspended?: number | null
    lockedOut?: number | null
  } | null
  servicePlans?: Array<{
    servicePlanId?: string | null
    servicePlanName?: string | null
    provisioningStatus?: string | null
    appliesTo?: string | null
  }> | null
}

function boundedServicePlans(value: GraphSubscribedSku['servicePlans']) {
  if (!Array.isArray(value)) return null
  const plans = value.slice(0, 128).flatMap((plan) => {
    if (!plan || typeof plan !== 'object') return []
    const servicePlanId = typeof plan.servicePlanId === 'string' ? plan.servicePlanId.trim().slice(0, 80) : ''
    const servicePlanName = typeof plan.servicePlanName === 'string' ? plan.servicePlanName.trim().slice(0, 120) : ''
    const provisioningStatus = typeof plan.provisioningStatus === 'string' ? plan.provisioningStatus.trim().slice(0, 50) : ''
    const appliesTo = typeof plan.appliesTo === 'string' ? plan.appliesTo.trim().slice(0, 50) : ''
    return servicePlanId && servicePlanName && provisioningStatus ? [{ servicePlanId, servicePlanName, provisioningStatus, ...(appliesTo ? { appliesTo } : {}) }] : []
  })
  return plans.sort((left, right) => `${left.servicePlanId}:${left.servicePlanName}`.localeCompare(`${right.servicePlanId}:${right.servicePlanName}`))
}

interface GraphOrganization {
  id?: string | null
  tenantId?: string | null
  displayName?: string | null
  verifiedDomains?: Array<{
    name?: string | null
    isDefault?: boolean | null
    isInitial?: boolean | null
    capabilities?: string | null
    type?: string | null
  }>
}

type MailboxRuleUser = { microsoftUserId: string; userPrincipalName: string }

/**
 * A snapshot baseline may only advance after a collector can attest that its
 * response is complete. This avoids treating an interrupted or bounded read
 * as a destructive inventory deletion.
 */
export type SnapshotCollectionResult = {
  rows: unknown[]
  completeness: 'authoritative_complete' | 'partial_or_unknown'
}

export const authoritativeSnapshot = (rows: unknown[]): SnapshotCollectionResult => ({
  rows,
  completeness: 'authoritative_complete',
})

export const partialSnapshot = (rows: unknown[]): SnapshotCollectionResult => ({
  rows,
  completeness: 'partial_or_unknown',
})

/**
 * Standard HawkView SharePoint collection is Graph-only.  Site-user and SCA
 * metadata would require a SharePoint resource token and broad site control,
 * so it is deliberately not part of the authoritative inventory contract.
 */

/**
 * Group definitions and their owner/member relationship refreshes have
 * different authority boundaries. Definitions may be safely snapshotted from
 * /groups, but any failed relationship collection must still surface as a
 * partial GROUPS synchronization rather than a successful one.
 */
export function assertGroupRelationshipRefreshComplete(
  ownerFailures: number,
  membershipFailures: number
) {
  if (ownerFailures > 0 || membershipFailures > 0) {
    throw new Error(
      `Microsoft group definitions synchronized, but relationship refresh was incomplete (${ownerFailures} owner and ${membershipFailures} membership failure(s)). Existing relationships were retained for failed groups.`
    )
  }
}

export type MailboxPaginationBounds = {
  pageSize?: number
  maxPages?: number
  maxRecords?: number
}

const DEFAULT_MAILBOX_USER_PAGE_SIZE = 250
const DEFAULT_MAX_MAILBOX_USER_PAGES = 1_000
const DEFAULT_MAX_MAILBOX_USERS = 100_000
const DEFAULT_MAX_RULE_PAGES_PER_MAILBOX = 100
const DEFAULT_MAX_RULES_PER_MAILBOX = 10_000

/**
 * Follows a Graph collection cursor with explicit termination bounds.  This
 * is intentionally separate from the local-directory paginator above: Graph
 * next links are opaque and a unique, never-ending link chain is still an
 * incomplete collection rather than a reason to advance a destructive
 * baseline.
 */
export async function collectMailboxDirectoryPages(
  initialUrl: string,
  loadPage: (nextUrl: string) => Promise<GraphCollectionPage>,
  bounds: MailboxPaginationBounds = {}
) {
  const maxPages = bounds.maxPages ?? DEFAULT_MAX_MAILBOX_USER_PAGES
  const maxRecords = bounds.maxRecords ?? DEFAULT_MAX_MAILBOX_USERS
  const rows: unknown[] = []
  const seen = new Set<string>()
  let nextUrl: string | null = initialUrl
  let pageNumber = 0

  while (nextUrl) {
    if (pageNumber >= maxPages) {
      throw new Error(
        `Mailbox directory exceeded the ${maxPages}-page safety limit; baseline was not advanced.`
      )
    }
    if (seen.has(nextUrl)) {
      throw new Error(
        'Microsoft returned a repeated mailbox directory pagination link; baseline was not advanced.'
      )
    }
    seen.add(nextUrl)
    const page = await loadPage(nextUrl)
    pageNumber += 1
    rows.push(...(page.value ?? []))
    if (rows.length > maxRecords) {
      throw new Error(
        `Mailbox directory exceeded the ${maxRecords}-record safety limit; baseline was not advanced.`
      )
    }
    nextUrl =
      typeof page['@odata.nextLink'] === 'string'
        ? page['@odata.nextLink']
        : null
  }

  return rows
}

/** Paginates the local recipient inventory; no tenant is silently capped. */
export async function collectMailboxRuleUsers(
  loadPage: (skip: number, take: number) => Promise<MailboxRuleUser[]>,
  bounds: MailboxPaginationBounds = {}
) {
  const pageSize = bounds.pageSize ?? DEFAULT_MAILBOX_USER_PAGE_SIZE
  const maxPages = bounds.maxPages ?? DEFAULT_MAX_MAILBOX_USER_PAGES
  const maxRecords = bounds.maxRecords ?? DEFAULT_MAX_MAILBOX_USERS
  const users: MailboxRuleUser[] = []
  for (let pageNumber = 0, skip = 0; ; pageNumber += 1, skip += pageSize) {
    if (pageNumber >= maxPages) {
      throw new Error(`Mailbox recipient inventory exceeded the ${maxPages}-page safety limit; baseline was not advanced.`)
    }
    const page = await loadPage(skip, pageSize)
    users.push(...page)
    if (users.length > maxRecords) {
      throw new Error(`Mailbox recipient inventory exceeded the ${maxRecords}-record safety limit; baseline was not advanced.`)
    }
    if (page.length < pageSize) return users
  }
}

/** Follows Graph next links and retains the mailbox part of each rule identity. */
export async function collectMailboxRules(
  users: MailboxRuleUser[],
  loadPage: (user: MailboxRuleUser, nextUrl: string | null) => Promise<GraphCollectionPage>,
  batchSize = 5,
  bounds: MailboxPaginationBounds = {}
) {
  const maxPages = bounds.maxPages ?? DEFAULT_MAX_RULE_PAGES_PER_MAILBOX
  const maxRecords = bounds.maxRecords ?? DEFAULT_MAX_RULES_PER_MAILBOX
  const rows: unknown[] = []
  for (let index = 0; index < users.length; index += batchSize) {
    const results = await Promise.all(users.slice(index, index + batchSize).map(async (user) => {
      const mailboxRows: unknown[] = []
      let nextUrl: string | null = null
      const seen = new Set<string>()
      let pageNumber = 0
      do {
        if (pageNumber >= maxPages) {
          throw new Error(`Inbox rules for ${user.userPrincipalName} exceeded the ${maxPages}-page safety limit; baseline was not advanced.`)
        }
        const page = await loadPage(user, nextUrl)
        pageNumber += 1
        mailboxRows.push(...(page.value ?? []).map((rule: any) => ({
          ...rule,
          mailboxUserId: user.microsoftUserId,
          mailboxUpn: user.userPrincipalName,
        })))
        if (mailboxRows.length > maxRecords) {
          throw new Error(`Inbox rules for ${user.userPrincipalName} exceeded the ${maxRecords}-record safety limit; baseline was not advanced.`)
        }
        const candidate = typeof page['@odata.nextLink'] === 'string' ? page['@odata.nextLink'] : null
        if (candidate && seen.has(candidate)) throw new Error('Microsoft returned a repeated inbox-rules pagination link.')
        if (candidate) seen.add(candidate)
        nextUrl = candidate
      } while (nextUrl)
      return mailboxRows
    }))
    rows.push(...results.flat())
  }
  return rows
}

interface GraphGroup {
  id?: string
  displayName?: string | null
  description?: string | null
  mail?: string | null
  mailNickname?: string | null
  mailEnabled?: boolean | null
  securityEnabled?: boolean | null
  groupTypes?: string[] | null
  visibility?: string | null
  onPremisesSyncEnabled?: boolean | null
  owners?: Array<{
    id?: string
    displayName?: string | null
    userPrincipalName?: string | null
  }>
}

interface GraphGroupsPage {
  value?: GraphGroup[]
  '@odata.nextLink'?: string
}

interface GraphGroupMembersPage {
  value?: Array<{ id?: string }>
  '@odata.nextLink'?: string
}

type EntraSnapshotResource =
  | 'LICENSES'
  | 'ORGANIZATION_CONFIGURATION'
  | 'DOMAINS'
  | 'AUTH_REGISTRATIONS'
  | 'AUTH_METHOD_POLICIES'
  | 'CONDITIONAL_ACCESS'
  | 'NAMED_LOCATIONS'
  | 'DEVICES'
  | 'DIRECTORY_ROLES'
  | 'SERVICE_PRINCIPALS'
  | 'APPLICATIONS'
  | 'SECURE_SCORES'
  | 'SECURITY_DEFAULTS'
  | 'GROUPS'
  | 'SHAREPOINT_SITES'
  | 'SHAREPOINT_SETTINGS'
  | 'SHAREPOINT_USAGE'
  | 'EXCHANGE_MAILBOXES'
  | 'EXCHANGE_MAILBOX_SETTINGS'
  | 'EXCHANGE_MAILBOX_CONFIGURATION'
  | 'EXCHANGE_MAILBOX_USAGE'
  | 'EXCHANGE_ACCEPTED_DOMAINS'
  | 'EXCHANGE_MAILBOX_RULES'
  | 'DOMAIN_DNS_HEALTH'

interface GraphCollectionPage {
  value?: unknown[]
  '@odata.nextLink'?: string
}

interface GraphBatchResponse {
  responses?: Array<{
    id?: string
    status?: number
    body?: Record<string, unknown>
  }>
}

type PerUserMfaState = 'disabled' | 'enabled' | 'enforced'

export function normalizePerUserMfaState(value: unknown): PerUserMfaState | null {
  return value === 'disabled' || value === 'enabled' || value === 'enforced'
    ? value
    : null
}

export function projectMfaTruth(registration: unknown) {
  const row = plainRecord(registration) ? registration : null
  const isRegistered =
    typeof row?.isMfaRegistered === 'boolean'
      ? row.isMfaRegistered
      : null
  const perUserState = normalizePerUserMfaState(row?.perUserMfaState)
  return {
    // Deprecated compatibility alias. This has always represented method
    // registration, not MFA enforcement or the legacy per-user requirement.
    mfa:
      isRegistered === null
        ? 'Unknown'
        : isRegistered
          ? 'Enabled'
          : 'Disabled',
    mfaRegistration:
      isRegistered === null
        ? 'Unknown'
        : isRegistered
          ? 'Registered'
          : 'Not registered',
    perUserMfaState:
      perUserState === 'enabled'
        ? 'Enabled'
        : perUserState === 'enforced'
          ? 'Enforced'
          : perUserState === 'disabled'
            ? 'Disabled'
            : 'Unknown',
    mfaRegistrationSource:
      isRegistered === null
        ? null
        : row?.collectionSource === 'per-user-authentication-methods'
          ? 'microsoft-graph-authentication-methods'
          : 'microsoft-graph-user-registration-details',
    perUserMfaStateSource:
      perUserState === null
        ? null
        : 'microsoft-graph-beta-authentication-requirements',
  }
}

function sanitizeGraphErrorField(value: unknown, maxLength: number) {
  if (typeof value !== 'string') return null
  // Microsoft error payloads can include NUL/control characters. PostgreSQL
  // rejects NUL bytes in text columns, so remove them before persistence.
  const sanitized = value
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, ' ')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return sanitized ? sanitized.slice(0, maxLength) : null
}

function safeErrorMessage(error: unknown, fallback: string, maxLength = 2000) {
  const raw = error instanceof Error ? error.message : fallback
  // Operational failures are persisted and logged. Apply the same strict
  // allowlisted diagnostic projection used by tenant-health before either
  // sink receives a message; truncation/control stripping alone leaks tokens.
  const sanitized = sanitizeHealthMessage(raw, fallback)
  return sanitizeGraphErrorField(sanitized, maxLength) ?? fallback
}

function plainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

export function graphErrorCodeFromBody(body: string) {
  if (!body || body.length > 32 * 1024) return null
  try {
    const parsed = JSON.parse(body) as unknown
    if (!plainRecord(parsed) || !plainRecord(parsed.error)) return null
    const code = parsed.error.code
    if (typeof code !== 'string' || !/^[A-Za-z0-9_.-]{1,128}$/.test(code)) {
      return null
    }
    return code
  } catch {
    return null
  }
}

async function readBoundedResponseText(
  response: Response,
  maximumBytes: number,
) {
  const declaredLength = Number(response.headers.get('content-length') ?? '0')
  if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) {
    throw new Error('Microsoft Graph error response exceeded the bounded response-size limit.')
  }
  if (!response.body) {
    const text = await response.text()
    if (new TextEncoder().encode(text).byteLength > maximumBytes) {
      throw new Error('Microsoft Graph error response exceeded the bounded response-size limit.')
    }
    return text
  }
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (!value) continue
      total += value.byteLength
      if (total > maximumBytes) {
        await reader.cancel('Microsoft Graph error response exceeded bounded limit')
        throw new Error('Microsoft Graph error response exceeded the bounded response-size limit.')
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder().decode(bytes)
}

export async function readGraphOperationalError(
  response: Response,
  maximumBytes = 32 * 1024,
) {
  try {
    const body = await readBoundedResponseText(response, maximumBytes)
    const code = graphErrorCodeFromBody(body)
    const projected = sanitizeHealthMessage(body, '')
    const safe = code && (!projected || projected.includes('[REDACTED STRUCTURED ERROR]'))
      ? JSON.stringify({ code })
      : projected
    return { code, suffix: safe ? ` [${safe}]` : '' }
  } catch (error) {
    const safe = safeErrorMessage(
      error,
      'Microsoft Graph returned an unreadable error response.',
      300,
    )
    return { code: null, suffix: safe ? ` [${safe}]` : '' }
  }
}

export class MicrosoftGraphCollectionError extends MicrosoftRequestError {
  constructor(
    message: string,
    readonly status: number,
    readonly graphErrorCode: string | null,
    requestId: string | null = null,
  ) {
    super(message, status, graphErrorCode, requestId)
    this.name = 'MicrosoftGraphCollectionError'
  }
}

export function assertSharePointResponseSize(
  response: Response,
  maximumBytes = SHAREPOINT_COLLECTION_LIMITS.responseBytes,
) {
  const contentLength = Number(response.headers.get('content-length') ?? '0')
  if (Number.isFinite(contentLength) && contentLength > maximumBytes) {
    throw new Error('SharePoint response exceeded the bounded collection response-size limit.')
  }
}

/**
 * Content-Length is only an early rejection hint.  Count the streamed body so
 * a missing or dishonest header cannot bypass the SharePoint collector cap.
 */
export async function readBoundedSharePointJson(
  response: Response,
  maximumBytes = SHAREPOINT_COLLECTION_LIMITS.responseBytes,
): Promise<unknown> {
  assertSharePointResponseSize(response, maximumBytes)
  if (!response.body) return response.json()
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (!value) continue
      total += value.byteLength
      if (total > maximumBytes) {
        await reader.cancel('SharePoint response exceeded bounded limit')
        throw new Error('SharePoint response exceeded the bounded collection response-size limit.')
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
  return JSON.parse(new TextDecoder().decode(bytes))
}

function sharePointRequestTimeout(
  deadlineAt: number,
  requestTimeoutMs = SHAREPOINT_COLLECTION_LIMITS.requestTimeoutMs,
) {
  const remaining = deadlineAt - Date.now()
  if (remaining <= 0) throw new Error('SharePoint collection exceeded its bounded wall-clock deadline before completion.')
  return Math.min(requestTimeoutMs, remaining)
}

const LOG_RETENTION_MONTHS = 6
const INITIAL_LOG_LOOKBACK_DAYS = 30
const LOG_SYNC_OVERLAP_MINUTES = 10

function logExpirationDate(ingestedAt: Date) {
  const expiresAt = new Date(ingestedAt)
  expiresAt.setUTCMonth(expiresAt.getUTCMonth() + LOG_RETENTION_MONTHS)
  return expiresAt
}

interface TenantSyncTarget {
  id: string
  organizationId: string
  microsoftTenantId: string
  displayName: string | null
  primaryDomain: string | null
  status: string
  connection: {
    status: string
    connectionMode: string
    clientId: string | null
    credentialReference: string | null
    lastVerifiedAt: Date | null
    exchangeReadOnlyEnabledAt: Date | null
  } | null
}

type GraphOrganizationConfigurationResponse = {
  value?: Array<{ id?: unknown; displayName?: unknown }>
}

/**
 * Graph's /organization result is an authority boundary.  A token issued for
 * the wrong customer tenant must never establish or replace this tenant's
 * snapshot baseline, even if Graph returned an otherwise valid organization.
 */
export function organizationConfigurationSnapshotForTenant(
  expectedMicrosoftTenantId: string,
  body: GraphOrganizationConfigurationResponse | null | undefined,
) {
  const expectedId = expectedMicrosoftTenantId.trim().toLowerCase()
  const organizations = Array.isArray(body?.value) ? body.value : []
  if (!expectedId || organizations.length !== 1) {
    throw new Error('Microsoft did not return one authoritative organization record.')
  }
  const organization = organizations[0]
  const returnedId = typeof organization?.id === 'string' ? organization.id.trim() : ''
  if (!returnedId || returnedId.toLowerCase() !== expectedId) {
    throw new Error('Microsoft organization identifier does not match the connected tenant.')
  }
  return {
    id: expectedMicrosoftTenantId,
    tenantId: expectedMicrosoftTenantId,
    displayName: typeof organization.displayName === 'string' && organization.displayName.trim()
      ? organization.displayName.trim()
      : null,
  }
}

@Injectable()
export class TenantSyncService {
  private readonly logger = new Logger(TenantSyncService.name)

  constructor(
    @Inject(PrismaService)
    private readonly prisma: PrismaService,
    @Inject(MicrosoftConsentService)
    private readonly microsoftConsent: MicrosoftConsentService,
    @Inject(IpGeolocationService)
    private readonly ipGeolocation: IpGeolocationService,
    @Inject(NotificationsService)
    private readonly notifications: NotificationsService,
    @Inject(ChangeEvidenceService)
    private readonly changeEvidence: ChangeEvidenceService,
    @Inject(M365ManagementActivityService)
    private readonly m365ManagementActivity: M365ManagementActivityService
  ) {}

  private async getReadableTenant(
    identity: AuthenticatedIdentity,
    customerTenantId: string
  ) {
    const user = await this.prisma.user.findUnique({
      where: { authProviderUserId: identity.subject },
      select: {
        disabledAt: true,
        memberships: {
          where: {
            status: 'ACTIVE',
            organization: { status: 'ACTIVE' },
          },
          select: { organizationId: true },
        },
      },
    })
    if (!user || user.disabledAt) {
      throw new ForbiddenException(
        'This HawkView account cannot access tenants.'
      )
    }

    const tenant = await this.prisma.customerTenant.findFirst({
      where: {
        id: customerTenantId,
        organizationId: { in: user.memberships.map((membership) => membership.organizationId) },
      },
      select: {
        id: true,
        organizationId: true,
        microsoftTenantId: true,
        displayName: true,
        primaryDomain: true,
        status: true,
        connection: {
          select: {
            status: true,
            connectionMode: true,
            clientId: true,
            credentialReference: true,
            lastVerifiedAt: true,
            exchangeReadOnlyEnabledAt: true,
          },
        },
      },
    })
    if (!tenant) throw new NotFoundException('Customer tenant was not found.')
    return tenant
  }

  async getBundleForIdentity(
    identity: AuthenticatedIdentity,
    customerTenantId: string
  ) {
    const tenant = await this.getReadableTenant(identity, customerTenantId)
    return this.buildBundle(tenant)
  }

  async getRelatedExchangeRuleAuditForIdentity(
    identity: AuthenticatedIdentity,
    customerTenantId: string,
    mailboxUpn: unknown,
    ruleName: unknown,
  ) {
    const tenant = await this.getReadableTenant(identity, customerTenantId)
    const request = normalizeRelatedExchangeRuleAuditRequest(mailboxUpn, ruleName)
    if (!request) {
      throw new BadRequestException('A valid mailbox UPN and optional rule name are required.')
    }

    const now = new Date()
    const windowStart = new Date(
      now.getTime() - RELATED_EXCHANGE_RULE_AUDIT_WINDOW_DAYS * 24 * 60 * 60 * 1_000
    )
    const rows = await this.prisma.m365AuditRecord.findMany({
      where: {
        organizationId: tenant.organizationId,
        customerTenantId: tenant.id,
        eventDateTime: { gte: windowStart, lte: now },
        expiresAt: { gt: now },
        operation: { in: [...RELATED_EXCHANGE_RULE_AUDIT_OPERATIONS] },
      },
      orderBy: { eventDateTime: 'desc' },
      take: RELATED_EXCHANGE_RULE_AUDIT_CANDIDATE_LIMIT + 1,
      select: {
        microsoftRecordId: true,
        eventDateTime: true,
        operation: true,
        actorId: true,
        objectId: true,
        result: true,
        raw: true,
      },
    })
    return buildRelatedExchangeRuleAuditResponse(
      rows.slice(0, RELATED_EXCHANGE_RULE_AUDIT_CANDIDATE_LIMIT),
      request,
      {
        now,
        candidateScanTruncated: rows.length > RELATED_EXCHANGE_RULE_AUDIT_CANDIDATE_LIMIT,
      },
    )
  }

  async syncUsersForIdentity(
    identity: AuthenticatedIdentity,
    customerTenantId: string
  ) {
    // Any active workspace member can refresh data for an existing tenant.
    // Tenant creation and deletion remain restricted by TenantsService.
    const tenant = await this.getReadableTenant(identity, customerTenantId)
    const result = await this.syncConnectedTenant(tenant, true)
    return result.bundle
  }

  async verifyExchangeReadOnlyForIdentity(
    identity: AuthenticatedIdentity,
    customerTenantId: string,
  ) {
    const tenant = await this.getReadableTenant(identity, customerTenantId)
    if (!tenant.connection) throw new BadRequestException('The Microsoft tenant connection is incomplete.')
    const accessToken = await this.microsoftConsent.getTenantExchangeAccessToken({
      microsoftTenantId: tenant.microsoftTenantId,
      connectionMode: tenant.connection.connectionMode === 'CUSTOMER_MANAGED'
        ? 'CUSTOMER_MANAGED'
        : 'HAWKVIEW_MANAGED',
      clientId: tenant.connection.clientId,
      credentialReference: tenant.connection.credentialReference,
    })
    const rows = await this.collectExchangeReadOnlyMailboxes(tenant, accessToken)
    const enabledAt = new Date()
    await this.saveSnapshot(
      tenant,
      'EXCHANGE_MAILBOX_CONFIGURATION',
      authoritativeSnapshot(rows),
      async (transaction) => {
        await transaction.tenantConnection.update({
          where: {
            customerTenantId_organizationId: {
              customerTenantId: tenant.id,
              organizationId: tenant.organizationId,
            },
          },
          data: { exchangeReadOnlyEnabledAt: enabledAt },
        })
      },
    )
    return {
      enabled: true,
      enabledAt: enabledAt.toISOString(),
      collectedMailboxes: rows.length,
      allowedCmdlets: ['Get-Mailbox'],
    }
  }

  async syncDueTenants() {
    const now = new Date()
    const limit = Math.max(
      1,
      Math.min(25, Number(process.env.SCHEDULED_SYNC_BATCH_SIZE ?? 10) || 10)
    )
    // Read a bounded fair-candidate window, then rank it by the due resource
    // state below.  `updatedAt` is intentionally not a scheduling signal:
    // a noisy tenant must not starve 1,000 other due tenants.
    const candidateLimit = Math.max(limit, Math.min(1_000, Number(process.env.SCHEDULED_SYNC_CANDIDATE_SCAN_LIMIT ?? 1_000) || 1_000))
    const candidateTenants = await this.prisma.customerTenant.findMany({
      where: scheduledSyncTenantWhere(now),
      orderBy: { id: 'asc' },
      take: candidateLimit,
      select: {
        id: true,
        organizationId: true,
        microsoftTenantId: true,
        displayName: true,
        primaryDomain: true,
        status: true,
        connection: {
          select: {
            status: true,
            connectionMode: true,
            clientId: true,
            credentialReference: true,
            lastVerifiedAt: true,
            exchangeReadOnlyEnabledAt: true,
          },
        },
        syncStates: {
          where: {
            resourceType: {
              in: [
                'USERS',
                ...DAILY_INVENTORY_ANCHORS,
                ...TARGETED_TRANSIENT_RETRY_RESOURCES,
              ],
            },
          },
          select: {
            resourceType: true,
            status: true,
            lastAttemptAt: true,
            lastSuccessfulAt: true,
            lastErrorCode: true,
            lastErrorMessage: true,
            consecutiveFailures: true,
          },
        },
      },
    })

    const selectedWork = selectScheduledTenantWork(candidateTenants, now, candidateLimit)
    const selectedById = new Map(selectedWork.map((work) => [work.tenantId, work]))
    const tenants = candidateTenants
      .filter((tenant) => selectedById.has(tenant.id))
      .sort((left, right) => {
        const leftWork = selectedById.get(left.id)!
        const rightWork = selectedById.get(right.id)!
        return leftWork.dueAt.getTime() - rightWork.dueAt.getTime() || left.id.localeCompare(right.id)
      })

    const results: Array<Record<string, unknown>> = []
    // A lock loser is not useful work. Continue through the fair candidate
    // window so another due tenant can use this run's bounded capacity.
    for (const tenant of tenants) {
      if (results.filter((result) => result.status !== 'SKIPPED').length >= limit) break
      try {
        // Keep the five-minute run lightweight, but run a full inventory once
        // per day (or retry a failed daily inventory anchor after an hour).
        // This prevents a tenant from remaining permanently stale unless an
        // administrator manually presses Sync Now.
        const fullInventoryDue = selectedById.get(tenant.id)?.fullInventoryDue ?? requiresDailyInventoryRefresh(tenant.syncStates, now)
        const result = await this.syncConnectedTenant(tenant, false, {
          incrementalOnly: !fullInventoryDue,
          includeBundle: false,
        })
        results.push({
          tenantId: tenant.id,
          microsoftTenantId: tenant.microsoftTenantId,
          status: result.status,
          syncMode: fullInventoryDue ? 'FULL_INVENTORY' : 'INCREMENTAL',
          failedResources: result.failedResources,
        })
      } catch (error) {
        results.push({
          tenantId: tenant.id,
          microsoftTenantId: tenant.microsoftTenantId,
          status: 'FAILED',
          error:
            error instanceof Error
              ? error.message.slice(0, 500)
              : 'Tenant synchronization failed.',
        })
      }
    }

    const summary = {
      checkedAt: new Date().toISOString(),
      due: tenants.length,
      succeeded: results.filter((result) => result.status === 'SUCCEEDED')
        .length,
      partial: results.filter((result) => result.status === 'PARTIAL').length,
      failed: results.filter((result) => result.status === 'FAILED').length,
      skipped: results.filter((result) => result.status === 'SKIPPED').length,
      results,
    }
    this.logger.log(
      `Scheduled tenant synchronization: ${JSON.stringify(summary)}`
    )
    return summary
  }

  /**
   * Keep between-inventory retries explicit and cheap. Every entry here is a
   * tenant-level collection protected by the existing USERS lease and the
   * scheduler's exponential backoff; adding a resource to the selection list
   * without an execution mapping must never silently run unrelated work.
   */
  private targetedTransientRetryModule(
    tenant: TenantSyncTarget,
    accessToken: string,
    resourceType: string,
  ): { resource: string; synchronize: () => Promise<unknown> } | null {
    const synchronizers: Partial<Record<string, () => Promise<unknown>>> = {
      LICENSES: () => this.syncLicenses(tenant, accessToken),
      ORGANIZATION_CONFIGURATION: () => this.syncOrganizationConfiguration(tenant, accessToken),
      DOMAINS: () => this.syncDomains(tenant, accessToken),
      GROUPS: () => this.syncGroups(tenant, accessToken),
      AUTH_METHOD_POLICIES: () => this.syncAuthenticationMethodPolicy(tenant, accessToken),
      CONDITIONAL_ACCESS: () => this.syncEntraCollection(
        tenant, accessToken, 'CONDITIONAL_ACCESS',
        'https://graph.microsoft.com/v1.0/identity/conditionalAccess/policies',
      ),
      NAMED_LOCATIONS: () => this.syncEntraCollection(
        tenant, accessToken, 'NAMED_LOCATIONS',
        'https://graph.microsoft.com/v1.0/identity/conditionalAccess/namedLocations',
      ),
      DEVICES: () => this.syncEntraCollection(
        tenant, accessToken, 'DEVICES',
        'https://graph.microsoft.com/v1.0/devices?$select=id,deviceId,displayName,operatingSystem,operatingSystemVersion,trustType,isCompliant,isManaged,accountEnabled,approximateLastSignInDateTime&$expand=registeredOwners($select=id)',
      ),
      DIRECTORY_ROLES: () => this.syncEntraCollection(
        tenant, accessToken, 'DIRECTORY_ROLES',
        'https://graph.microsoft.com/v1.0/roleManagement/directory/roleAssignments?$expand=roleDefinition($select=id,displayName)',
      ),
      SERVICE_PRINCIPALS: () => this.syncEntraCollection(
        tenant, accessToken, 'SERVICE_PRINCIPALS',
        'https://graph.microsoft.com/v1.0/servicePrincipals?$select=id,appId,displayName,description,servicePrincipalType,accountEnabled,appRoleAssignmentRequired,createdDateTime,homepage,loginUrl,publisherName,verifiedPublisher,tags,preferredSingleSignOnMode,notificationEmailAddresses,appRoles,oauth2PermissionScopes&$expand=appRoleAssignedTo($select=id,principalId,principalType,principalDisplayName,appRoleId)',
      ),
      APPLICATIONS: () => this.syncEntraCollection(
        tenant, accessToken, 'APPLICATIONS',
        'https://graph.microsoft.com/v1.0/applications?$select=id,appId,displayName,description,createdDateTime,signInAudience,publisherDomain,identifierUris,web,passwordCredentials,keyCredentials,requiredResourceAccess&$expand=owners($select=id,displayName,userPrincipalName)',
      ),
      SECURITY_DEFAULTS: () => this.syncSecurityDefaults(tenant, accessToken),
      SHAREPOINT_SITES: () => this.syncSharePointSites(tenant, accessToken),
      SHAREPOINT_SETTINGS: () => this.syncSharePointSettings(tenant, accessToken),
    }
    const synchronize = synchronizers[resourceType]
    return synchronize ? { resource: resourceType, synchronize } : null
  }

  private async syncConnectedTenant(
    tenant: TenantSyncTarget,
    throwWhenBusy: boolean,
    options: { incrementalOnly?: boolean; includeBundle?: boolean } = {}
  ) {
    const incrementalOnly = options.incrementalOnly === true
    const includeBundle = options.includeBundle !== false
    if (
      tenant.status !== 'ACTIVE' ||
      tenant.connection?.status !== 'CONNECTED'
    ) {
      throw new ConflictException(
        'Connect and authorize this Microsoft tenant before synchronization.'
      )
    }

    const now = new Date()
    const { claimed, existingState } = await claimTenantUsersLease(this.prisma, tenant, now)
    if (!claimed) {
      if (throwWhenBusy) {
        throw new ConflictException(
          'A tenant synchronization is already running.'
        )
      }
      return {
        bundle: null,
        status: 'SKIPPED',
        failedResources: [] as string[],
      }
    }

    let accessToken: string
    let graphTokenAcquired = false
    try {
      accessToken = await this.microsoftConsent.getTenantAccessToken({
        microsoftTenantId: tenant.microsoftTenantId,
        connectionMode:
          tenant.connection.connectionMode === 'CUSTOMER_MANAGED'
            ? 'CUSTOMER_MANAGED'
            : 'HAWKVIEW_MANAGED',
        clientId: tenant.connection.clientId,
        credentialReference: tenant.connection.credentialReference,
      })
      graphTokenAcquired = true
      const result = await this.synchronizeUsers(
        tenant,
        accessToken,
        existingState?.deltaLink ?? null
      )
      const completedAt = new Date()

      await this.prisma.$transaction([
        this.prisma.syncState.update({
          where: {
            customerTenantId_resourceType: {
              customerTenantId: tenant.id,
              resourceType: 'USERS',
            },
          },
          data: {
            status: 'SUCCEEDED',
            deltaLink: result.deltaLink,
            lastSuccessfulAt: completedAt,
            lastErrorCode: null,
            lastErrorMessage: null,
            consecutiveFailures: 0,
          },
        }),
        this.prisma.tenantConnection.update({
          where: {
            customerTenantId_organizationId: {
              customerTenantId: tenant.id,
              organizationId: tenant.organizationId,
            },
          },
          data: { lastVerifiedAt: completedAt },
        }),
      ])
    } catch (error) {
      const technicalMessage = safeErrorMessage(
        error,
        'Microsoft users synchronization failed.',
      )
      const failure = classifyMicrosoftFailure(error, technicalMessage)
      // A successful token acquisition proves the tenant connection itself is
      // still usable. Collection failures (including a Graph 401/403) belong
      // to the resource and must never suspend the whole customer tenant.
      if (!graphTokenAcquired && failure.failureClass === 'AUTHENTICATION_REQUIRED') {
        await this.markConnectionUnavailable(tenant, error)
      }
      const message = customerCollectionFailureMessage(
        'user directory',
        failure,
        Boolean(existingState?.lastSuccessfulAt),
      )
      await this.prisma.syncState.update({
        where: {
          customerTenantId_resourceType: {
            customerTenantId: tenant.id,
            resourceType: 'USERS',
          },
        },
        data: {
          status: 'FAILED',
          lastErrorCode: failure.reasonCode,
          lastErrorMessage: message,
          consecutiveFailures: { increment: 1 },
        },
      })
      if (graphTokenAcquired) {
        try {
          // The Management Activity API is a separate Microsoft resource.
          // A transient Graph users failure must not create an audit blind
          // spot; ingest evidence now and reconcile current state later.
          await this.m365ManagementActivity.syncTenant(tenant)
        } catch (auditError) {
          this.logger.warn(
            `Independent Microsoft 365 audit synchronization also failed for tenant ${tenant.id}: ${safeErrorMessage(auditError, 'Microsoft 365 audit synchronization failed.')}`
          )
        }
      }
      if (error instanceof ConflictException) throw error
      throw new BadGatewayException(
        error instanceof Error
          ? error.message
          : 'Microsoft users synchronization failed.'
      )
    }

    if (incrementalOnly) {
      // These sources are time-window based and retain their own watermarks,
      // so they fetch only newly available activity rather than a complete
      // tenant inventory. Microsoft Graph user delta is completed above.
      const incrementalModules: Array<{
        resource: string
        synchronize: () => Promise<unknown>
      }> = [
        {
          resource: 'SIGN_INS',
          synchronize: () => this.syncSignInLogs(tenant, accessToken),
        },
        {
          resource: 'AUDIT_LOGS',
          synchronize: () => this.syncDirectoryAuditLogs(tenant, accessToken),
        },
        {
          resource: 'M365_AUDIT',
          synchronize: () => this.syncM365AuditActivity(tenant, accessToken),
        },
      ]
      // Retry only explicitly safe, non-per-user inventory resources between
      // daily full collections. The USERS row claim above serializes this with
      // other tenant syncs. Permission failures never enter this path.
      const targetedRetryStates = await this.prisma.syncState.findMany({
        where: {
          organizationId: tenant.organizationId,
          customerTenantId: tenant.id,
          resourceType: { in: [...TARGETED_TRANSIENT_RETRY_RESOURCES] },
        },
        select: {
          resourceType: true,
          status: true,
          lastAttemptAt: true,
          lastSuccessfulAt: true,
          lastErrorCode: true,
          lastErrorMessage: true,
          consecutiveFailures: true,
        },
      })
      for (const state of targetedRetryStates) {
        if (!shouldRunTargetedTransientRetry(state, now)) continue
        const module = this.targetedTransientRetryModule(
          tenant,
          accessToken,
          state.resourceType,
        )
        if (module) incrementalModules.push(module)
      }
      // Mailbox-rule inventory is intentionally daily-only. A broad Graph
      // per-mailbox scan must never become an unconditional five-minute poll;
      // future audit-triggered reconciliation needs an exact, bounded event
      // predicate before it can opt this resource back into incremental work.
      const incrementalResults = await Promise.allSettled(
        incrementalModules.map((module) => module.synchronize())
      )
      incrementalResults.forEach((result, index) => {
        if (result.status === 'rejected') {
          const resource = incrementalModules[index]?.resource ?? 'UNKNOWN'
          this.logger.warn(
            `${resource} incremental synchronization was unavailable for tenant ${tenant.id}: ${
              result.reason instanceof Error
                ? result.reason.message
                : String(result.reason)
            }`
          )
        }
      })

      await this.refreshCollectionFieldStates(tenant)
      const attemptedStates = await this.prisma.syncState.findMany({
        where: {
          organizationId: tenant.organizationId,
          customerTenantId: tenant.id,
          lastAttemptAt: { gte: now },
        },
        select: { resourceType: true, status: true },
      })
      const failedResources = attemptedStates
        .filter((state) => state.status === 'FAILED')
        .map((state) => state.resourceType)
      return {
        bundle: includeBundle ? await this.buildBundle(tenant) : null,
        status: failedResources.length > 0 ? 'PARTIAL' : 'SUCCEEDED',
        failedResources,
      }
    }

    let snapshotAccessToken: string
    try {
      snapshotAccessToken = await this.microsoftConsent.getTenantAccessToken({
        microsoftTenantId: tenant.microsoftTenantId,
        connectionMode:
          tenant.connection.connectionMode === 'CUSTOMER_MANAGED'
            ? 'CUSTOMER_MANAGED'
            : 'HAWKVIEW_MANAGED',
        clientId: tenant.connection.clientId,
        credentialReference: tenant.connection.credentialReference,
      })
    } catch (error) {
      const technicalMessage = safeErrorMessage(error, 'Microsoft token acquisition failed.')
      const failure = classifyMicrosoftFailure(error, technicalMessage)
      if (failure.failureClass === 'AUTHENTICATION_REQUIRED') {
        await this.markConnectionUnavailable(tenant, error)
      }
      throw new BadGatewayException(
        customerCollectionFailureMessage('Microsoft 365', failure, true),
      )
    }
    // Every secondary dataset is independent. A missing permission or timeout
    // in one Microsoft endpoint must not prevent the remaining datasets from
    // refreshing or recording their own diagnostic SyncState.
    const snapshotModules: Array<{
      resource: string
      synchronize: () => Promise<unknown>
    }> = [
      {
        resource: 'LICENSES',
        synchronize: () => this.syncLicenses(tenant, snapshotAccessToken),
      },
      {
        resource: 'ORGANIZATION_CONFIGURATION',
        synchronize: () => this.syncOrganizationConfiguration(tenant, snapshotAccessToken),
      },
      {
        resource: 'DOMAINS',
        synchronize: () => this.syncDomains(tenant, snapshotAccessToken),
      },
      {
        resource: 'GROUPS',
        synchronize: () => this.syncGroups(tenant, snapshotAccessToken),
      },
      {
        resource: 'SHAREPOINT_SITES',
        synchronize: () =>
          this.syncSharePointSites(tenant, snapshotAccessToken),
      },
      {
        resource: 'SHAREPOINT_SETTINGS',
        synchronize: () =>
          this.syncSharePointSettings(tenant, snapshotAccessToken),
      },
      {
        resource: 'SHAREPOINT_USAGE',
        synchronize: () =>
          this.syncSharePointUsage(tenant, snapshotAccessToken),
      },
      {
        resource: 'EXCHANGE_MAILBOXES',
        synchronize: () =>
          this.syncExchangeMailboxDirectory(tenant, snapshotAccessToken),
      },
      {
        resource: 'EXCHANGE_MAILBOX_SETTINGS',
        synchronize: () =>
          this.syncExchangeMailboxSettings(tenant, snapshotAccessToken),
      },
      {
        resource: 'EXCHANGE_ACCEPTED_DOMAINS',
        synchronize: () =>
          this.syncExchangeAcceptedDomains(tenant, snapshotAccessToken),
      },
      {
        resource: 'EXCHANGE_MAILBOX_USAGE',
        synchronize: () =>
          this.syncExchangeMailboxUsage(tenant, snapshotAccessToken),
      },
      {
        resource: 'EXCHANGE_MAILBOX_RULES',
        synchronize: () =>
          this.syncExchangeMailboxRules(tenant, snapshotAccessToken),
      },
    ]
    if (tenant.connection.exchangeReadOnlyEnabledAt) {
      snapshotModules.push({
        resource: 'EXCHANGE_MAILBOX_CONFIGURATION',
        synchronize: () => this.syncExchangeMailboxConfiguration(tenant),
      })
    }
    const snapshotResults = await Promise.allSettled(
      snapshotModules.map((module) => module.synchronize())
    )
    snapshotResults.forEach((result, index) => {
      if (result.status === 'rejected') {
        const resource = snapshotModules[index]?.resource ?? 'UNKNOWN'
        this.logger.warn(
          `${resource} synchronization was unavailable for tenant ${tenant.id}: ${
            result.reason instanceof Error
              ? result.reason.message
              : String(result.reason)
          }`
        )
      }
    })

    // Run after Microsoft domain discovery so DNS checks always use the
    // latest database-backed domain inventory.
    try {
      await this.syncDomainDnsHealth(tenant)
    } catch (error) {
      this.logger.warn(
        `DOMAIN_DNS_HEALTH synchronization was unavailable for tenant ${tenant.id}: ${
          error instanceof Error ? error.message : String(error)
        }`
      )
    }

    const entraModules: Array<Promise<unknown>> = [
      this.syncAuthenticationRegistrations(tenant, snapshotAccessToken),
      this.syncAuthenticationMethodPolicy(tenant, snapshotAccessToken),
      this.syncEntraCollection(
        tenant,
        snapshotAccessToken,
        'CONDITIONAL_ACCESS',
        'https://graph.microsoft.com/v1.0/identity/conditionalAccess/policies'
      ),
      this.syncEntraCollection(
        tenant,
        snapshotAccessToken,
        'NAMED_LOCATIONS',
        'https://graph.microsoft.com/v1.0/identity/conditionalAccess/namedLocations'
      ),
      this.syncSignInLogs(tenant, snapshotAccessToken),
      this.syncDirectoryAuditLogs(tenant, snapshotAccessToken, false),
      this.syncM365AuditActivity(tenant, snapshotAccessToken),
      this.syncEntraCollection(
        tenant,
        snapshotAccessToken,
        'DEVICES',
        'https://graph.microsoft.com/v1.0/devices?$select=id,deviceId,displayName,operatingSystem,operatingSystemVersion,trustType,isCompliant,isManaged,accountEnabled,approximateLastSignInDateTime&$expand=registeredOwners($select=id)'
      ),
      this.syncEntraCollection(
        tenant,
        snapshotAccessToken,
        'DIRECTORY_ROLES',
        'https://graph.microsoft.com/v1.0/roleManagement/directory/roleAssignments?$expand=roleDefinition($select=id,displayName)'
      ),
      this.syncEntraCollection(
        tenant,
        snapshotAccessToken,
        'SERVICE_PRINCIPALS',
        'https://graph.microsoft.com/v1.0/servicePrincipals?' +
          '$select=id,appId,displayName,description,servicePrincipalType,' +
          'accountEnabled,appRoleAssignmentRequired,createdDateTime,homepage,' +
          'loginUrl,publisherName,verifiedPublisher,tags,' +
          'preferredSingleSignOnMode,notificationEmailAddresses,appRoles,' +
          'oauth2PermissionScopes&' +
          '$expand=appRoleAssignedTo($select=id,principalId,principalType,principalDisplayName,appRoleId)'
      ),
      this.syncEntraCollection(
        tenant,
        snapshotAccessToken,
        'APPLICATIONS',
        'https://graph.microsoft.com/v1.0/applications?' +
          '$select=id,appId,displayName,description,createdDateTime,' +
          'signInAudience,publisherDomain,identifierUris,web,' +
          'passwordCredentials,keyCredentials,requiredResourceAccess&' +
          '$expand=owners($select=id,displayName,userPrincipalName)'
      ),
      this.syncEntraCollection(
        tenant,
        snapshotAccessToken,
        'SECURE_SCORES',
        'https://graph.microsoft.com/v1.0/security/secureScores?$top=25'
      ),
      this.syncSecurityDefaults(tenant, snapshotAccessToken),
    ]
    const entraResults = await Promise.allSettled(entraModules)
    entraResults.forEach((result, index) => {
      if (result.status === 'rejected') {
        const resource = [
          'AUTH_REGISTRATIONS',
          'AUTH_METHOD_POLICIES',
          'CONDITIONAL_ACCESS',
          'NAMED_LOCATIONS',
          'SIGN_INS',
          'AUDIT_LOGS',
          'M365_AUDIT',
          'DEVICES',
          'DIRECTORY_ROLES',
          'SERVICE_PRINCIPALS',
          'APPLICATIONS',
          'SECURE_SCORES',
          'SECURITY_DEFAULTS',
        ][index]
        this.logger.warn(
          `${resource} synchronization was unavailable for tenant ${tenant.id}: ${
            result.reason instanceof Error
              ? result.reason.message
              : String(result.reason)
          }`
        )
      }
    })

    await this.refreshCollectionFieldStates(tenant)
    const attemptedStates = await this.prisma.syncState.findMany({
      where: {
        organizationId: tenant.organizationId,
        customerTenantId: tenant.id,
        lastAttemptAt: { gte: now },
      },
      select: { resourceType: true, status: true },
    })
    const failedResources = attemptedStates
      .filter((state) => state.status === 'FAILED')
      .map((state) => state.resourceType)
    const initialSync = !existingState?.lastSuccessfulAt
    if (initialSync) {
      await this.notifications.publishIncident({
        organizationId: tenant.organizationId,
        customerTenantId: tenant.id,
        eventType:
          failedResources.length > 0
            ? 'tenant.initial_sync_partial'
            : 'tenant.initial_sync_completed',
        category: failedResources.length > 0 ? 'warning' : 'success',
        severity: failedResources.length > 0 ? 'medium' : 'info',
        title:
          failedResources.length > 0
            ? 'Initial tenant sync completed with gaps'
            : 'Initial tenant sync completed',
        description:
          failedResources.length > 0
            ? `${failedResources.length} data source${failedResources.length === 1 ? '' : 's'} could not be collected. HawkView will retry automatically.`
            : 'HawkView finished collecting the tenant data required for monitoring.',
        dedupeKey: `tenant:${tenant.id}:initial-sync`,
        source: 'tenant-sync',
        actionUrl: `/tenants/${tenant.id}`,
        actionLabel: 'View tenant',
        metadata: { failedResources },
      })
    }
    return {
      bundle: includeBundle ? await this.buildBundle(tenant) : null,
      status: failedResources.length > 0 ? 'PARTIAL' : 'SUCCEEDED',
      failedResources,
    }
  }

  /**
   * Materialize field-level status independently from snapshot payloads. A
   * resource failure does not remove its previous snapshot, so consumers can
   * safely show the last value with a stale warning instead of a false zero.
   */
  private async refreshCollectionFieldStates(tenant: {
    id: string
    organizationId: string
  }) {
    const [syncStates, snapshots] = await Promise.all([
      this.prisma.syncState.findMany({
        where: {
          organizationId: tenant.organizationId,
          customerTenantId: tenant.id,
        },
      }),
      this.prisma.tenantEntraSnapshot.findMany({
        where: {
          organizationId: tenant.organizationId,
          customerTenantId: tenant.id,
        },
        select: { resourceType: true, payload: true },
      }),
    ])
    const syncByResource = new Map(syncStates.map((state) => [state.resourceType, state]))
    const snapshotByResource = new Map(snapshots.map((snapshot) => [snapshot.resourceType, snapshot.payload]))
    const snapshotFor = (resource: string) =>
      snapshotByResource.get(resource as any)
    // A deliberately empty snapshot is still a successful, useful result. It
    // must survive a later refresh failure as a stale zero rather than vanish.
    const hasSnapshot = (resource: string) => snapshotByResource.has(resource as any)
    const correlationId = (message: string | null) =>
      message?.match(/(?:request|correlation)[^0-9a-f]*([0-9a-f]{8}-[0-9a-f-]{27,})/i)?.[1] ?? null
    const resources: Array<{ key: string; resource: string; source: string; endpoint: string; unsupported?: boolean; capability?: 'NOT_COLLECTED_LEAST_PRIVILEGE' }> = [
      { key: 'exchange.mailboxes.inventory', resource: 'EXCHANGE_MAILBOXES', source: 'Microsoft Graph', endpoint: '/users' },
      { key: 'exchange.mailboxes.settings', resource: 'EXCHANGE_MAILBOX_SETTINGS', source: 'Microsoft Graph', endpoint: '/users/{id}/mailboxSettings' },
      { key: 'exchange.mailboxes.usage', resource: 'EXCHANGE_MAILBOX_USAGE', source: 'Microsoft Graph Reports', endpoint: '/reports/getMailboxUsageDetail' },
      { key: 'sharepoint.sites.inventory', resource: 'SHAREPOINT_SITES', source: 'Microsoft Graph', endpoint: '/sites?search=*' },
      { key: 'sharepoint.sites.access', resource: 'SHAREPOINT_SITES', source: 'HawkView standard least-privilege mode', endpoint: 'not-collected-in-standard-mode', capability: 'NOT_COLLECTED_LEAST_PRIVILEGE' },
      { key: 'sharepoint.tenant.settings', resource: 'SHAREPOINT_SETTINGS', source: 'Microsoft Graph', endpoint: '/admin/sharepoint/settings' },
      { key: 'sharepoint.usage', resource: 'SHAREPOINT_USAGE', source: 'Microsoft Graph Reports', endpoint: '/reports/getSharePointSiteUsageDetail' },
      { key: 'sharepoint.activity', resource: 'SHAREPOINT_USAGE', source: 'Microsoft Graph Reports', endpoint: '/reports/getSharePointSiteUsageDetail' },
      { key: 'sharepoint.owners', resource: 'SHAREPOINT_SITES', source: 'Microsoft Graph', endpoint: '/sites', unsupported: true },
      { key: 'sharepoint.deleted-sites', resource: 'SHAREPOINT_USAGE', source: 'Microsoft Graph Reports', endpoint: '/reports/getSharePointSiteUsageDetail' },
      { key: 'entra.conditional-access', resource: 'CONDITIONAL_ACCESS', source: 'Microsoft Graph', endpoint: '/identity/conditionalAccess/policies' },
    ]
    await Promise.all(resources.map(async (definition) => {
      const sync = syncByResource.get(definition.resource as any)
      const conditionalAccessPayload = snapshotFor('CONDITIONAL_ACCESS')
      const hasNoConditionalAccessPolicies =
        definition.key === 'entra.conditional-access' &&
        sync?.status === 'SUCCEEDED' &&
        Array.isArray(conditionalAccessPayload) &&
        conditionalAccessPayload.length === 0
      const result = deriveCollectionFieldState({
        syncStatus: sync?.status,
        lastErrorMessage: sync?.lastErrorMessage,
        hasPriorSnapshot: hasSnapshot(definition.resource),
        unsupported: definition.unsupported,
        unsupportedMessage: 'Microsoft Graph site inventory does not provide a reliable site-owner roster.',
        notConfigured: hasNoConditionalAccessPolicies,
      })
      await this.prisma.tenantCollectionFieldState.upsert({
        where: { customerTenantId_fieldKey: { customerTenantId: tenant.id, fieldKey: definition.key } },
        create: {
          organizationId: tenant.organizationId, customerTenantId: tenant.id, fieldKey: definition.key,
          state: result.state, reasonCode: result.reasonCode, message: result.message,
          source: definition.source, endpoint: definition.endpoint,
          correlationId: correlationId(sync?.lastErrorMessage ?? null), lastAttemptAt: sync?.lastAttemptAt ?? null,
          lastSuccessfulAt: sync?.lastSuccessfulAt ?? null, isStale: result.isStale,
        },
        update: {
          state: result.state, reasonCode: result.reasonCode, message: result.message,
          source: definition.source, endpoint: definition.endpoint,
          correlationId: correlationId(sync?.lastErrorMessage ?? null), lastAttemptAt: sync?.lastAttemptAt ?? null,
          lastSuccessfulAt: sync?.lastSuccessfulAt ?? null, isStale: result.isStale,
        },
      })
    }))
  }

  private async markConnectionUnavailable(
    tenant: { id: string; organizationId: string },
    error: unknown
  ) {
    const message = safeErrorMessage(error, 'Microsoft tenant access failed.')
    const failedAt = new Date()

    await this.prisma.$transaction([
      this.prisma.customerTenant.update({
        where: { id: tenant.id },
        data: { status: 'SUSPENDED' },
      }),
      this.prisma.tenantConnection.update({
        where: {
          customerTenantId_organizationId: {
            customerTenantId: tenant.id,
            organizationId: tenant.organizationId,
          },
        },
        data: {
          status: 'ERROR',
          lastVerifiedAt: failedAt,
          lastErrorCode: 'MICROSOFT_AUTHENTICATION_REQUIRED',
          lastErrorMessage: message,
        },
      }),
    ])
    await this.notifications.publishIncident({
      organizationId: tenant.organizationId,
      customerTenantId: tenant.id,
      eventType: 'tenant.connection_lost',
      category: 'error',
      severity: 'critical',
      title: 'Microsoft 365 connection lost',
      description: message,
      dedupeKey: `tenant:${tenant.id}:connection`,
      source: 'microsoft-verification',
      actionUrl: `/tenants/${tenant.id}/settings`,
      actionLabel: 'Reconnect tenant',
    })
  }

  private async runSnapshotSync(
    tenant: { id: string; organizationId: string },
    resourceType:
      | 'LICENSES'
      | 'DOMAINS'
      | 'GROUPS'
      | 'SIGN_INS'
      | 'AUDIT_LOGS'
      | EntraSnapshotResource,
    synchronize: () => Promise<void>
  ) {
    const lastAttemptAt = new Date()
    const previousState = await this.prisma.syncState.upsert({
      where: {
        customerTenantId_resourceType: {
          customerTenantId: tenant.id,
          resourceType,
        },
      },
      create: {
        organizationId: tenant.organizationId,
        customerTenantId: tenant.id,
        resourceType,
        status: 'RUNNING',
        lastAttemptAt,
      },
      update: {
        status: 'RUNNING',
        lastAttemptAt,
        lastErrorCode: null,
        lastErrorMessage: null,
      },
    })

    try {
      await synchronize()
      await this.prisma.syncState.update({
        where: {
          customerTenantId_resourceType: {
            customerTenantId: tenant.id,
            resourceType,
          },
        },
        data: {
          status: 'SUCCEEDED',
          lastSuccessfulAt: new Date(),
          lastErrorCode: null,
          lastErrorMessage: null,
          consecutiveFailures: 0,
        },
      })
      await this.notifications.resolveIncident(
        tenant.organizationId,
        `tenant:${tenant.id}:sync:${resourceType}`,
        {
          customerTenantId: tenant.id,
          eventType: 'tenant.sync_recovered',
          category: 'success',
          severity: 'info',
          title: `${resourceType.replaceAll('_', ' ')} synchronization recovered`,
          description: 'HawkView is receiving this Microsoft 365 data again.',
          source: 'tenant-sync',
          actionUrl: `/tenants/${tenant.id}`,
          actionLabel: 'View tenant',
        }
      )
    } catch (error) {
      const technicalMessage = safeErrorMessage(
        error,
        `Microsoft ${resourceType.toLowerCase()} synchronization failed.`
      )
      if (error instanceof CollectionInitializingError) {
        await this.prisma.syncState.update({
          where: {
            customerTenantId_resourceType: {
              customerTenantId: tenant.id,
              resourceType,
            },
          },
          data: {
            status: 'RUNNING',
            lastErrorCode: error.code,
            lastErrorMessage: technicalMessage,
            consecutiveFailures: 0,
          },
        })
        // A previous deployment could have published an incident for this
        // normal provisioning state. Retire it without claiming collection
        // success; readiness will continue to report INITIALIZING.
        await this.notifications.resolveIncident(
          tenant.organizationId,
          `tenant:${tenant.id}:sync:${resourceType}`,
        )
        return
      }
      if (error instanceof CollectionPartialError) {
        await this.prisma.syncState.update({
          where: {
            customerTenantId_resourceType: {
              customerTenantId: tenant.id,
              resourceType,
            },
          },
          data: {
            status: 'RUNNING',
            lastSuccessfulAt: new Date(),
            lastErrorCode: error.code,
            lastErrorMessage: technicalMessage,
            consecutiveFailures: 0,
          },
        })
        await this.notifications.resolveIncident(
          tenant.organizationId,
          `tenant:${tenant.id}:sync:${resourceType}`,
        )
        return
      }
      const failure = classifyMicrosoftFailure(error, technicalMessage)
      const message = customerCollectionFailureMessage(
        resourceType.replaceAll('_', ' ').toLowerCase(),
        failure,
        Boolean(previousState?.lastSuccessfulAt),
      )
      this.logger.warn(JSON.stringify({
        event: 'microsoft_collection_failed',
        organizationId: tenant.organizationId,
        customerTenantId: tenant.id,
        resourceType,
        failureClass: failure.failureClass,
        reasonCode: failure.reasonCode,
        status: failure.status,
        microsoftCode: failure.microsoftCode,
        requestId: failure.requestId,
      }))
      const state = await this.prisma.syncState.update({
        where: {
          customerTenantId_resourceType: {
            customerTenantId: tenant.id,
            resourceType,
          },
        },
        data: {
          status: 'FAILED',
          lastErrorCode: failure.reasonCode,
          lastErrorMessage: message,
          consecutiveFailures: { increment: 1 },
        },
      })
      const shouldNotify = failure.retryable
        ? state.consecutiveFailures >= 3
        : state.consecutiveFailures >= 1
      if (shouldNotify) {
        const permissionRequired = failure.customerAction === 'REVIEW_PERMISSIONS'
        const reconnectRequired = failure.customerAction === 'RECONNECT'
        await this.notifications.publishIncident({
          organizationId: tenant.organizationId,
          customerTenantId: tenant.id,
          eventType: 'tenant.sync_failed',
          category: 'warning',
          severity: permissionRequired || reconnectRequired || state.consecutiveFailures >= 6
            ? 'high'
            : 'medium',
          title: failure.retryable
            ? `${resourceType.replaceAll('_', ' ')} refresh delayed`
            : `${resourceType.replaceAll('_', ' ')} requires attention`,
          description: message,
          dedupeKey: `tenant:${tenant.id}:sync:${resourceType}`,
          source: 'tenant-sync',
          actionUrl: permissionRequired || reconnectRequired
            ? `/tenants/${tenant.id}/settings`
            : `/tenants/${tenant.id}`,
          actionLabel: permissionRequired
            ? 'Review permissions'
            : reconnectRequired
              ? 'Reconnect tenant'
              : 'View synchronization',
          metadata: {
            resourceType,
            consecutiveFailures: state.consecutiveFailures,
            failureClass: failure.failureClass,
            reasonCode: failure.reasonCode,
          },
        })
      }
      throw new BadGatewayException(message)
    }
  }

  private async syncLicenses(
    tenant: { id: string; organizationId: string },
    accessToken: string
  ) {
    return this.runSnapshotSync(tenant, 'LICENSES', async () => {
      const response = await this.fetchGraphPage(
        'https://graph.microsoft.com/v1.0/subscribedSkus', accessToken, 'license',
        { timeoutMs: 20_000 },
      )
      const body = (await response.json()) as { value?: GraphSubscribedSku[] }
      const observedAt = new Date()
      const rows = (body.value ?? []).filter(
        (sku) =>
          typeof sku.skuId === 'string' && typeof sku.skuPartNumber === 'string'
      )

      await this.saveSnapshot(tenant, 'LICENSES', authoritativeSnapshot(rows), async (transaction) => {
        for (const sku of rows) {
          await transaction.tenantLicense.upsert({
            where: {
              customerTenantId_microsoftSkuId: {
                customerTenantId: tenant.id,
                microsoftSkuId: sku.skuId as string,
              },
            },
            create: {
              organizationId: tenant.organizationId,
              customerTenantId: tenant.id,
              microsoftSkuId: sku.skuId as string,
              skuPartNumber: (sku.skuPartNumber as string).trim(),
              consumedUnits: Math.max(0, sku.consumedUnits ?? 0),
              enabledUnits: Math.max(0, sku.prepaidUnits?.enabled ?? 0),
              warningUnits: Math.max(0, sku.prepaidUnits?.warning ?? 0),
              suspendedUnits: Math.max(0, sku.prepaidUnits?.suspended ?? 0),
              lockedOutUnits: Math.max(0, sku.prepaidUnits?.lockedOut ?? 0),
              capabilityStatus: sku.capabilityStatus?.trim() || null,
              servicePlans: boundedServicePlans(sku.servicePlans) ?? Prisma.JsonNull,
              lastSeenAt: observedAt,
            },
            update: {
              skuPartNumber: (sku.skuPartNumber as string).trim(),
              consumedUnits: Math.max(0, sku.consumedUnits ?? 0),
              enabledUnits: Math.max(0, sku.prepaidUnits?.enabled ?? 0),
              warningUnits: Math.max(0, sku.prepaidUnits?.warning ?? 0),
              suspendedUnits: Math.max(0, sku.prepaidUnits?.suspended ?? 0),
              lockedOutUnits: Math.max(0, sku.prepaidUnits?.lockedOut ?? 0),
              capabilityStatus: sku.capabilityStatus?.trim() || null,
              servicePlans: boundedServicePlans(sku.servicePlans) ?? Prisma.JsonNull,
              lastSeenAt: observedAt,
            },
          })
        }
        await transaction.tenantLicense.deleteMany({
          where: {
            customerTenantId: tenant.id,
            lastSeenAt: { lt: observedAt },
          },
        })
      })
    })
  }

  private async syncDomains(
    tenant: { id: string; organizationId: string },
    accessToken: string
  ) {
    return this.runSnapshotSync(tenant, 'DOMAINS', async () => {
      const response = await this.fetchGraphPage(
        'https://graph.microsoft.com/v1.0/organization?$select=displayName,verifiedDomains',
        accessToken,
        'domain',
        { timeoutMs: 20_000 },
      )
      const body = (await response.json()) as { value?: GraphOrganization[] }
      const organization = body.value?.[0]
      if (!organization) {
        throw new Error('Microsoft did not return organization information.')
      }
      const observedAt = new Date()
      const domains = (organization.verifiedDomains ?? []).filter(
        (domain) => typeof domain.name === 'string' && domain.name.trim()
      )
      const primaryDomain =
        domains.find((domain) => domain.isDefault)?.name?.trim() ??
        domains.find((domain) => domain.isInitial)?.name?.trim() ??
        null

      await this.prisma.$transaction(async (transaction) => {
        for (const domain of domains) {
          const name = (domain.name as string).trim().toLowerCase()
          await transaction.tenantDomain.upsert({
            where: {
              customerTenantId_name: {
                customerTenantId: tenant.id,
                name,
              },
            },
            create: {
              organizationId: tenant.organizationId,
              customerTenantId: tenant.id,
              name,
              isDefault: domain.isDefault === true,
              isInitial: domain.isInitial === true,
              lastSeenAt: observedAt,
            },
            update: {
              isDefault: domain.isDefault === true,
              isInitial: domain.isInitial === true,
              lastSeenAt: observedAt,
            },
          })
        }
        await transaction.tenantDomain.deleteMany({
          where: {
            customerTenantId: tenant.id,
            lastSeenAt: { lt: observedAt },
          },
        })
        await transaction.customerTenant.update({
          where: { id: tenant.id },
          data: {
            displayName: organization.displayName?.trim() || undefined,
            primaryDomain,
          },
        })
      })
      await this.saveSnapshot(tenant, 'DOMAINS', authoritativeSnapshot(domains))
    })
  }

  /**
   * A separate authoritative organization baseline keeps a display-name change
   * from being confused with domain inventory.  The initial collection is a
   * baseline only; saveSnapshot emits evidence only after two successful
   * collections and keeps the prior state on a failed/partial request.
   */
  private async syncOrganizationConfiguration(
    tenant: { id: string; organizationId: string; microsoftTenantId: string },
    accessToken: string
  ) {
    return this.runSnapshotSync(tenant, 'ORGANIZATION_CONFIGURATION', async () => {
      const response = await this.fetchGraphPage(
        'https://graph.microsoft.com/v1.0/organization?$select=id,displayName',
        accessToken,
        'organization configuration',
        { timeoutMs: 20_000 },
      )
      const body = (await response.json()) as GraphOrganizationConfigurationResponse
      const organization = organizationConfigurationSnapshotForTenant(tenant.microsoftTenantId, body)
      await this.saveSnapshot(tenant, 'ORGANIZATION_CONFIGURATION', authoritativeSnapshot([organization]))
    })
  }

  private async syncDomainDnsHealth(tenant: {
    id: string
    organizationId: string
  }) {
    return this.runSnapshotSync(tenant, 'DOMAIN_DNS_HEALTH', async () => {
      const domains = await this.prisma.tenantDomain.findMany({
        where: {
          organizationId: tenant.organizationId,
          customerTenantId: tenant.id,
        },
        orderBy: [{ isDefault: 'desc' }, { name: 'asc' }],
        select: { name: true },
      })
      if (domains.length === 0) {
        throw new Error(
          'No synchronized Microsoft domains are available for DNS checks.'
        )
      }
      const results = await Promise.all(
        domains.map(({ name }) => resolveDomainDnsHealth(name))
      )
      await this.saveSnapshot(tenant, 'DOMAIN_DNS_HEALTH', authoritativeSnapshot(results))
    })
  }

  private async syncGroups(
    tenant: { id: string; organizationId: string },
    accessToken: string
  ) {
    return this.runSnapshotSync(tenant, 'GROUPS', async () => {
      const groups: GraphGroup[] = []
      let groupsUrl =
        'https://graph.microsoft.com/v1.0/groups?' +
        '$select=id,displayName,description,mail,mailNickname,mailEnabled,' +
        'securityEnabled,groupTypes,visibility,onPremisesSyncEnabled&' +
        '$top=999'

      while (groupsUrl) {
        if (!groupsUrl.startsWith('https://graph.microsoft.com/')) {
          throw new Error('Microsoft returned an invalid groups link.')
        }
        const response = await this.fetchGraphPage(
          groupsUrl, accessToken, 'groups', { timeoutMs: 20_000 },
        )
        const page = (await response.json()) as GraphGroupsPage
        groups.push(
          ...(page.value ?? []).filter(
            (group) =>
              typeof group.id === 'string' &&
              typeof group.displayName === 'string'
          )
        )
        groupsUrl = page['@odata.nextLink'] ?? ''
      }

      const groupTargets = groups.map((group) => ({
        id: group.id as string,
        displayName: group.displayName,
      }))
      const observedAt = new Date()

      // A group definition is an independently authoritative Graph /groups
      // collection.  Persist and snapshot that definition before attempting
      // the optional relationship subcollections below.  Owners/members are
      // not fields in the GROUPS comparison contract, so a relationship 403
      // must not turn a valid group definition into a false removal.
      await this.prisma.$transaction(async (transaction) => {
        for (const group of groups) {
          const microsoftGroupId = group.id as string
          await transaction.directoryGroup.upsert({
            where: {
              customerTenantId_microsoftGroupId: {
                customerTenantId: tenant.id,
                microsoftGroupId,
              },
            },
            create: {
              organizationId: tenant.organizationId,
              customerTenantId: tenant.id,
              microsoftGroupId,
              displayName: group.displayName?.trim() || microsoftGroupId,
              description: group.description?.trim() || null,
              mail: group.mail?.trim() || null,
              mailNickname: group.mailNickname?.trim() || null,
              mailEnabled: group.mailEnabled === true,
              securityEnabled: group.securityEnabled === true,
              groupTypes: group.groupTypes ?? [],
              visibility: group.visibility?.trim() || null,
              lastSeenAt: observedAt,
            },
            update: {
              displayName: group.displayName?.trim() || microsoftGroupId,
              description: group.description?.trim() || null,
              mail: group.mail?.trim() || null,
              mailNickname: group.mailNickname?.trim() || null,
              mailEnabled: group.mailEnabled === true,
              securityEnabled: group.securityEnabled === true,
              groupTypes: group.groupTypes ?? [],
              visibility: group.visibility?.trim() || null,
              lastSeenAt: observedAt,
            },
          })
        }
        await transaction.directoryGroup.deleteMany({
          where: {
            customerTenantId: tenant.id,
            lastSeenAt: { lt: observedAt },
          },
        })
      })

      await this.saveSnapshot(tenant, 'GROUPS', authoritativeSnapshot(groups))

      const fetchGroupOwners = async (groupId: string) => {
        const owners: NonNullable<GraphGroup['owners']> = []
        let ownersUrl =
          `https://graph.microsoft.com/v1.0/groups/${encodeURIComponent(groupId)}` +
          '/owners?$select=id,displayName,userPrincipalName&$top=999'
        while (ownersUrl) {
          if (!ownersUrl.startsWith('https://graph.microsoft.com/')) {
            throw new Error('Microsoft returned an invalid group-owners link.')
          }
          const response = await this.fetchGraphPage(
            ownersUrl, accessToken, 'group owner', { timeoutMs: 20_000 },
          )
          const page = (await response.json()) as {
            value?: NonNullable<GraphGroup['owners']>
            '@odata.nextLink'?: string
          }
          owners.push(...(page.value ?? []))
          ownersUrl = page['@odata.nextLink'] ?? ''
        }
        return owners
      }

      const { ownersByGroupId, failures: ownerFailures } =
        await collectGroupOwners(groupTargets, (group) =>
          fetchGroupOwners(group.id)
        )
      for (const group of groups) {
        group.owners = ownersByGroupId.get(group.id as string) ?? []
      }
      for (const failure of ownerFailures) {
        const message =
          failure.error instanceof Error
            ? failure.error.message
            : String(failure.error)
        this.logger.warn(
          `Skipped owner refresh for Microsoft group ${failure.groupName} (${failure.groupId}) in tenant ${tenant.id}: ${message}`
        )
      }

      const fetchGroupMemberIds = async (groupId: string) => {
        const memberIds: string[] = []
        let membersUrl =
          `https://graph.microsoft.com/v1.0/groups/${encodeURIComponent(groupId)}` +
          '/members?$select=id&$top=999'
        while (membersUrl) {
          if (!membersUrl.startsWith('https://graph.microsoft.com/')) {
            throw new Error('Microsoft returned an invalid group-members link.')
          }
          const response = await this.fetchGraphPage(
            membersUrl, accessToken, 'group membership', { timeoutMs: 20_000 },
          )
          const page = (await response.json()) as GraphGroupMembersPage
          memberIds.push(
            ...(page.value ?? [])
              .map((member) => member.id)
              .filter((id): id is string => typeof id === 'string')
          )
          membersUrl = page['@odata.nextLink'] ?? ''
        }
        return memberIds
      }

      // Keep concurrency bounded to avoid overwhelming Microsoft Graph while
      // still making the initial snapshot practical for tenants with many groups.
      const { memberIdsByGroupId, failures: membershipFailures } =
        await collectGroupMemberships(groupTargets, (group) =>
          fetchGroupMemberIds(group.id)
        )
      for (const failure of membershipFailures) {
        const message =
          failure.error instanceof Error
            ? failure.error.message
            : String(failure.error)
        this.logger.warn(
          `Skipped membership refresh for Microsoft group ${failure.groupName} (${failure.groupId}) in tenant ${tenant.id}: ${message}`
        )
      }

      const [directoryUsers, directoryGroups] = await Promise.all([
        this.prisma.directoryUser.findMany({
        where: {
          customerTenantId: tenant.id,
          deletedAt: null,
        },
        select: {
          id: true,
          microsoftUserId: true,
        },
        }),
        this.prisma.directoryGroup.findMany({
          where: { customerTenantId: tenant.id },
          select: { id: true, microsoftGroupId: true },
        }),
      ])
      const directoryUserIdByMicrosoftId = new Map(
        directoryUsers.map((user) => [user.microsoftUserId, user.id])
      )
      const directoryGroupIdByMicrosoftId = new Map(
        directoryGroups.map((group) => [group.microsoftGroupId, group.id])
      )

      await this.prisma.$transaction(async (transaction) => {
        for (const group of groups) {
          const microsoftGroupId = group.id as string
          const directoryGroupId = directoryGroupIdByMicrosoftId.get(microsoftGroupId)
          if (!directoryGroupId || !memberIdsByGroupId.has(microsoftGroupId)) {
            continue
          }

          await transaction.directoryGroupMembership.deleteMany({
            where: { directoryGroupId },
          })
          const memberships = (memberIdsByGroupId.get(microsoftGroupId) ?? [])
            .map((microsoftUserId) => ({
              directoryUserId:
                directoryUserIdByMicrosoftId.get(microsoftUserId),
            }))
            .filter(
              (
                membership
              ): membership is {
                directoryUserId: string
              } => Boolean(membership.directoryUserId)
            )
            .map((membership) => ({
              organizationId: tenant.organizationId,
              customerTenantId: tenant.id,
              directoryGroupId,
              directoryUserId: membership.directoryUserId,
              lastSeenAt: observedAt,
            }))
          if (memberships.length > 0) {
            await transaction.directoryGroupMembership.createMany({
              data: memberships,
              skipDuplicates: true,
            })
          }
        }

      })

      assertGroupRelationshipRefreshComplete(
        ownerFailures.length,
        membershipFailures.length
      )
    })
  }

  private async syncEntraCollection(
    tenant: { id: string; organizationId: string },
    accessToken: string,
    resourceType: EntraSnapshotResource,
    initialUrl: string
  ) {
    return this.runSnapshotSync(tenant, resourceType, async () => {
      const rows = await this.collectEntraCollection(
        accessToken,
        resourceType,
        initialUrl,
      )
      await this.saveSnapshot(tenant, resourceType, authoritativeSnapshot(rows))
    })
  }

  private async collectEntraCollection(
    accessToken: string,
    resourceType: EntraSnapshotResource,
    initialUrl: string,
  ) {
    const rows: unknown[] = []
    let nextUrl = initialUrl
    while (nextUrl) {
      if (!nextUrl.startsWith('https://graph.microsoft.com/')) {
        throw new Error(`Microsoft returned an invalid ${resourceType} link.`)
      }
      const response = await this.fetchGraphPage(
        nextUrl,
        accessToken,
        resourceType.toLowerCase(),
      )
      const page = (await response.json()) as GraphCollectionPage
      rows.push(...(page.value ?? []))
      nextUrl = page['@odata.nextLink'] ?? ''
    }
    return rows
  }

  private async syncSecurityDefaults(
    tenant: { id: string; organizationId: string },
    accessToken: string
  ) {
    return this.runSnapshotSync(tenant, 'SECURITY_DEFAULTS', async () => {
      const response = await this.fetchGraphPage(
        'https://graph.microsoft.com/v1.0/policies/identitySecurityDefaultsEnforcementPolicy',
        accessToken,
        'security defaults',
      )
      const policy = (await response.json()) as Record<string, unknown>
      await this.saveEntraSnapshot(tenant, 'SECURITY_DEFAULTS', [policy])
    })
  }

  private async saveEntraSnapshot(
    tenant: { id: string; organizationId: string },
    resourceType: EntraSnapshotResource,
    rows: unknown[]
  ) {
    await this.saveSnapshot(tenant, resourceType, authoritativeSnapshot(rows))
  }

  private async syncAuthenticationRegistrations(
    tenant: { id: string; organizationId: string },
    accessToken: string
  ) {
    return this.runSnapshotSync(tenant, 'AUTH_REGISTRATIONS', async () => {
      let registrations: unknown[]
      try {
        registrations = await this.collectEntraCollection(
          accessToken,
          'AUTH_REGISTRATIONS',
          'https://graph.microsoft.com/v1.0/reports/authenticationMethods/userRegistrationDetails',
        )
      } catch (error) {
        if (
          !(error instanceof MicrosoftGraphCollectionError) ||
          error.graphErrorCode !== NON_PREMIUM_AUTH_REGISTRATION_ERROR_CODE
        ) {
          throw error
        }
        this.logger.log(
          `Tenant ${tenant.id} does not have premium MFA reporting; using the per-user authentication-method fallback.`,
        )
        registrations = await this.collectPerUserAuthenticationMethods(
          accessToken,
        )
      }
      registrations = await this.enrichAuthenticationRegistrationsWithPerUserMfaState(
        accessToken,
        registrations,
      )
      await this.saveEntraSnapshot(tenant, 'AUTH_REGISTRATIONS', registrations)
    })
  }

  private async enrichAuthenticationRegistrationsWithPerUserMfaState(
    accessToken: string,
    registrations: unknown[],
    limits: Readonly<AuthRegistrationFallbackLimits> =
      AUTH_REGISTRATION_FALLBACK_LIMITS,
  ) {
    assertAuthRegistrationFallbackLimits(limits)
    const rows = registrations.filter(plainRecord)
    const ids = [
      ...new Set(
        rows
          .map((row) => row.id)
          .filter(
            (id): id is string =>
              typeof id === 'string' && id.length > 0 && id.length <= 128,
          ),
      ),
    ].sort((left, right) => left.localeCompare(right))

    const withoutRequirement = () =>
      registrations.map((row) =>
        plainRecord(row)
          ? {
              ...row,
              perUserMfaState: null,
              perUserMfaStateSource:
                'microsoft-graph-beta-authentication-requirements',
            }
          : row,
      )

    if (ids.length === 0) return withoutRequirement()
    if (
      ids.length > limits.maxUsers ||
      Math.ceil(ids.length / limits.batchSize) > limits.maxBatches
    ) {
      this.logger.warn(
        `Microsoft per-user MFA-state synchronization exceeded its bounded ${limits.maxUsers}-user or ${limits.maxBatches}-batch limit. Registration data remains available; per-user MFA state is unavailable.`,
      )
      return withoutRequirement()
    }

    const deadline = Date.now() + limits.collectorDeadlineMs
    const states = new Map<string, PerUserMfaState>()
    try {
      for (let offset = 0; offset < ids.length; offset += limits.batchSize) {
        const remainingMs = deadline - Date.now()
        if (remainingMs <= 0) {
          throw new Error(
            'Microsoft per-user MFA-state synchronization reached its bounded wall-clock deadline.',
          )
        }
        const batchIds = ids.slice(offset, offset + limits.batchSize)
        const response = await this.fetchGraphPage(
          'https://graph.microsoft.com/beta/$batch',
          accessToken,
          'per-user MFA-state',
          {
            retryUnsafeMethod: true,
            timeoutMs: Math.max(1, Math.min(limits.requestTimeoutMs, remainingMs)),
            deadlineAt: deadline,
            init: {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                requests: batchIds.map((userId, index) => ({
                  id: String(index + 1),
                  method: 'GET',
                  url: `/users/${encodeURIComponent(userId)}/authentication/requirements`,
                })),
              }),
            },
          },
        )
        const parsed = JSON.parse(
          await readBoundedResponseText(response, limits.responseBytes),
        ) as unknown
        if (!plainRecord(parsed) || !Array.isArray(parsed.responses)) {
          throw new Error(
            'Microsoft per-user MFA-state synchronization returned an invalid batch response.',
          )
        }
        const responses = new Map<string, NonNullable<GraphBatchResponse['responses']>[number]>()
        for (const item of parsed.responses) {
          if (
            !plainRecord(item) ||
            typeof item.id !== 'string' ||
            responses.has(item.id)
          ) {
            throw new Error(
              'Microsoft per-user MFA-state synchronization returned an invalid batch item.',
            )
          }
          responses.set(
            item.id,
            item as NonNullable<GraphBatchResponse['responses']>[number],
          )
        }
        if (responses.size !== batchIds.length) {
          throw new Error(
            'Microsoft per-user MFA-state synchronization returned an incomplete batch response.',
          )
        }
        batchIds.forEach((userId, index) => {
          const item = responses.get(String(index + 1))
          if (item?.status !== 200 || !plainRecord(item.body)) return
          const state = normalizePerUserMfaState(item.body.perUserMfaState)
          if (state) states.set(userId, state)
        })
      }
    } catch (error) {
      this.logger.warn(
        `Per-user MFA state is unavailable. Registration data remains available. ${safeErrorMessage(
          error,
          'Microsoft did not return the per-user MFA requirement state.',
        )}`,
      )
      return withoutRequirement()
    }

    return registrations.map((row) => {
      if (!plainRecord(row) || typeof row.id !== 'string') return row
      return {
        ...row,
        perUserMfaState: states.get(row.id) ?? null,
        perUserMfaStateSource:
          'microsoft-graph-beta-authentication-requirements',
      }
    })
  }

  private async collectPerUserAuthenticationMethods(
    accessToken: string,
    limits: Readonly<AuthRegistrationFallbackLimits> =
      AUTH_REGISTRATION_FALLBACK_LIMITS,
  ) {
    assertAuthRegistrationFallbackLimits(limits)
    const deadline = Date.now() + limits.collectorDeadlineMs
    const users = await this.collectAuthenticationFallbackUsers(
      accessToken,
      limits,
      deadline,
    )
    const requiredBatches = Math.ceil(users.length / limits.batchSize)
    if (requiredBatches > limits.maxBatches) {
      throw new Error(
        `Microsoft per-user authentication-method synchronization exceeded the bounded ${limits.maxBatches}-batch limit; baseline was not advanced.`,
      )
    }
    const registrations: Array<Record<string, unknown>> = []
    const methodLabels: Record<string, string> = {
      '#microsoft.graph.fido2AuthenticationMethod':
        'FIDO2 security key or passkey',
      '#microsoft.graph.microsoftAuthenticatorAuthenticationMethod':
        'Microsoft Authenticator',
      '#microsoft.graph.phoneAuthenticationMethod': 'Phone',
      '#microsoft.graph.softwareOathAuthenticationMethod':
        'Software OATH token',
      '#microsoft.graph.windowsHelloForBusinessAuthenticationMethod':
        'Windows Hello for Business',
      '#microsoft.graph.temporaryAccessPassAuthenticationMethod':
        'Temporary Access Pass',
      '#microsoft.graph.platformCredentialAuthenticationMethod':
        'Platform credential',
      '#microsoft.graph.hardwareOathAuthenticationMethod':
        'Hardware OATH token',
    }

    for (let offset = 0; offset < users.length; offset += limits.batchSize) {
      const remainingMs = deadline - Date.now()
      if (remainingMs <= 0) {
        throw new Error(
          'Microsoft per-user authentication-method synchronization reached its bounded wall-clock deadline; baseline was not advanced.',
        )
      }
      const batchUsers = users.slice(offset, offset + limits.batchSize)
      const response = await this.fetchGraphPage(
        'https://graph.microsoft.com/v1.0/$batch',
        accessToken,
        'per-user authentication-method',
        {
          retryUnsafeMethod: true,
          timeoutMs: Math.max(1, Math.min(limits.requestTimeoutMs, remainingMs)),
          deadlineAt: deadline,
          init: {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            requests: batchUsers.map((user, index) => ({
              id: String(index + 1),
              method: 'GET',
              url: `/users/${encodeURIComponent(user.microsoftUserId)}/authentication/methods`,
            })),
          }),
          },
        },
      )
      const batch = JSON.parse(
        await readBoundedResponseText(response, limits.responseBytes),
      ) as unknown
      if (!plainRecord(batch) || !Array.isArray(batch.responses)) {
        throw new Error(
          'Microsoft per-user authentication-method synchronization returned an invalid batch response; baseline was not advanced.',
        )
      }
      const responsesById = new Map<string, NonNullable<GraphBatchResponse['responses']>[number]>()
      for (const item of batch.responses) {
        if (
          !plainRecord(item) ||
          typeof item.id !== 'string' ||
          responsesById.has(item.id)
        ) {
          throw new Error(
            'Microsoft per-user authentication-method synchronization returned an invalid batch response; baseline was not advanced.',
          )
        }
        responsesById.set(
          item.id,
          item as NonNullable<GraphBatchResponse['responses']>[number],
        )
      }
      if (responsesById.size !== batchUsers.length) {
        throw new Error(
          'Microsoft per-user authentication-method synchronization returned an incomplete batch response; baseline was not advanced.',
        )
      }
      batchUsers.forEach((user, index) => {
        const item = responsesById.get(String(index + 1))
        if (item?.status !== 200) {
          throw new Error(
            `Microsoft per-user authentication-method synchronization returned ${item?.status ?? 'an invalid response'}. Confirm UserAuthenticationMethod.Read.All application permission.`
          )
        }
        if (!plainRecord(item.body) || !Array.isArray(item.body.value)) {
          throw new Error(
            'Microsoft per-user authentication-method synchronization returned an invalid user-method response; baseline was not advanced.',
          )
        }
        const methods = item.body.value
          .map((method) => method['@odata.type'])
          .filter((type): type is string => typeof type === 'string')
        const registeredMfaMethods = [
          ...new Set(
            methods.map((type) => methodLabels[type]).filter(Boolean)
          ),
        ]
        registrations.push({
          id: user.microsoftUserId,
          userPrincipalName: user.userPrincipalName,
          isMfaRegistered: registeredMfaMethods.length > 0,
          isMfaCapable: registeredMfaMethods.length > 0,
          methodsRegistered: registeredMfaMethods,
          collectionSource: 'per-user-authentication-methods',
        })
      })
    }
    return registrations
  }

  private async collectAuthenticationFallbackUsers(
    accessToken: string,
    limits: Readonly<AuthRegistrationFallbackLimits>,
    deadline: number,
  ) {
    const users: Array<{
      microsoftUserId: string
      userPrincipalName: string
    }> = []
    const visited = new Set<string>()
    let pageCount = 0
    let nextUrl =
      'https://graph.microsoft.com/v1.0/users?$select=id,userPrincipalName&$top=999'
    while (nextUrl) {
      if (
        !nextUrl.startsWith('https://graph.microsoft.com/') ||
        visited.has(nextUrl)
      ) {
        throw new Error(
          'Microsoft returned an invalid or repeated users pagination link; authentication-registration baseline was not advanced.',
        )
      }
      visited.add(nextUrl)
      pageCount += 1
      if (pageCount > limits.maxUserPages) {
        throw new Error(
          `Microsoft authentication-registration user discovery exceeded the bounded ${limits.maxUserPages}-page limit; baseline was not advanced.`,
        )
      }
      const remainingMs = deadline - Date.now()
      if (remainingMs <= 0) {
        throw new Error(
          'Microsoft per-user authentication-method synchronization reached its bounded wall-clock deadline; baseline was not advanced.',
        )
      }
      const response = await this.fetchGraphPage(
        nextUrl,
        accessToken,
        'authentication-registration user discovery',
        {
          timeoutMs: Math.max(1, Math.min(limits.requestTimeoutMs, remainingMs)),
          deadlineAt: deadline,
        },
      )
      const parsed = JSON.parse(
        await readBoundedResponseText(response, limits.responseBytes),
      ) as unknown
      if (!plainRecord(parsed) || !Array.isArray(parsed.value)) {
        throw new Error(
          'Microsoft authentication-registration user discovery returned an invalid response; baseline was not advanced.',
        )
      }
      for (const row of parsed.value) {
        if (
          !plainRecord(row) ||
          typeof row.id !== 'string' ||
          !row.id ||
          typeof row.userPrincipalName !== 'string'
        ) {
          throw new Error(
            'Microsoft authentication-registration user discovery returned an invalid user; baseline was not advanced.',
          )
        }
        users.push({
          microsoftUserId: row.id,
          userPrincipalName: row.userPrincipalName,
        })
        if (users.length > limits.maxUsers) {
          throw new Error(
            `Microsoft per-user authentication-method synchronization exceeded the bounded ${limits.maxUsers}-user limit; baseline was not advanced.`,
          )
        }
      }
      const nextLink = parsed['@odata.nextLink']
      if (nextLink !== undefined && typeof nextLink !== 'string') {
        throw new Error(
          'Microsoft authentication-registration user discovery returned an invalid pagination link; baseline was not advanced.',
        )
      }
      nextUrl = nextLink ?? ''
    }
    users.sort((left, right) =>
      left.microsoftUserId.localeCompare(right.microsoftUserId),
    )
    return users
  }

  private async syncAuthenticationMethodPolicy(
    tenant: { id: string; organizationId: string },
    accessToken: string
  ) {
    return this.runSnapshotSync(tenant, 'AUTH_METHOD_POLICIES', async () => {
      const response = await this.fetchGraphPage(
        'https://graph.microsoft.com/v1.0/policies/authenticationMethodsPolicy',
        accessToken,
        'authentication-method policy',
      )
      const policy = (await response.json()) as {
        authenticationMethodConfigurations?: unknown[]
      }
      await this.saveEntraSnapshot(
        tenant,
        'AUTH_METHOD_POLICIES',
        policy.authenticationMethodConfigurations ?? []
      )
    })
  }

  private async fetchGraphCollection(
    initialUrl: string,
    accessToken: string,
    resourceLabel: string
  ) {
    const rows: any[] = []
    let nextUrl = initialUrl
    while (nextUrl) {
      if (!nextUrl.startsWith('https://graph.microsoft.com/')) {
        throw new Error(`Microsoft returned an invalid ${resourceLabel} link.`)
      }
      const response = await this.fetchGraphPage(nextUrl, accessToken, resourceLabel)
      const page = (await response.json()) as GraphCollectionPage
      rows.push(...(page.value ?? []))
      nextUrl = page['@odata.nextLink'] ?? ''
    }
    return rows
  }

  private async fetchGraphPage(
    url: string,
    accessToken: string,
    resourceLabel: string,
    options: {
      timeoutMs?: number
      deadlineAt?: number
      acceptedStatuses?: number[]
      init?: RequestInit
      retryUnsafeMethod?: boolean
    } = {},
  ) {
    const headers = new Headers(options.init?.headers)
    if (!headers.has('Authorization')) headers.set('Authorization', `Bearer ${accessToken}`)
    if (!headers.has('Accept')) headers.set('Accept', 'application/json')
    const response = await fetchMicrosoftWithRetry(
      url,
      { ...options.init, headers },
      {
        label: `Microsoft ${resourceLabel} synchronization`,
        timeoutMs: options.timeoutMs ?? 30_000,
        deadlineAt: options.deadlineAt,
        retryUnsafeMethod: options.retryUnsafeMethod,
      },
    )
    if (response.ok || options.acceptedStatuses?.includes(response.status)) return response

    const requestId = response.headers.get('request-id')
    const graphError = await readGraphOperationalError(response)
    throw new MicrosoftGraphCollectionError(
      `Microsoft ${resourceLabel} synchronization returned ${response.status}${
        requestId ? ` (request ${requestId})` : ''
      }${graphError.suffix}.`,
      response.status,
      graphError.code,
      requestId,
    )
  }

  private async logSyncStart(
    customerTenantId: string,
    resourceType: 'SIGN_INS' | 'AUDIT_LOGS'
  ) {
    const latest =
      resourceType === 'SIGN_INS'
        ? await this.prisma.signInLog.findFirst({
            where: { customerTenantId },
            orderBy: { eventDateTime: 'desc' },
            select: { eventDateTime: true },
          })
        : await this.prisma.directoryAuditLog.findFirst({
            where: { customerTenantId },
            orderBy: { eventDateTime: 'desc' },
            select: { eventDateTime: true },
          })
    return latest
      ? new Date(
          latest.eventDateTime.getTime() - LOG_SYNC_OVERLAP_MINUTES * 60_000
        )
      : new Date(Date.now() - INITIAL_LOG_LOOKBACK_DAYS * 24 * 60 * 60 * 1000)
  }

  private async syncSignInLogs(tenant: TenantSyncTarget, accessToken: string) {
    return this.runSnapshotSync(tenant, 'SIGN_INS', async () => {
      const start = await this.logSyncStart(tenant.id, 'SIGN_INS')
      const end = new Date()
      const entitlement = await this.signInEntitlement(tenant)
      const filter = encodeURIComponent(
        `createdDateTime ge ${start.toISOString()} and createdDateTime le ${end.toISOString()}`
      )
      let rows: any[]
      let limited = false
      let limitedReason: CollectionPartialError | null = null
      try {
        rows = await this.fetchGraphCollection(
          `https://graph.microsoft.com/v1.0/auditLogs/signIns?$filter=${filter}&$top=1000`,
          accessToken,
          'sign-in logs'
        )
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        if (
          !message.includes(
            'Authentication_RequestFromNonPremiumTenantOrB2CTenant'
          ) &&
          !message.includes("doesn't have premium license")
        ) {
          throw error
        }
        rows = await this.fetchLimitedLoginActivity(tenant, start, end)
        limited = true
        limitedReason = this.signInFallbackReason(entitlement)
      }
      const inferredLocations = limited
        ? await this.enrichLimitedSignInLocations(rows)
        : new Map<string, SignInLocation>()
      const ingestedAt = new Date()
      const expiresAt = logExpirationDate(ingestedAt)
      const records = rows
        .filter(
          (row) =>
            typeof row?.id === 'string' &&
            typeof row?.createdDateTime === 'string' &&
            Number.isFinite(new Date(row.createdDateTime).getTime())
        )
        .map((row) => ({
          organizationId: tenant.organizationId,
          customerTenantId: tenant.id,
          microsoftSignInId: limited ? `management:${row.id}` : row.id,
          eventDateTime: new Date(row.createdDateTime),
          userId: typeof row.userId === 'string' ? row.userId : null,
          userDisplayName:
            typeof row.userDisplayName === 'string'
              ? row.userDisplayName
              : null,
          userPrincipalName:
            typeof row.userPrincipalName === 'string'
              ? row.userPrincipalName.toLowerCase()
              : null,
          appId: typeof row.appId === 'string' ? row.appId : null,
          appDisplayName:
            typeof row.appDisplayName === 'string' ? row.appDisplayName : null,
          resourceDisplayName:
            typeof row.resourceDisplayName === 'string'
              ? row.resourceDisplayName
              : null,
          ipAddress: typeof row.ipAddress === 'string' ? row.ipAddress : null,
          clientAppUsed:
            typeof row.clientAppUsed === 'string' ? row.clientAppUsed : null,
          conditionalAccessStatus:
            typeof row.conditionalAccessStatus === 'string'
              ? row.conditionalAccessStatus
              : null,
          isInteractive:
            typeof row.isInteractive === 'boolean' ? row.isInteractive : null,
          riskLevel:
            typeof row.riskLevelAggregated === 'string'
              ? row.riskLevelAggregated
              : typeof row.riskLevelDuringSignIn === 'string'
                ? row.riskLevelDuringSignIn
                : null,
          statusErrorCode:
            row?.status?.errorCode === undefined
              ? null
              : String(row.status.errorCode),
          failureReason:
            typeof row?.status?.failureReason === 'string'
              ? row.status.failureReason
              : null,
          location: row.location ?? undefined,
          deviceDetail: row.deviceDetail ?? undefined,
          raw: redactSensitiveValues(limited
            ? {
                ...row,
                hawkviewSource: MANAGEMENT_ACTIVITY_SOURCE,
                hawkviewLimited: true,
              }
            : row),
          ingestedAt,
          expiresAt,
        }))
      if (records.length > 0) {
        await this.prisma.signInLog.createMany({
          data: records as never,
          skipDuplicates: true,
        })
      }
      if (limited && inferredLocations.size > 0) {
        await this.backfillLimitedSignInLocations(
          tenant.id,
          inferredLocations
        )
      }
      await this.prisma.signInLog.deleteMany({
        where: { customerTenantId: tenant.id, expiresAt: { lte: ingestedAt } },
      })
      await this.changeEvidence.pruneExpired(tenant.id, ingestedAt)
      if (limitedReason) throw limitedReason
    })
  }

  private async signInEntitlement(
    tenant: Pick<TenantSyncTarget, 'id' | 'organizationId'>,
  ): Promise<SignInEntitlement> {
    const [licenseSync, licenses] = await Promise.all([
      this.prisma.syncState.findFirst({
        where: {
          organizationId: tenant.organizationId,
          customerTenantId: tenant.id,
          resourceType: 'LICENSES',
        },
        select: { status: true, lastSuccessfulAt: true },
      }),
      this.prisma.tenantLicense.findMany({
        where: {
          organizationId: tenant.organizationId,
          customerTenantId: tenant.id,
        },
        select: { servicePlans: true },
      }),
    ])
    return deriveSignInEntitlement({ licenses, licenseSync })
  }

  private signInFallbackReason(entitlement: SignInEntitlement) {
    if (entitlement === 'PREMIUM') {
      return new CollectionPartialError(
        'sign-ins-premium-graph-fallback-active',
        'HawkView collected limited Microsoft 365 audit-feed login evidence because Microsoft Graph rejected full sign-in access even though current service plans confirm Entra ID P1/P2. Confirm AuditLog.Read.All and Directory.Read.All admin consent; HawkView will retry the full source automatically.',
      )
    }
    if (entitlement === 'NON_PREMIUM') {
      return new CollectionPartialError(
        'sign-ins-non-premium-fallback-active',
        'HawkView collected limited Microsoft 365 audit-feed login evidence because the current service plans do not include Entra ID P1/P2. Full Microsoft Graph sign-in details require Entra ID P1/P2.',
      )
    }
    return new CollectionPartialError(
      'sign-ins-entitlement-unverified-fallback-active',
      'HawkView collected limited Microsoft 365 audit-feed login evidence while the tenant sign-in entitlement remains unverified. HawkView will retry the full Microsoft Graph source automatically.',
    )
  }

  private async enrichLimitedSignInLocations(rows: any[]) {
    const locations = new Map<string, SignInLocation>()
    const uniqueIps = [
      ...new Set(
        rows
          .filter((row) => !this.hasCompleteSignInLocation(row?.location))
          .map((row) =>
            typeof row?.ipAddress === 'string' ? row.ipAddress.trim() : ''
          )
          .filter(Boolean)
      ),
    ]

    await Promise.all(
      uniqueIps.map(async (ipAddress) => {
        const location = await this.ipGeolocation.lookup(ipAddress)
        if (location) locations.set(ipAddress, location)
      })
    )

    for (const row of rows) {
      if (
        this.hasCompleteSignInLocation(row?.location) ||
        typeof row?.ipAddress !== 'string'
      ) {
        continue
      }
      const location = locations.get(row.ipAddress.trim())
      if (location) row.location = this.mergeSignInLocations(row.location, location)
    }

    return locations
  }

  private hasCompleteSignInLocation(location: unknown) {
    if (!location || typeof location !== 'object' || Array.isArray(location)) {
      return false
    }
    const value = location as Record<string, unknown>
    const coordinates = value.geoCoordinates
    return Boolean(
      this.locationText(value.city) &&
        this.locationText(value.countryOrRegion ?? value.country) &&
        coordinates &&
        typeof coordinates === 'object' &&
        !Array.isArray(coordinates) &&
        typeof (coordinates as Record<string, unknown>).latitude === 'number' &&
        typeof (coordinates as Record<string, unknown>).longitude === 'number'
    )
  }

  private locationText(value: unknown) {
    if (typeof value !== 'string') return null
    const text = value.trim()
    if (!text || ['unknown', 'undefined', 'null'].includes(text.toLowerCase())) {
      return null
    }
    return text
  }

  private mergeSignInLocations(
    microsoftLocation: unknown,
    inferredLocation: SignInLocation
  ): SignInLocation {
    const microsoft =
      microsoftLocation &&
      typeof microsoftLocation === 'object' &&
      !Array.isArray(microsoftLocation)
        ? (microsoftLocation as Record<string, unknown>)
        : {}
    const coordinates = microsoft.geoCoordinates
    const validCoordinates =
      coordinates &&
      typeof coordinates === 'object' &&
      !Array.isArray(coordinates) &&
      typeof (coordinates as Record<string, unknown>).latitude === 'number' &&
      typeof (coordinates as Record<string, unknown>).longitude === 'number'

    return {
      city: this.locationText(microsoft.city) ?? inferredLocation.city,
      state:
        this.locationText(microsoft.state ?? microsoft.region) ??
        inferredLocation.state,
      countryOrRegion:
        this.locationText(microsoft.countryOrRegion ?? microsoft.country) ??
        inferredLocation.countryOrRegion,
      geoCoordinates: validCoordinates
        ? (coordinates as SignInLocation['geoCoordinates'])
        : inferredLocation.geoCoordinates,
      source: inferredLocation.source,
    }
  }

  private async backfillLimitedSignInLocations(
    customerTenantId: string,
    inferredLocations: Map<string, SignInLocation>
  ) {
    const existing = await this.prisma.signInLog.findMany({
      where: {
        customerTenantId,
        microsoftSignInId: { startsWith: 'management:' },
        ipAddress: { in: [...inferredLocations.keys()] },
      },
      select: { id: true, ipAddress: true, location: true },
    })

    await Promise.all(
      existing.map((record) => {
        const inferred = record.ipAddress
          ? inferredLocations.get(record.ipAddress.trim())
          : undefined
        if (!inferred || this.hasCompleteSignInLocation(record.location)) {
          return Promise.resolve()
        }
        return this.prisma.signInLog.update({
          where: { id: record.id },
          data: {
            location: this.mergeSignInLocations(record.location, inferred),
          } as never,
        })
      })
    )
  }

  private async fetchLimitedLoginActivity(
    tenant: TenantSyncTarget,
    requestedStart: Date,
    end: Date
  ) {
    if (!tenant.connection) {
      throw new Error('The Microsoft tenant connection is incomplete.')
    }
    const { accessToken: token, publisherIdentifier } =
      await this.microsoftConsent.getTenantManagementActivityContext({
        microsoftTenantId: tenant.microsoftTenantId,
        connectionMode:
          tenant.connection.connectionMode === 'CUSTOMER_MANAGED'
            ? 'CUSTOMER_MANAGED'
            : 'HAWKVIEW_MANAGED',
        clientId: tenant.connection.clientId,
        credentialReference: tenant.connection.credentialReference,
      })
    const baseUrl = `https://manage.office.com/api/v1.0/${encodeURIComponent(tenant.microsoftTenantId)}/activity/feed`
    const activityUrl = (url: string) => {
      const parsed = validateManagementUrl(url, tenant.microsoftTenantId)
      parsed.searchParams.set('PublisherIdentifier', publisherIdentifier)
      return parsed.toString()
    }
    const headers = {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
    }
    const contentType = 'Audit.AzureActiveDirectory'
    const subscriptionIsEnabled = async () => {
      const response = await this.fetchGraphPage(
        activityUrl(`${baseUrl}/subscriptions/list`),
        token,
        '365 activity subscription verification',
        { timeoutMs: 20_000, init: { headers } },
      )
      const subscriptions = (await response.json()) as Array<{
        contentType?: string
        status?: string
      }>
      return subscriptions.some(
        (subscription) =>
          subscription.contentType === contentType &&
          subscription.status?.toLowerCase() === 'enabled'
      )
    }

    if (!(await subscriptionIsEnabled())) {
      // Subscription lifecycle has one owner: M365ManagementActivityService.
      // It persists Microsoft's mandatory 15-minute start cooldown. The
      // limited-license sign-in fallback must never race it with another POST.
      throw new CollectionInitializingError(
        'sign-ins-audit-subscription-initializing',
        'Microsoft is activating the audit subscription used for fallback sign-in collection. HawkView will retry automatically during scheduled collection.'
      )
    }

    const earliest = new Date(
      Date.now() - MANAGEMENT_ACTIVITY_MAX_LOOKBACK_DAYS * 24 * 60 * 60 * 1000
    )
    let windowStart = requestedStart > earliest ? requestedStart : earliest
    const contentUris: string[] = []
    while (windowStart < end) {
      const windowEnd = new Date(
        Math.min(end.getTime(), windowStart.getTime() + 23 * 60 * 60 * 1000)
      )
      let pageUrl = `${baseUrl}/subscriptions/content?contentType=${encodeURIComponent(contentType)}&startTime=${encodeURIComponent(windowStart.toISOString())}&endTime=${encodeURIComponent(windowEnd.toISOString())}`
      while (pageUrl) {
        const response = await this.fetchGraphPage(
          activityUrl(pageUrl),
          token,
          '365 limited login activity',
          { timeoutMs: 30_000, init: { headers } },
        )
        const items = (await response.json()) as Array<{ contentUri?: string }>
        for (const item of items) {
          if (typeof item.contentUri === 'string')
            contentUris.push(item.contentUri)
        }
        pageUrl = response.headers.get('NextPageUri') ?? ''
        if (pageUrl) validateManagementUrl(pageUrl, tenant.microsoftTenantId)
      }
      windowStart = new Date(windowEnd.getTime() + 1)
    }

    const records: any[] = []
    for (const contentUri of [...new Set(contentUris)]) {
      const response = await this.fetchGraphPage(
        activityUrl(contentUri),
        token,
        '365 limited login activity content',
        { timeoutMs: 30_000, init: { headers } },
      )
      const content = (await response.json()) as any[]
      records.push(...content)
    }

    return records
      .filter(isManagementActivityLogin)
      .filter(
        (record) =>
          typeof record?.Id === 'string' &&
          typeof record?.CreationTime === 'string' &&
          Number.isFinite(new Date(record.CreationTime).getTime())
      )
      .map((record) => {
        const succeeded = managementActivityLoginSucceeded(record)
        const userPrincipalName =
          typeof record.UserId === 'string' ? record.UserId.toLowerCase() : null
        const countryOrRegion =
          typeof record.Country === 'string'
            ? record.Country
            : typeof record.CountryOrRegion === 'string'
              ? record.CountryOrRegion
              : null
        const city = typeof record.City === 'string' ? record.City : null
        return {
          id: record.Id,
          createdDateTime: record.CreationTime,
          userId:
            typeof record.ObjectId === 'string'
              ? record.ObjectId
              : typeof record.UserKey === 'string'
                ? record.UserKey
                : null,
          userDisplayName:
            typeof record.UserDisplayName === 'string'
              ? record.UserDisplayName
              : null,
          userPrincipalName,
          appId: null,
          appDisplayName:
            typeof record.Application === 'string'
              ? record.Application
              : 'Microsoft 365',
          resourceDisplayName: record.Workload ?? null,
          ipAddress:
            typeof record.ClientIP === 'string' ? record.ClientIP : null,
          clientAppUsed: record.Application ?? null,
          conditionalAccessStatus: null,
          isInteractive: null,
          riskLevelAggregated: null,
          status: {
            errorCode: succeeded
              ? 0
              : String(record.LoginStatus ?? record.ErrorCode ?? 1),
            failureReason: succeeded
              ? null
              : String(
                  record.LogonError ??
                    managementActivityExtendedProperty(
                      record,
                      'LoginError',
                      'LogonError'
                    ) ??
                    record.Operation
                ),
          },
          location: countryOrRegion || city ? { countryOrRegion, city } : null,
          deviceDetail: null,
          managementActivityRecord: record,
        }
      })
  }

  private async syncDirectoryAuditLogs(
    tenant: TenantSyncTarget,
    accessToken: string,
    reconcileChanges = true
  ) {
    return this.runSnapshotSync(tenant, 'AUDIT_LOGS', async () => {
      const start = await this.logSyncStart(tenant.id, 'AUDIT_LOGS')
      const end = new Date()
      const filter = encodeURIComponent(
        `activityDateTime ge ${start.toISOString()} and activityDateTime le ${end.toISOString()}`
      )
      const rows = await this.fetchGraphCollection(
        `https://graph.microsoft.com/v1.0/auditLogs/directoryAudits?$filter=${filter}&$top=1000`,
        accessToken,
        'directory audit logs'
      )
      const ingestedAt = new Date()
      const expiresAt = logExpirationDate(ingestedAt)
      const records = rows
        .filter(
          (row) =>
            typeof row?.id === 'string' &&
            typeof row?.activityDateTime === 'string' &&
            typeof row?.activityDisplayName === 'string' &&
            Number.isFinite(new Date(row.activityDateTime).getTime())
        )
        .map((row) => ({
          organizationId: tenant.organizationId,
          customerTenantId: tenant.id,
          microsoftAuditId: row.id,
          eventDateTime: new Date(row.activityDateTime),
          activityDisplayName: row.activityDisplayName,
          category: typeof row.category === 'string' ? row.category : null,
          operationType:
            typeof row.operationType === 'string' ? row.operationType : null,
          result: typeof row.result === 'string' ? row.result : null,
          resultReason:
            typeof row.resultReason === 'string' ? row.resultReason : null,
          correlationId:
            typeof row.correlationId === 'string' ? row.correlationId : null,
          loggedByService:
            typeof row.loggedByService === 'string'
              ? row.loggedByService
              : null,
          initiatedBy: row.initiatedBy ?? undefined,
          targetResources: row.targetResources ?? undefined,
          additionalDetails: row.additionalDetails ?? undefined,
          raw: redactSensitiveValues(row),
          ingestedAt,
          expiresAt,
        }))
      const existingAuditIds =
        records.length > 0
          ? new Set(
              (
                await this.prisma.directoryAuditLog.findMany({
                  where: {
                    customerTenantId: tenant.id,
                    microsoftAuditId: {
                      in: records.map((record) => record.microsoftAuditId),
                    },
                  },
                  select: { microsoftAuditId: true },
                })
              ).map((record) => record.microsoftAuditId)
            )
          : new Set<string>()
      const newRecords = records.filter(
        (record) => !existingAuditIds.has(record.microsoftAuditId)
      )
      if (records.length > 0) {
        await this.prisma.directoryAuditLog.createMany({
          data: records as never,
          skipDuplicates: true,
        })
        await this.changeEvidence.projectDirectoryAudits(tenant, records)
      }
      // The users delta query ran immediately before the audit collector. For
      // every other recognized directory change, use the audit feed as a
      // lightweight trigger for its own collection instead of waiting for the
      // daily inventory pass or re-reading the entire tenant.
      if (reconcileChanges) {
        await this.reconcileDirectoryAuditChanges(tenant, accessToken, newRecords)
      }
      for (const record of newRecords) {
        const activity = record.activityDisplayName.toLowerCase()
        const securityEvent =
          activity.includes('authentication method') || activity.includes('mfa')
            ? {
                severity: 'critical' as const,
                label: 'Authentication methods changed',
              }
            : activity.includes('password')
              ? {
                  severity: 'high' as const,
                  label: 'Password-related change detected',
                }
              : activity.includes('application') ||
                  activity.includes('service principal')
                ? {
                    severity: 'high' as const,
                    label: 'Application registration changed',
                  }
                : activity.includes('role') ||
                    activity.includes('administrator')
                  ? {
                      severity: 'critical' as const,
                      label: 'Administrative role changed',
                    }
                  : null
        if (!securityEvent) continue
        await this.notifications.publishIncident({
          organizationId: tenant.organizationId,
          customerTenantId: tenant.id,
          eventType: 'security.directory_change',
          category:
            securityEvent.severity === 'critical' ? 'error' : 'warning',
          severity: securityEvent.severity,
          title: securityEvent.label,
          description: record.activityDisplayName,
          dedupeKey: `security:directory-audit:${record.microsoftAuditId}`,
          source: 'microsoft.directoryAudit',
          actionUrl: `/what-changed?tenantId=${encodeURIComponent(tenant.id)}&from=${encodeURIComponent(record.eventDateTime.toISOString())}`,
          actionLabel: 'Investigate change',
          metadata: {
            microsoftAuditId: record.microsoftAuditId,
            eventDateTime: record.eventDateTime.toISOString(),
            result: record.result,
            category: record.category,
          },
        })
      }
      await this.prisma.directoryAuditLog.deleteMany({
        where: { customerTenantId: tenant.id, expiresAt: { lte: ingestedAt } },
      })
      await this.changeEvidence.pruneExpired(tenant.id, ingestedAt)
    })
  }

  private async syncM365AuditActivity(
    tenant: TenantSyncTarget,
    graphAccessToken: string
  ) {
    const changes = await this.m365ManagementActivity.syncTenant(tenant)
    if (changes.length > 0) {
      // The activity feed is evidence. Coalesce all records in this polling
      // run into the smallest set of authoritative current-state refreshes.
      await this.reconcileDirectoryAuditChanges(
        tenant,
        graphAccessToken,
        changes
      )
    }
    return { collectedChanges: changes.length }
  }

  /**
   * Audit records are evidence, not the canonical object representation. A
   * group-membership event therefore refreshes Groups from Graph and rewrites
   * only HawkView's group projection; it never tries to infer an incomplete
   * membership delta from a human-readable audit message.
   */
  private async reconcileDirectoryAuditChanges(
    tenant: TenantSyncTarget,
    accessToken: string,
    records: Array<{
      activityDisplayName: string
      category?: string | null
      loggedByService?: string | null
      targetResources?: unknown
    }>
  ) {
    const resources = deriveAuditReconciliationResources(records)
    if (resources.length === 0) return

    const synchronizers: Record<AuditReconciliationResource, () => Promise<unknown>> = {
      ORGANIZATION_CONFIGURATION: () =>
        this.syncOrganizationConfiguration(tenant, accessToken),
      GROUPS: () => this.syncGroups(tenant, accessToken),
      LICENSES: () => this.syncLicenses(tenant, accessToken),
      DOMAINS: () => this.syncDomains(tenant, accessToken),
      DOMAIN_DNS_HEALTH: () => this.syncDomainDnsHealth(tenant),
      AUTH_REGISTRATIONS: () =>
        this.syncAuthenticationRegistrations(tenant, accessToken),
      AUTH_METHOD_POLICIES: () =>
        this.syncAuthenticationMethodPolicy(tenant, accessToken),
      CONDITIONAL_ACCESS: () =>
        this.syncEntraCollection(
          tenant,
          accessToken,
          'CONDITIONAL_ACCESS',
          'https://graph.microsoft.com/v1.0/identity/conditionalAccess/policies'
        ),
      NAMED_LOCATIONS: () =>
        this.syncEntraCollection(
          tenant,
          accessToken,
          'NAMED_LOCATIONS',
          'https://graph.microsoft.com/v1.0/identity/conditionalAccess/namedLocations'
        ),
      DEVICES: () =>
        this.syncEntraCollection(
          tenant,
          accessToken,
          'DEVICES',
          'https://graph.microsoft.com/v1.0/devices?$select=id,deviceId,displayName,operatingSystem,operatingSystemVersion,trustType,isCompliant,isManaged,accountEnabled,approximateLastSignInDateTime&$expand=registeredOwners($select=id)'
        ),
      DIRECTORY_ROLES: () =>
        this.syncEntraCollection(
          tenant,
          accessToken,
          'DIRECTORY_ROLES',
          'https://graph.microsoft.com/v1.0/roleManagement/directory/roleAssignments?$expand=roleDefinition($select=id,displayName)'
        ),
      SERVICE_PRINCIPALS: () =>
        this.syncEntraCollection(
          tenant,
          accessToken,
          'SERVICE_PRINCIPALS',
          'https://graph.microsoft.com/v1.0/servicePrincipals?$select=id,appId,displayName,description,servicePrincipalType,accountEnabled,appRoleAssignmentRequired,createdDateTime,homepage,loginUrl,publisherName,verifiedPublisher,tags,preferredSingleSignOnMode,notificationEmailAddresses,appRoles,oauth2PermissionScopes&$expand=appRoleAssignedTo($select=id,principalId,principalType,principalDisplayName,appRoleId)'
        ),
      APPLICATIONS: () =>
        this.syncEntraCollection(
          tenant,
          accessToken,
          'APPLICATIONS',
          'https://graph.microsoft.com/v1.0/applications?$select=id,appId,displayName,description,createdDateTime,signInAudience,publisherDomain,identifierUris,web,passwordCredentials,keyCredentials,requiredResourceAccess&$expand=owners($select=id,displayName,userPrincipalName)'
        ),
      SECURITY_DEFAULTS: () => this.syncSecurityDefaults(tenant, accessToken),
      EXCHANGE_MAILBOXES: () =>
        this.syncExchangeMailboxDirectory(tenant, accessToken),
      EXCHANGE_MAILBOX_SETTINGS: () =>
        this.syncExchangeMailboxSettings(tenant, accessToken),
      EXCHANGE_MAILBOX_USAGE: () =>
        this.syncExchangeMailboxUsage(tenant, accessToken),
      EXCHANGE_ACCEPTED_DOMAINS: () =>
        this.syncExchangeAcceptedDomains(tenant, accessToken),
      EXCHANGE_MAILBOX_RULES: () =>
        this.syncExchangeMailboxRules(tenant, accessToken),
      SHAREPOINT_SITES: () => this.syncSharePointSites(tenant, accessToken),
      SHAREPOINT_SETTINGS: () =>
        this.syncSharePointSettings(tenant, accessToken),
      SHAREPOINT_USAGE: () => this.syncSharePointUsage(tenant, accessToken),
    }

    const results = await Promise.allSettled(
      resources.map((resource) => synchronizers[resource]())
    )
    results.forEach((result, index) => {
      if (result.status !== 'rejected') return
      const resource = resources[index] ?? 'UNKNOWN'
      const message =
        result.reason instanceof Error
          ? result.reason.message
          : String(result.reason)
      this.logger.warn(
        `Audit-triggered ${resource} reconciliation was unavailable for tenant ${tenant.id}: ${message}`
      )
    })
  }

  private async saveSnapshot(
    tenant: { id: string; organizationId: string },
    resourceType: EntraSnapshotResource,
    result: SnapshotCollectionResult,
    /** Resource inventory writes which must become visible with this baseline. */
    persistWithSnapshot?: (transaction: Prisma.TransactionClient) => Promise<void>,
  ) {
    if (result.completeness !== 'authoritative_complete') {
      throw new Error(
        `Refusing to advance ${resourceType} snapshot baseline from a partial or unverified collection.`
      )
    }
    const rows = result.rows
    const observedAt = new Date()
    // A baseline and its evidence must move together.  The first snapshot has
    // no prior successful collection and intentionally creates no change. A
    // PostgreSQL transaction advisory lock serializes this resource across
    // concurrent workers so they cannot compare against one stale baseline.
    await this.prisma.$transaction(async (transaction) => {
      await transaction.$executeRawUnsafe(
        'SELECT pg_advisory_xact_lock(hashtext($1))',
        `hawkview:snapshot:${tenant.id}:${resourceType}`
      )
      const existing = await transaction.tenantEntraSnapshot.findUnique({
        where: { customerTenantId_resourceType: { customerTenantId: tenant.id, resourceType } },
        select: { payload: true, observedAt: true, organizationId: true },
      })
      if (existing && existing.organizationId !== tenant.organizationId) {
        throw new Error('Snapshot organization mismatch; refusing cross-organization comparison.')
      }
      const previousRows = Array.isArray(existing?.payload) ? existing.payload : []
      // This method only accepts a collector result that explicitly attests
      // to complete pagination. A legitimate empty inventory can therefore
      // remove prior objects, while failed or partial reads cannot advance
      // the baseline or create mass-removal evidence.
      const evidence = this.changeEvidence.buildSnapshotDifferenceEvidence({
        tenant, resourceType, previousPayload: existing?.payload, currentPayload: rows,
        observedAt, baselineObservedAt: existing?.observedAt, expiresAt: logExpirationDate(observedAt),
      })
      if (evidence.length > 0) {
        await transaction.changeEvidenceEvent.createMany({
          data: evidence as never,
          skipDuplicates: true,
        })
      }
      if (persistWithSnapshot) await persistWithSnapshot(transaction)
      await transaction.tenantEntraSnapshot.upsert({
        where: {
          customerTenantId_resourceType: {
            customerTenantId: tenant.id,
            resourceType,
          },
        },
        create: {
          organizationId: tenant.organizationId,
          customerTenantId: tenant.id,
          resourceType,
          payload: rows as never,
          observedAt,
        },
        update: { payload: rows as never, observedAt },
      })
    })
  }

  private async syncExchangeMailboxDirectory(
    tenant: { id: string; organizationId: string },
    accessToken: string
  ) {
    return this.runSnapshotSync(tenant, 'EXCHANGE_MAILBOXES', async () => {
      const initialUrl =
        'https://graph.microsoft.com/v1.0/users?$select=id,displayName,userPrincipalName,mail,proxyAddresses,accountEnabled,assignedLicenses&$top=999'
      const directoryUsers = await collectMailboxDirectoryPages(
        initialUrl,
        async (nextUrl) => {
        if (!nextUrl.startsWith('https://graph.microsoft.com/')) {
          throw new Error(
            'Microsoft returned an invalid users pagination link.'
          )
        }
        const response = await this.fetchGraphPage(
          nextUrl,
          accessToken,
          'mailbox directory',
          { timeoutMs: 30_000 },
        )
          return (await response.json()) as GraphCollectionPage
        }
      )
      const rows = directoryUsers
        .filter(
          (user: any) =>
            typeof user?.mail === 'string' ||
            (Array.isArray(user?.assignedLicenses) &&
              user.assignedLicenses.length > 0)
        )
        .map((user: any) => ({
          id: user.id,
          displayName: user.displayName,
          userPrincipalName: user.userPrincipalName,
          mail: user.mail,
          proxyAddresses: user.proxyAddresses ?? [],
          accountEnabled: user.accountEnabled !== false,
        }))
      await this.saveSnapshot(tenant, 'EXCHANGE_MAILBOXES', authoritativeSnapshot(rows))
    })
  }

  /**
   * Graph's mailboxSettings endpoint supplies the mailbox purpose (user,
   * shared, room, or equipment) without requiring an Exchange Online RBAC
   * assignment.  It intentionally stays separate from deep Exchange Admin API
   * configuration such as retention and delegation.
   */
  private async syncExchangeMailboxSettings(
    tenant: { id: string; organizationId: string },
    accessToken: string
  ) {
    return this.runSnapshotSync(tenant, 'EXCHANGE_MAILBOX_SETTINGS', async () => {
      const users = await collectMailboxRuleUsers((skip, take) =>
        this.prisma.directoryUser.findMany({
          where: { customerTenantId: tenant.id, deletedAt: null },
          select: { microsoftUserId: true, userPrincipalName: true },
          orderBy: { microsoftUserId: 'asc' },
          skip,
          take,
        })
      )
      const rows: unknown[] = []
      for (let index = 0; index < users.length; index += 5) {
        const batch = users.slice(index, index + 5)
        const results = await Promise.all(
          batch.map(async (user) => {
            const response = await this.fetchGraphPage(
              `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(user.microsoftUserId)}/mailboxSettings?$select=userPurpose,timeZone`,
              accessToken,
              'mailbox settings',
              { timeoutMs: 20_000, acceptedStatuses: [404] },
            )
            // Not every directory user has an Exchange mailbox.  That is a
            // valid empty result rather than an Exchange synchronization error.
            if (response.status === 404) return null
            if (!response.ok) {
              throw new Error(
                `Microsoft mailbox settings synchronization returned ${response.status}. Confirm MailboxSettings.Read application permission.`
              )
            }
            const settings = (await response.json()) as Record<string, unknown>
            return {
              ...settings,
              mailboxUserId: user.microsoftUserId,
              mailboxUpn: user.userPrincipalName,
            }
          })
        )
        rows.push(...results.filter((row) => row !== null))
      }
      await this.saveSnapshot(tenant, 'EXCHANGE_MAILBOX_SETTINGS', authoritativeSnapshot(rows))
    })
  }

  private async collectExchangeReadOnlyMailboxes(
    tenant: TenantSyncTarget,
    accessToken: string,
  ): Promise<ExchangeReadOnlyMailbox[]> {
    const select = [
      'ExternalDirectoryObjectId',
      'UserPrincipalName',
      'PrimarySmtpAddress',
      'DisplayName',
      'RecipientType',
      'RecipientTypeDetails',
      'MaxSendSize',
      'GrantSendOnBehalfTo',
      'GrantSendOnBehalfToWithDisplayNames',
    ].join(',')
    const requestBody = {
      CmdletInput: {
        CmdletName: 'Get-Mailbox',
        Parameters: {
          ResultSize: 'Unlimited',
          IncludeGrantSendOnBehalfToWithDisplayNames: true,
        },
      },
    }
    const rows: ExchangeReadOnlyMailbox[] = []
    const visited = new Set<string>()
    const deadlineAt = Date.now() + 4 * 60 * 1_000
    let nextUrl = `https://outlook.office365.com/adminapi/v2.0/${encodeURIComponent(tenant.microsoftTenantId)}/Mailbox?$select=${encodeURIComponent(select)}`
    while (nextUrl) {
      if (!nextUrl.startsWith('https://outlook.office365.com/')) {
        throw new Error('Microsoft returned an invalid Exchange pagination link.')
      }
      if (visited.size >= 50 || visited.has(nextUrl)) {
        throw new Error('Microsoft Exchange pagination exceeded the read-only collection safety limit.')
      }
      visited.add(nextUrl)
      const remainingMs = deadlineAt - Date.now()
      if (remainingMs <= 0) {
        throw new Error('Microsoft Exchange read-only collection exceeded its four-minute safety limit.')
      }
      const response = await this.fetchGraphPage(
        nextUrl,
        accessToken,
        'Exchange read-only mailbox configuration',
        {
          timeoutMs: Math.min(60_000, remainingMs),
          deadlineAt,
          retryUnsafeMethod: true,
          init: {
            method: 'POST',
            headers: {
              Accept: 'application/json',
              'Content-Type': 'application/json',
              'X-AnchorMailbox': `APP:SystemMailbox{bb558c35-97f1-4cb9-8ff7-d53741dc928c}@${tenant.microsoftTenantId}`,
            },
            body: JSON.stringify(requestBody),
          },
        },
      )
      const page = await response.json() as unknown
      const pageRecord = page && typeof page === 'object' && !Array.isArray(page)
        ? page as Record<string, unknown>
        : null
      rows.push(...projectExchangeReadOnlyPage(
        Array.isArray(page) ? page : pageRecord?.value ?? [],
      ))
      if (rows.length > 20_000) {
        throw new Error('Microsoft Exchange returned more than 20,000 mailboxes; the baseline was not advanced.')
      }
      nextUrl = typeof pageRecord?.['@odata.nextLink'] === 'string'
        ? pageRecord['@odata.nextLink']
        : ''
    }
    return rows
  }

  private async syncExchangeMailboxConfiguration(tenant: TenantSyncTarget) {
    return this.runSnapshotSync(tenant, 'EXCHANGE_MAILBOX_CONFIGURATION', async () => {
      if (!tenant.connection?.exchangeReadOnlyEnabledAt) {
        throw new Error('Optional Exchange read-only enrichment is not enabled for this tenant.')
      }
      const accessToken = await this.microsoftConsent.getTenantExchangeAccessToken({
        microsoftTenantId: tenant.microsoftTenantId,
        connectionMode: tenant.connection.connectionMode === 'CUSTOMER_MANAGED'
          ? 'CUSTOMER_MANAGED'
          : 'HAWKVIEW_MANAGED',
        clientId: tenant.connection.clientId,
        credentialReference: tenant.connection.credentialReference,
      })
      const rows = await this.collectExchangeReadOnlyMailboxes(tenant, accessToken)
      await this.saveSnapshot(
        tenant,
        'EXCHANGE_MAILBOX_CONFIGURATION',
        authoritativeSnapshot(rows),
      )
    })
  }

  private async syncExchangeAcceptedDomains(
    tenant: { id: string; organizationId: string },
    accessToken: string
  ) {
    return this.runSnapshotSync(
      tenant,
      'EXCHANGE_ACCEPTED_DOMAINS',
      async () => {
        const response = await this.fetchGraphPage(
          'https://graph.microsoft.com/v1.0/organization?$select=verifiedDomains',
          accessToken,
          'accepted-domain',
          { timeoutMs: 30_000 },
        )
        const page = (await response.json()) as { value?: GraphOrganization[] }
        // Organization.Read.All returns tenant-associated verifiedDomains.
        // These are not Exchange accepted-domain objects, so do not invent an
        // Authoritative/InternalRelay type. Preserve only the fields Graph
        // actually returned and label the customer contract accordingly.
        const domains = (page.value?.[0]?.verifiedDomains ?? [])
          .filter(
            (domain: any) => typeof domain?.name === 'string' && domain.name.trim()
          )
          .map((domain: any) => ({
            id: domain.name,
            domain: domain.name,
            associationType:
              typeof domain.type === 'string' && domain.type.trim()
                ? domain.type.trim()
                : null,
            capabilities:
              typeof domain.capabilities === 'string' && domain.capabilities.trim()
                ? domain.capabilities.trim()
                : null,
            isDefault: Boolean(domain.isDefault),
            isInitial: Boolean(domain.isInitial),
          }))
        await this.saveSnapshot(tenant, 'EXCHANGE_ACCEPTED_DOMAINS', authoritativeSnapshot(domains))
      }
    )
  }

  private async syncExchangeMailboxUsage(
    tenant: { id: string; organizationId: string },
    accessToken: string
  ) {
    return this.runSnapshotSync(tenant, 'EXCHANGE_MAILBOX_USAGE', async () => {
      const response = await this.fetchGraphPage(
        "https://graph.microsoft.com/v1.0/reports/getMailboxUsageDetail(period='D30')",
        accessToken,
        'mailbox usage',
        {
          timeoutMs: 30_000,
          acceptedStatuses: [302],
          init: { headers: { Accept: 'text/csv' }, redirect: 'manual' },
        },
      )
      let csv = ''
      if (response.ok) csv = await response.text()
      else if (response.status === 302) {
        const location = response.headers.get('location')
        if (!location?.startsWith('https://'))
          throw new Error(
            'Microsoft returned an invalid mailbox usage report link.'
          )
        const download = await fetchMicrosoftWithRetry(
          location,
          { headers: { Accept: 'text/csv,application/octet-stream' } },
          { label: 'Microsoft mailbox usage report download', timeoutMs: 30_000 },
        )
        if (!download.ok)
          throw new Error(
            `Microsoft mailbox usage report download returned ${download.status}.`
          )
        csv = await download.text()
      } else {
        throw new Error(
          `Microsoft mailbox usage synchronization returned ${response.status}.`
        )
      }
      await this.saveSnapshot(
        tenant,
        'EXCHANGE_MAILBOX_USAGE',
        authoritativeSnapshot(parseCsvRows(csv))
      )
    })
  }

  private async syncExchangeMailboxRules(
    tenant: { id: string; organizationId: string },
    accessToken: string
  ) {
    return this.runSnapshotSync(tenant, 'EXCHANGE_MAILBOX_RULES', async () => {
      const users = await collectMailboxRuleUsers((skip, take) => this.prisma.directoryUser.findMany({
        where: { customerTenantId: tenant.id, deletedAt: null },
        select: { microsoftUserId: true, userPrincipalName: true }, orderBy: { microsoftUserId: 'asc' }, skip, take,
      }))
      const rows = await collectMailboxRules(users, async (user, continuation) => {
        const url = continuation ?? `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(user.microsoftUserId)}/mailFolders/inbox/messageRules?$top=100`
        if (!url.startsWith('https://graph.microsoft.com/')) throw new Error('Microsoft returned an invalid inbox-rules pagination link.')
        const response = await this.fetchGraphPage(
          url, accessToken, 'inbox rules', { timeoutMs: 20_000, acceptedStatuses: [404] },
        )
        if (response.status === 404) return { value: [] }
        return (await response.json()) as GraphCollectionPage
      })
      await this.saveSnapshot(tenant, 'EXCHANGE_MAILBOX_RULES', authoritativeSnapshot(rows))
    })
  }

  private async syncSharePointSites(
    tenant: TenantSyncTarget,
    accessToken: string,
    limits: typeof SHAREPOINT_COLLECTION_LIMITS = SHAREPOINT_COLLECTION_LIMITS,
  ) {
    return this.runSnapshotSync(tenant, 'SHAREPOINT_SITES', async () => {
      const deadlineAt = Date.now() + limits.collectorDeadlineMs // safely below the 15-minute tenant lease
      const maxSitePages = limits.sitePages
      const maxSites = limits.sites
      const sites: any[] = []
      const siteFields =
        'id,name,displayName,webUrl,createdDateTime,lastModifiedDateTime,root,siteCollection'

      // Microsoft Graph site search can return an empty collection even when
      // the tenant's root SharePoint site exists. Fetch the root explicitly so
      // a provisioned tenant never appears as an empty SharePoint environment.
      const rootResponse = await this.fetchGraphPage(
        `https://graph.microsoft.com/v1.0/sites/root?$select=${siteFields}`,
        accessToken,
        'SharePoint root site',
        {
          timeoutMs: sharePointRequestTimeout(deadlineAt, limits.requestTimeoutMs),
          deadlineAt,
          acceptedStatuses: [404],
        },
      )
      if (rootResponse.ok) {
        sites.push((await readBoundedSharePointJson(rootResponse, limits.responseBytes)) as any)
      } else if (rootResponse.status !== 404) {
        throw new Error(
          `Microsoft SharePoint root site synchronization returned ${rootResponse.status}.`
        )
      }

      let nextUrl = `https://graph.microsoft.com/v1.0/sites?search=*&$select=${siteFields}`
      let sitePages = 0
      const seenSitePages = new Set<string>()
      while (nextUrl) {
        if (++sitePages > maxSitePages || Date.now() >= deadlineAt) throw new Error('SharePoint site inventory reached a bounded collection limit before completion.')
        if (!nextUrl.startsWith('https://graph.microsoft.com/')) {
          throw new Error(
            'Microsoft returned an invalid SharePoint sites link.'
          )
        }
        if (seenSitePages.has(nextUrl)) {
          throw new Error('SharePoint site inventory returned a repeated pagination link.')
        }
        seenSitePages.add(nextUrl)
        const response = await this.fetchGraphPage(
          nextUrl,
          accessToken,
          'SharePoint sites',
          { timeoutMs: sharePointRequestTimeout(deadlineAt, limits.requestTimeoutMs), deadlineAt },
        )
        const page = (await readBoundedSharePointJson(response, limits.responseBytes)) as GraphCollectionPage
        sites.push(...((page.value ?? []) as any[]))
        if (sites.length > maxSites) throw new Error('SharePoint site inventory reached a bounded record limit before completion.')
        nextUrl = page['@odata.nextLink'] ?? ''
      }

      const uniqueSites = Array.from(
        new Map(
          sites
            .filter((site) => typeof site?.id === 'string')
            .map((site) => [site.id, site])
        ).values()
      )
      const enrichedSites = uniqueSites.map((site) => ({
        ...site,
        // Microsoft Graph does not support application authentication for
        // GET /sites/{siteId}/drive. Site storage facts come from the bounded
        // Reports.Read.All usage collector instead, so site inventory must not
        // depend on an unsupported per-site drive request.
        driveQuota: null,
        // Standard mode intentionally avoids SharePoint-resource access
        // enrichment. Never carry old privileged access observations forward
        // as current.
        externalSharing: null,
        guestsCount: null,
        sharingCapability: null,
        siteAccessMetadataState: 'NOT_COLLECTED_LEAST_PRIVILEGE',
      }))

      await this.saveSnapshot(
        tenant,
        'SHAREPOINT_SITES',
        authoritativeSnapshot(enrichedSites)
      )
    })
  }

  private async syncSharePointSettings(
    tenant: { id: string; organizationId: string },
    accessToken: string
  ) {
    return this.runSnapshotSync(tenant, 'SHAREPOINT_SETTINGS', async () => {
      const response = await this.fetchGraphPage(
        'https://graph.microsoft.com/v1.0/admin/sharepoint/settings',
        accessToken,
        'SharePoint settings',
      )
      const body = (await response.json()) as any
      // Microsoft documentation has shown both the resource directly and a
      // single resource under `value`; normalize either response shape.
      const settings = Array.isArray(body?.value)
        ? body.value[0]
        : body?.value && typeof body.value === 'object'
          ? body.value
          : body

      if (!settings || typeof settings !== 'object') {
        throw new Error(
          'Microsoft SharePoint settings synchronization returned an empty response.'
        )
      }

      await this.saveSnapshot(tenant, 'SHAREPOINT_SETTINGS', authoritativeSnapshot([settings]))
    })
  }

  private async syncSharePointUsage(
    tenant: { id: string; organizationId: string },
    accessToken: string
  ) {
    return this.runSnapshotSync(tenant, 'SHAREPOINT_USAGE', async () => {
      const downloadReport = async (reportUrl: string, label: string) => {
        const reportResponse = await this.fetchGraphPage(
          reportUrl,
          accessToken,
          `${label} usage`,
          {
            timeoutMs: 30_000,
            acceptedStatuses: [302],
            init: { headers: { Accept: 'text/csv' }, redirect: 'manual' },
          },
        )
        if (reportResponse.ok) return reportResponse.text()
        if (reportResponse.status !== 302) {
          const graphRequestId = reportResponse.headers.get('request-id')
          throw new Error(
            `Microsoft ${label} usage synchronization returned ${reportResponse.status}${
              graphRequestId ? ` (request ${graphRequestId})` : ''
            }.`
          )
        }
        const downloadUrl = reportResponse.headers.get('location')
        if (!downloadUrl?.startsWith('https://')) {
          throw new Error(`Microsoft returned an invalid ${label} report link.`)
        }
        const downloadResponse = await fetchMicrosoftWithRetry(
          downloadUrl,
          { headers: { Accept: 'text/csv,application/octet-stream' } },
          { label: `Microsoft ${label} usage report download`, timeoutMs: 30_000 },
        )
        if (!downloadResponse.ok) {
          throw new Error(
            `Microsoft ${label} report download returned ${downloadResponse.status}.`
          )
        }
        return downloadResponse.text()
      }

      const [sharePointReport, oneDriveReport] = await Promise.all([
        downloadReport(
          "https://graph.microsoft.com/v1.0/reports/getSharePointSiteUsageDetail(period='D180')",
          'SharePoint'
        ),
        downloadReport(
          "https://graph.microsoft.com/v1.0/reports/getOneDriveUsageAccountDetail(period='D30')",
          'OneDrive'
        ),
      ])
      const payload = [
        {
          hawkviewDataset: 'microsoft-usage-reports-v1',
          sharePointSites: parseCsvRows(sharePointReport),
          oneDriveAccounts: parseCsvRows(oneDriveReport),
        },
      ]
      await this.saveSnapshot(tenant, 'SHAREPOINT_USAGE', authoritativeSnapshot(payload))
    })
  }

  private async synchronizeUsers(
    tenant: {
      id: string
      organizationId: string
    },
    accessToken: string,
    deltaLink: string | null,
    allowDeltaReset = true,
  ): Promise<{ deltaLink: string }> {
    const fullSyncStartedAt = deltaLink ? null : new Date()
    let nextUrl =
      deltaLink ??
      `https://graph.microsoft.com/v1.0/users/delta?$select=${USER_SELECT}`
    let finalDeltaLink: string | null = null

    while (nextUrl) {
      if (!nextUrl.startsWith('https://graph.microsoft.com/')) {
        throw new Error('Microsoft returned an invalid synchronization link.')
      }
      const response = await this.fetchGraphPage(nextUrl, accessToken, 'users', {
        timeoutMs: 20_000,
        acceptedStatuses: [410],
      })
      if (response.status === 410) {
        const metadata = await readGraphOperationalError(response)
        if (deltaLink && allowDeltaReset) {
          this.logger.warn(
            `Microsoft invalidated the users delta checkpoint for tenant ${tenant.id}; rebuilding the users baseline.`,
          )
          return this.synchronizeUsers(tenant, accessToken, null, false)
        }
        throw new MicrosoftGraphCollectionError(
          `Microsoft users synchronization returned 410${metadata.suffix}.`,
          410,
          metadata.code,
          response.headers.get('request-id'),
        )
      }
      const page = (await response.json()) as GraphUsersPage
      const observedAt = new Date()
      const operations = (page.value ?? [])
        .filter((user) => typeof user.id === 'string')
        .map((user) => {
          const microsoftUserId = user.id as string
          if (user['@removed']) {
            return this.prisma.directoryUser.updateMany({
              where: {
                customerTenantId: tenant.id,
                microsoftUserId,
              },
              data: { deletedAt: observedAt, lastSeenAt: observedAt },
            })
          }
          const userPrincipalName = user.userPrincipalName?.trim() ?? ''
          const assignedLicenseSkuIds = [
            ...new Set(
              (user.assignedLicenses ?? [])
                .map((license) => license.skuId?.trim().toLowerCase())
                .filter((skuId): skuId is string => Boolean(skuId))
            ),
          ].sort()
          return this.prisma.directoryUser.upsert({
            where: {
              customerTenantId_microsoftUserId: {
                customerTenantId: tenant.id,
                microsoftUserId,
              },
            },
            create: {
              organizationId: tenant.organizationId,
              customerTenantId: tenant.id,
              microsoftUserId,
              displayName: user.displayName?.trim() || userPrincipalName,
              userPrincipalName,
              mail: user.mail?.trim() || null,
              accountEnabled: user.accountEnabled !== false,
              userType: user.userType?.trim() || null,
              assignedLicenseSkuIds,
              lastSeenAt: observedAt,
            },
            update: {
              displayName: user.displayName?.trim() || userPrincipalName,
              userPrincipalName,
              mail: user.mail?.trim() || null,
              accountEnabled: user.accountEnabled !== false,
              userType: user.userType?.trim() || null,
              assignedLicenseSkuIds,
              lastSeenAt: observedAt,
              deletedAt: null,
            },
          })
        })
      if (operations.length > 0) {
        await this.prisma.$transaction(operations)
      }

      nextUrl = page['@odata.nextLink'] ?? ''
      finalDeltaLink = page['@odata.deltaLink'] ?? finalDeltaLink
    }

    if (!finalDeltaLink) {
      throw new Error('Microsoft did not return a users delta checkpoint.')
    }
    if (fullSyncStartedAt) {
      await this.prisma.directoryUser.updateMany({
        where: {
          organizationId: tenant.organizationId,
          customerTenantId: tenant.id,
          deletedAt: null,
          lastSeenAt: { lt: fullSyncStartedAt },
        },
        data: { deletedAt: new Date() },
      })
    }
    return { deltaLink: finalDeltaLink }
  }

  private async buildBundle(tenant: {
    id: string
    organizationId: string
    microsoftTenantId: string
    displayName: string | null
    primaryDomain: string | null
    status: string
    connection: {
      lastVerifiedAt: Date | null
      exchangeReadOnlyEnabledAt: Date | null
    } | null
  }) {
    const m365AuditToday = m365AuditUsageDate()
    const m365AuditMonthStart = new Date(Date.UTC(
      m365AuditToday.getUTCFullYear(),
      m365AuditToday.getUTCMonth(),
      1
    ))
    const [
      users,
      directoryGroups,
      licenses,
      domains,
      syncStates,
      entraSnapshots,
      collectionFieldStates,
      signIns,
      auditLogs,
      m365AuditSubscriptions,
      m365AuditContentCounts,
      oldestM365AuditBacklog,
      m365AuditUsage,
      m365AuditMonthlyUsage,
    ] = await Promise.all([
      this.prisma.directoryUser.findMany({
        where: {
          organizationId: tenant.organizationId,
          customerTenantId: tenant.id,
          deletedAt: null,
        },
        orderBy: [{ displayName: 'asc' }, { userPrincipalName: 'asc' }],
        include: {
          groupMemberships: {
            select: {
              directoryGroup: {
                select: { displayName: true },
              },
            },
          },
        },
      }),
      this.prisma.directoryGroup.findMany({
        where: {
          organizationId: tenant.organizationId,
          customerTenantId: tenant.id,
        },
        orderBy: { displayName: 'asc' },
        include: {
          memberships: {
            select: {
              directoryUser: {
                select: {
                  microsoftUserId: true,
                  displayName: true,
                  userPrincipalName: true,
                },
              },
            },
          },
        },
      }),
      this.prisma.tenantLicense.findMany({
        where: {
          organizationId: tenant.organizationId,
          customerTenantId: tenant.id,
        },
        orderBy: { skuPartNumber: 'asc' },
      }),
      this.prisma.tenantDomain.findMany({
        where: {
          organizationId: tenant.organizationId,
          customerTenantId: tenant.id,
        },
        orderBy: [{ isDefault: 'desc' }, { name: 'asc' }],
      }),
      this.prisma.syncState.findMany({
        where: {
          organizationId: tenant.organizationId,
          customerTenantId: tenant.id,
        },
      }),
      this.prisma.tenantEntraSnapshot.findMany({
        where: {
          organizationId: tenant.organizationId,
          customerTenantId: tenant.id,
        },
      }),
      this.prisma.tenantCollectionFieldState.findMany({
        where: {
          organizationId: tenant.organizationId,
          customerTenantId: tenant.id,
        },
        orderBy: { fieldKey: 'asc' },
      }),
      this.prisma.signInLog.findMany({
        where: {
          organizationId: tenant.organizationId,
          customerTenantId: tenant.id,
        },
        orderBy: { eventDateTime: 'desc' },
        take: 5000,
      }),
      this.prisma.directoryAuditLog.findMany({
        where: {
          organizationId: tenant.organizationId,
          customerTenantId: tenant.id,
        },
        orderBy: { eventDateTime: 'desc' },
        take: 5000,
      }),
      this.prisma.m365ActivitySubscription.findMany({
        where: {
          organizationId: tenant.organizationId,
          customerTenantId: tenant.id,
        },
        orderBy: { contentType: 'asc' },
      }),
      this.prisma.m365ActivityContent.groupBy({
        by: ['status'],
        where: {
          organizationId: tenant.organizationId,
          customerTenantId: tenant.id,
        },
        _count: { _all: true },
      }),
      this.prisma.m365ActivityContent.findFirst({
        where: {
          organizationId: tenant.organizationId,
          customerTenantId: tenant.id,
          status: { in: ['PENDING', 'PROCESSING', 'RETRY', 'FAILED'] },
        },
        orderBy: [{ contentCreatedAt: 'asc' }, { discoveredAt: 'asc' }],
        select: { contentCreatedAt: true, discoveredAt: true },
      }),
      this.prisma.m365AuditDailyUsage.findFirst({
        where: {
          organizationId: tenant.organizationId,
          customerTenantId: tenant.id,
          usageDate: m365AuditToday,
        },
      }),
      this.prisma.m365AuditDailyUsage.aggregate({
        where: {
          organizationId: tenant.organizationId,
          customerTenantId: tenant.id,
          usageDate: {
            gte: m365AuditMonthStart,
            lte: m365AuditToday,
          },
        },
        _sum: { downloadedBytes: true, recordsStored: true, blobsProcessed: true },
      }),
    ])
    const snapshotByResource = new Map(
      entraSnapshots.map((snapshot) => [
        snapshot.resourceType,
        Array.isArray(snapshot.payload) ? (snapshot.payload as any[]) : [],
      ])
    )
    const snapshotObservedAtByResource = new Map(
      entraSnapshots.map((snapshot) => [snapshot.resourceType, snapshot.observedAt])
    )
    const servicePrincipalNameByAppId = new Map<string, string>(
      (snapshotByResource.get('SERVICE_PRINCIPALS') ?? [])
        .filter(
          (principal) =>
            typeof principal?.appId === 'string' &&
            typeof principal?.displayName === 'string'
        )
        .map((principal) => [
          principal.appId.toLowerCase(),
          principal.displayName.trim(),
        ])
    )
    const servicePrincipals = snapshotByResource.get('SERVICE_PRINCIPALS') ?? []
    const applications = snapshotByResource.get('APPLICATIONS') ?? []
    const resourceApiByAppId = new Map<
      string,
      {
        displayName: string
        permissionsById: Map<string, string>
      }
    >()
    for (const principal of servicePrincipals) {
      if (typeof principal?.appId !== 'string') continue
      const permissionsById = new Map<string, string>()
      for (const permission of [
        ...(Array.isArray(principal.appRoles) ? principal.appRoles : []),
        ...(Array.isArray(principal.oauth2PermissionScopes)
          ? principal.oauth2PermissionScopes
          : []),
      ]) {
        if (typeof permission?.id !== 'string') continue
        permissionsById.set(
          permission.id.toLowerCase(),
          permission.value ??
            permission.displayName ??
            permission.adminConsentDisplayName ??
            permission.id
        )
      }
      resourceApiByAppId.set(principal.appId.toLowerCase(), {
        displayName: principal.displayName ?? principal.appId,
        permissionsById,
      })
    }
    const securityDefaults = (snapshotByResource.get('SECURITY_DEFAULTS') ??
      [])[0]
    const conditionalAccessTargetNames: Record<string, string> = {
      All: 'All cloud apps',
      Office365: 'Office 365',
      MicrosoftAdminPortals: 'Microsoft Admin Portals',
    }
    const resolveApplicationTarget = (target: unknown) => {
      if (typeof target !== 'string') return String(target ?? '')
      return (
        conditionalAccessTargetNames[target] ??
        servicePrincipalNameByAppId.get(target.toLowerCase()) ??
        target
      )
    }
    const sharePointSites = (
      snapshotByResource.get('SHAREPOINT_SITES') ?? []
    ).filter(isCustomerFacingSharePointSite)
    const sharePointSettings = (snapshotByResource.get('SHAREPOINT_SETTINGS') ??
      [])[0]
    const sharePointUsageSnapshot =
      snapshotByResource.get('SHAREPOINT_USAGE') ?? []
    const combinedUsage =
      sharePointUsageSnapshot.length === 1 &&
      sharePointUsageSnapshot[0]?.hawkviewDataset ===
        'microsoft-usage-reports-v1'
        ? sharePointUsageSnapshot[0]
        : null
    const sharePointUsage = combinedUsage?.sharePointSites ?? sharePointUsageSnapshot
    const oneDriveUsage = combinedUsage?.oneDriveAccounts ?? []
    const exchangeMailboxes = snapshotByResource.get('EXCHANGE_MAILBOXES') ?? []
    const exchangeMailboxUsage =
      snapshotByResource.get('EXCHANGE_MAILBOX_USAGE') ?? []
    const exchangeMailboxSettings =
      snapshotByResource.get('EXCHANGE_MAILBOX_SETTINGS') ?? []
    const exchangeMailboxConfiguration =
      snapshotByResource.get('EXCHANGE_MAILBOX_CONFIGURATION') ?? []
    const exchangeAcceptedDomains =
      snapshotByResource.get('EXCHANGE_ACCEPTED_DOMAINS') ?? []
    const exchangeMailboxRules =
      snapshotByResource.get('EXCHANGE_MAILBOX_RULES') ?? []
    const exchangeConfigurationByIdentity = new Map<string, any>()
    for (const mailbox of exchangeMailboxConfiguration) {
      for (const identity of [
        mailbox?.externalDirectoryObjectId,
        mailbox?.userPrincipalName,
        mailbox?.primarySmtpAddress,
      ]) {
        const normalized = normalizeExchangeIdentity(identity)
        if (normalized) exchangeConfigurationByIdentity.set(normalized, mailbox)
      }
    }
    const domainDnsHealth = snapshotByResource.get('DOMAIN_DNS_HEALTH') ?? []
    const exchangeUsageByIdentity = new Map<string, Record<string, string>>()
    for (const row of exchangeMailboxUsage as Array<Record<string, string>>) {
      for (const field of [
        'User Principal Name',
        'User Principal Name (UPN)',
        'Owner Principal Name',
        'Email Address',
      ]) {
        const identity = normalizeExchangeIdentity(usageValue(row, field))
        if (identity) exchangeUsageByIdentity.set(identity, row)
      }
    }
    const exchangeMailboxSettingsByIdentity = new Map<string, Record<string, unknown>>()
    for (const row of exchangeMailboxSettings as Array<Record<string, unknown>>) {
      for (const value of [row.mailboxUserId, row.mailboxUpn, row.userPrincipalName, row.id]) {
        const identity = normalizeExchangeIdentity(value)
        if (identity) exchangeMailboxSettingsByIdentity.set(identity, row)
      }
    }
    const oneDriveUsageByUpn = new Map<string, Record<string, string>>(
      oneDriveUsage
        .filter((row: any) => typeof row?.['Owner Principal Name'] === 'string')
        .map((row: any) => [
          String(row['Owner Principal Name']).toLowerCase(),
          row,
        ])
    )
    const groupSnapshotById = new Map(
      (snapshotByResource.get('GROUPS') ?? [])
        .filter((group: any) => typeof group?.id === 'string')
        .map((group: any) => [group.id, group])
    )
    // The mailbox usage report can anonymize user identities in Microsoft 365.
    // It is enrichment data, not the source of truth for mailbox existence, so
    // never remove Graph directory mailboxes merely because their UPN cannot be
    // joined to a usage row.
    const exchangeMailboxInventory = exchangeMailboxes
    const sharePointUsageByUrl = new Map<string, Record<string, string>>(
      sharePointUsage
        .filter((row: Record<string, string>) =>
          normalizeSharePointUrl(row?.['Site URL'])
        )
        .map((row: Record<string, string>) => [
          normalizeSharePointUrl(row['Site URL']),
          row,
        ])
    )
    const sharePointUsageBySiteId = new Map<string, Record<string, string>>(
      sharePointUsage
        .filter(
          (row: Record<string, string>) =>
            typeof row?.['Site Id'] === 'string' && row['Site Id'].trim()
        )
        .map((row: Record<string, string>) => [
          normalizeSharePointSiteId(row['Site Id']),
          row,
        ])
    )
    const parseReportBytes = (value: unknown) => {
      if (typeof value !== 'string' || !value.trim()) return null
      const parsed = Number(value)
      return Number.isFinite(parsed) ? parsed : null
    }
    const reportedSharePointAllocationBytes = sharePointUsage.reduce(
      (total: number, row: Record<string, string>) =>
        total + (parseReportBytes(row?.['Storage Allocated (Byte)']) ?? 0),
      0
    )
    const reportedSharePointUsedBytes = sharePointUsage.reduce(
      (total: number, row: Record<string, string>) =>
        total + (parseReportBytes(row?.['Storage Used (Byte)']) ?? 0),
      0
    )
    const getSharePointUsage = (site: any) => {
      const byUrl = sharePointUsageByUrl.get(
        normalizeSharePointUrl(site?.webUrl)
      )
      if (byUrl) return byUrl
      if (typeof site?.id !== 'string') return undefined
      const siteIds = site.id
        .split(',')
        .map(normalizeSharePointSiteId)
      return siteIds
        .map((siteId: string) => sharePointUsageBySiteId.get(siteId))
        .find(Boolean)
    }
    const sharePointUsageRowsWithActivity = sharePointUsage.filter(
      (row: Record<string, string>) =>
        typeof row?.['Last Activity Date'] === 'string' &&
        Boolean(row['Last Activity Date'].trim())
    )
    const matchedSharePointUsageRows = new Set(
      sharePointSites.map(getSharePointUsage).filter(Boolean)
    )
    // Microsoft 365 conceals site URLs and IDs in usage reports by default in
    // some tenants. The activity dates are still present, but there is no safe
    // way to associate those anonymous rows with a Graph site. Never guess.
    const sharePointUsageIdentifiersConcealed =
      sharePointUsageRowsWithActivity.length > 0 &&
      matchedSharePointUsageRows.size === 0
    const getSharePointSiteType = (site: any, usage: any) => {
      const template = String(usage?.['Root Web Template'] ?? '').toUpperCase()
      const url = normalizeSharePointUrl(site?.webUrl)
      if (url.includes('-my.sharepoint.com/personal/')) return 'OneDrive'
      if (template.includes('SITEPAGEPUBLISHING')) return 'Communication site'
      if (template.includes('GROUP')) return 'Microsoft 365 group site'
      return 'SharePoint site'
    }
    const bytesToGb = (value: unknown) =>
      bytesToGigabytes(typeof value === 'number' ? value : null)
    const bytesToUsageLabel = (value: unknown) => {
      const bytes = parseReportBytes(value)
      if (bytes === null) return 'No usage reported'
      const gigabytes = Math.round((bytes / 1024 ** 3) * 100) / 100
      return `${gigabytes} GB`
    }
    const authRegistrations = snapshotByResource.get('AUTH_REGISTRATIONS') ?? []
    const authRegistrationByUserId = new Map(
      authRegistrations
        .filter((registration) => typeof registration?.id === 'string')
        .map((registration) => [registration.id, registration])
    )
    const roleAssignments = snapshotByResource.get('DIRECTORY_ROLES') ?? []
    const roleNamesByUserId = new Map<string, string[]>()
    for (const assignment of roleAssignments) {
      if (typeof assignment?.principalId !== 'string') continue
      const roleName = assignment?.roleDefinition?.displayName
      if (typeof roleName !== 'string' || !roleName.trim()) continue
      const current = roleNamesByUserId.get(assignment.principalId) ?? []
      current.push(roleName.trim())
      roleNamesByUserId.set(
        assignment.principalId,
        [...new Set(current)].sort()
      )
    }
    const devices = snapshotByResource.get('DEVICES') ?? []
    const devicesByUserId = new Map<
      string,
      Array<{ name: string; os: string; lastSync: string; status: string }>
    >()
    for (const device of devices) {
      const label =
        typeof device?.displayName === 'string' && device.displayName.trim()
          ? device.displayName.trim()
          : typeof device?.deviceId === 'string'
            ? device.deviceId
            : 'Registered device'
      const operatingSystem = [
        typeof device?.operatingSystem === 'string'
          ? device.operatingSystem.trim()
          : '',
        typeof device?.operatingSystemVersion === 'string'
          ? device.operatingSystemVersion.trim()
          : '',
      ]
        .filter(Boolean)
        .join(' ')
      const deviceDetails = {
        name: label,
        os: operatingSystem || 'Unknown',
        lastSync:
          typeof device?.approximateLastSignInDateTime === 'string'
            ? device.approximateLastSignInDateTime
            : 'No activity reported',
        status:
          typeof device?.isCompliant === 'boolean'
            ? device.isCompliant
              ? 'Compliant'
              : 'Non-compliant'
            : 'Unknown',
      }
      for (const owner of Array.isArray(device?.registeredOwners)
        ? device.registeredOwners
        : []) {
        if (typeof owner?.id !== 'string') continue
        const current = devicesByUserId.get(owner.id) ?? []
        if (
          !current.some((registeredDevice) => registeredDevice.name === label)
        ) {
          current.push(deviceDetails)
        }
        devicesByUserId.set(
          owner.id,
          current.sort((left, right) => left.name.localeCompare(right.name))
        )
      }
    }
    const latestSignInByUserId = new Map<string, any>()
    for (const signIn of signIns) {
      if (typeof signIn?.userId !== 'string') continue
      const current = latestSignInByUserId.get(signIn.userId)
      if (
        !current ||
        signIn.eventDateTime.getTime() > current.eventDateTime.getTime()
      ) {
        latestSignInByUserId.set(signIn.userId, signIn)
      }
    }
    const directoryUserNameByIdentity = new Map<string, string>()
    for (const user of users) {
      for (const identity of [
        user.microsoftUserId,
        user.userPrincipalName,
        user.mail,
      ]) {
        if (typeof identity === 'string' && identity.trim()) {
          directoryUserNameByIdentity.set(
            identity.trim().toLowerCase(),
            user.displayName
          )
        }
      }
    }
    const syncStateByResource = new Map(
      syncStates.map((state) => [state.resourceType, state])
    )
    const collectionStateByKey = new Map(
      collectionFieldStates.map((field) => [field.fieldKey, field])
    )
    const collectionState = (
      fieldKey: string,
      value: unknown = null,
      resourceType?: EntraSnapshotResource
    ) => {
      const field = collectionStateByKey.get(fieldKey)
      const sync = resourceType
        ? syncStateByResource.get(resourceType)
        : undefined
      const pendingFieldHasCompletedCollector =
        field?.state === 'PENDING' &&
        Boolean(sync?.status && sync.status !== 'RUNNING' && sync.status !== 'IDLE')
      if (field && !pendingFieldHasCompletedCollector) {
        return {
          value,
          state: field.state,
          reasonCode: field.reasonCode,
          message: field.message,
          source: field.source,
          endpoint: field.endpoint,
          correlationId: field.correlationId,
          lastAttemptAt: field.lastAttemptAt?.toISOString() ?? null,
          lastSuccessfulAt: field.lastSuccessfulAt?.toISOString() ?? null,
          isStale: field.isStale,
        }
      }

      // Older tenants can have snapshots and sync-state rows from before
      // field-state materialization existed. Do not present those completed
      // (or failed) collectors as permanently "pending" just because the
      // derived field row has not been written yet.
      const fallback = deriveCollectionFieldState({
        syncStatus: sync?.status,
        lastErrorMessage: sync?.lastErrorMessage,
        hasPriorSnapshot: resourceType
          ? snapshotByResource.has(resourceType)
          : false,
      })
      const isExchangeUsage = resourceType === 'EXCHANGE_MAILBOX_USAGE'
      return {
        value,
        state: fallback.state,
        reasonCode: fallback.reasonCode,
        message: fallback.message,
        source: isExchangeUsage
            ? 'Microsoft Graph Reports'
            : 'Microsoft Graph',
        endpoint: isExchangeUsage
            ? '/reports/getMailboxUsageDetail'
            : null,
        correlationId: null,
        lastAttemptAt: sync?.lastAttemptAt?.toISOString() ?? null,
        lastSuccessfulAt: sync?.lastSuccessfulAt?.toISOString() ?? null,
        isStale: fallback.isStale,
      }
    }
    const siteAccessNotCollected = (value: unknown = null) => ({
      ...collectionState('sharepoint.sites.access', value),
      state: 'NOT_COLLECTED_LEAST_PRIVILEGE',
      reasonCode: 'NOT_COLLECTED_LEAST_PRIVILEGE',
      message:
        'Standard least-privilege mode does not collect current site-user, site collection administrator, sharing-member, or per-site permission metadata.',
      source: 'HawkView standard least-privilege mode',
      endpoint: null,
      correlationId: null,
      isStale: false,
    })
    const userSyncState = syncStateByResource.get('USERS')
    const licenseSyncState = syncStateByResource.get('LICENSES')
    const domainSyncState = syncStateByResource.get('DOMAINS')
    const groupSyncState = syncStateByResource.get('GROUPS')
    const signInSyncState = syncStateByResource.get('SIGN_INS')
    const auditLogSyncState = syncStateByResource.get('AUDIT_LOGS')
    const m365AuditSyncState = syncStateByResource.get('M365_AUDIT')
    const m365AuditCounts = Object.fromEntries(
      m365AuditContentCounts.map((row) => [row.status, row._count._all])
    )
    const m365AuditLimits = m365AuditUsageLimits()
    const sharePointSitesSyncState = syncStateByResource.get('SHAREPOINT_SITES')
    const sharePointSettingsSyncState = syncStateByResource.get(
      'SHAREPOINT_SETTINGS'
    )
    const sharePointUsageSyncState = syncStateByResource.get('SHAREPOINT_USAGE')
    const exchangeSync = (resource: EntraSnapshotResource) => {
      const state = syncStateByResource.get(resource)
      return {
        status: state?.status.toLowerCase() ?? 'never-synced',
        lastSuccessfulAt: state?.lastSuccessfulAt?.toISOString() ?? null,
        lastError: state?.lastErrorMessage ?? null,
      }
    }
    const sharePointSettingsSynchronized =
      sharePointSettingsSyncState?.status === 'SUCCEEDED' &&
      Boolean(sharePointSettings)
    const sharePointUsageSynchronized =
      sharePointUsageSyncState?.status === 'SUCCEEDED'
    const latestSharePointReportRefreshDate = sharePointUsage
      .map((row: Record<string, string>) => row?.['Report Refresh Date']?.trim())
      .filter((value: string | undefined): value is string => Boolean(value))
      .sort()
      .at(-1)
    const parseReportCalendarDate = (value: unknown, notAfter?: Date) => {
      if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null
      const [year, month, day] = value.split('-').map(Number)
      const parsed = new Date(Date.UTC(year, month - 1, day))
      if (
        parsed.getUTCFullYear() !== year || parsed.getUTCMonth() !== month - 1 ||
        parsed.getUTCDate() !== day || (notAfter && parsed.getTime() > notAfter.getTime())
      ) return null
      return parsed
    }
    const parsedSharePointActivityAsOf = parseReportCalendarDate(
      latestSharePointReportRefreshDate,
      new Date()
    )
    // Inactivity is measured as of Microsoft's report refresh, not the time
    // this API response happened to be assembled.
    const sharePointActivityAsOf =
      parsedSharePointActivityAsOf &&
      !Number.isNaN(parsedSharePointActivityAsOf.getTime())
        ? parsedSharePointActivityAsOf
        : new Date()
    const sharePointDataContract = buildSharePointDataContract({
      sites: sharePointSites,
      settings: sharePointSettings,
      sharePointUsage,
      oneDriveUsage,
      settingsSynchronized: sharePointSettingsSynchronized,
      usageSynchronized: sharePointUsageSynchronized,
      activityAsOf: sharePointActivityAsOf,
    })
    const getSharePointActivity = (site: any) => {
      const usage = getSharePointUsage(site)
      if (!usage) {
        return {
          lastActivityAt: null,
          activityAgeDays: null,
          activitySource: 'unmatched',
        }
      }

      const reportRefreshDate = parseReportCalendarDate(
        usage['Report Refresh Date'],
        new Date()
      )
      if (!reportRefreshDate) {
        return {
          lastActivityAt: null,
          activityAgeDays: null,
          activitySource: 'microsoft-report-refresh-unavailable',
        }
      }

      const value = usage['Last Activity Date']
      if (typeof value !== 'string' || !value.trim()) {
        // Microsoft omitted the activity date. Do not turn an omitted report
        // value into a claim that the site was inactive for the full window.
        return {
          lastActivityAt: null,
          activityAgeDays: null,
          activitySource: 'microsoft-d180-activity-not-reported',
        }
      }

      const parsed = parseReportCalendarDate(value.trim(), reportRefreshDate)
      if (!parsed) {
        return {
          lastActivityAt: null,
          activityAgeDays: null,
          activitySource: 'invalid-report-date',
        }
      }

      return {
        lastActivityAt: value.trim(),
        activityAgeDays: Math.floor(
          (reportRefreshDate.getTime() - parsed.getTime()) / (24 * 60 * 60 * 1000)
        ),
        activitySource: 'microsoft-d180-report',
      }
    }
    const sharePointActivity = sharePointSites.map(getSharePointActivity)
    const inactiveSharePointSites90Days = sharePointActivity.filter(
      ({ activityAgeDays }) =>
        typeof activityAgeDays === 'number' && activityAgeDays >= 90
    ).length
    const inactiveSharePointSites180Days = sharePointActivity.filter(
      ({ activityAgeDays }) =>
        typeof activityAgeDays === 'number' && activityAgeDays >= 180
    ).length
    const sharePointSitesWithoutActivity = sharePointActivity.filter(
      ({ activityAgeDays }) => activityAgeDays === null
    ).length
    const licenseNameBySkuId = new Map(
      licenses.map((license) => [
        license.microsoftSkuId.toLowerCase(),
        getMicrosoftSkuName(license.skuPartNumber),
      ])
    )
    // Connector verification only proves that credentials work. It is not a
    // data synchronization and must never be displayed as one.
    const successfulDates = syncStates
      .map((state) => state.lastSuccessfulAt)
      .filter((date): date is Date => Boolean(date))
    const lastSync =
      successfulDates.length > 0
        ? new Date(Math.max(...successfulDates.map((date) => date.getTime())))
        : null
    const syncFreshness = deriveTenantSyncFreshness(syncStates)

    return {
      bundle: {
        tenant: {
          id: tenant.id,
          name:
            tenant.displayName ??
            `Microsoft tenant ${tenant.microsoftTenantId.slice(0, 8)}`,
          domain:
            domains.find((domain) => domain.isDefault)?.name ??
            tenant.primaryDomain ??
            '',
          domains: domains.map((domain) => domain.name),
          provider: 'microsoft',
          status: tenant.status === 'ACTIVE' ? 'healthy' : 'warning',
          secureScore: getMicrosoftSecureScore(
            snapshotByResource.get('SECURE_SCORES'),
          ),
          licenseCount: licenses.reduce(
            (total, license) => total + license.enabledUnits,
            0
          ),
          lastSync: lastSync?.toISOString() ?? null,
          syncFreshness,
        },
        dns: (() => {
          const selectedDomain =
            domains.find((domain) => domain.isDefault)?.name ??
            tenant.primaryDomain ??
            ''
          const byDomain = Object.fromEntries(
            domainDnsHealth
              .filter((result) => typeof result?.domain === 'string')
              .map((result) => [result.domain.toLowerCase(), result])
          )
          return {
            ...(byDomain[selectedDomain.toLowerCase()] ?? {}),
            byDomain,
          }
        })(),
        users: users.map((user) => {
          const registration = authRegistrationByUserId.get(
            user.microsoftUserId
          )
          const roleNames = roleNamesByUserId.get(user.microsoftUserId) ?? []
          const lastSignIn = latestSignInByUserId.get(user.microsoftUserId)
          const normalizedUpn = user.userPrincipalName.toLowerCase()
          const oneDrive = oneDriveUsageByUpn.get(normalizedUpn)
          const mailboxUsage = exchangeUsageByIdentity.get(normalizedUpn)
          return {
            id: user.microsoftUserId,
            name: user.displayName,
            email: user.userPrincipalName || user.mail || '',
            type: user.userType === 'Guest' ? 'Guest' : 'Member',
            role: roleNames.length > 0 ? roleNames.join(', ') : 'User',
            status: user.accountEnabled ? 'Enabled' : 'Disabled',
            ...projectMfaTruth(registration),
            lastLogin:
              lastSignIn?.eventDateTime instanceof Date
                ? lastSignIn.eventDateTime.toISOString()
                : 'No sign-in recorded',
            driveUsage: oneDrive
              ? bytesToUsageLabel(oneDrive['Storage Used (Byte)'])
              : 'No usage reported',
            mailUsage: mailboxUsage
              ? bytesToUsageLabel(mailboxUsage['Storage Used (Byte)'])
              : 'No usage reported',
            authMethods: Array.isArray(registration?.methodsRegistered)
              ? registration.methodsRegistered
              : [],
            licenses: user.assignedLicenseSkuIds.map(
              (skuId) => licenseNameBySkuId.get(skuId.toLowerCase()) ?? skuId
            ),
            assignedLicenseSkuIds: user.assignedLicenseSkuIds,
            groups: user.groupMemberships
              .map((membership) => membership.directoryGroup.displayName)
              .sort((left, right) => left.localeCompare(right)),
            devices: devicesByUserId.get(user.microsoftUserId) ?? [],
          }
        }),
        signIns: signIns.map((signIn) => ({
          id: signIn.microsoftSignInId,
          userId: signIn.userId,
          userDisplayName:
            signIn.userDisplayName ??
            (typeof signIn.userId === 'string'
              ? directoryUserNameByIdentity.get(signIn.userId.toLowerCase())
              : undefined) ??
            (typeof signIn.userPrincipalName === 'string'
              ? directoryUserNameByIdentity.get(
                  signIn.userPrincipalName.toLowerCase()
                )
              : undefined) ??
            signIn.userPrincipalName ??
            'Unknown user',
          userPrincipalName: signIn.userPrincipalName ?? '',
          createdAt: signIn.eventDateTime.toISOString(),
          ipAddress: signIn.ipAddress ?? '',
          result:
            Number(signIn.statusErrorCode ?? 1) === 0 ? 'Success' : 'Failure',
          appDisplayName: signIn.appDisplayName ?? 'Unknown application',
          clientAppUsed: signIn.clientAppUsed ?? 'Unknown',
          conditionalAccess: signIn.conditionalAccessStatus,
          country:
            (signIn.location as any)?.countryOrRegion ??
            ((signIn.raw as any)?.hawkviewLimited
              ? 'Not provided by Microsoft'
              : 'Unknown'),
          city: (signIn.location as any)?.city ?? undefined,
          state: (signIn.location as any)?.state ?? undefined,
          latitude: Number(
            (signIn.location as any)?.geoCoordinates?.latitude ?? 0
          ),
          longitude: Number(
            (signIn.location as any)?.geoCoordinates?.longitude ?? 0
          ),
          device: (signIn.deviceDetail as any)?.displayName ?? undefined,
          os: (signIn.deviceDetail as any)?.operatingSystem ?? undefined,
          riskLevel: signIn.riskLevel,
          failureReason: signIn.failureReason,
          dataSource:
            (signIn.raw as any)?.hawkviewSource === MANAGEMENT_ACTIVITY_SOURCE
              ? 'microsoft-365-management-activity'
              : 'entra-sign-in-logs',
          isLimited: Boolean((signIn.raw as any)?.hawkviewLimited),
        })),
        auditLogs: auditLogs.map((audit) => ({
          id: audit.microsoftAuditId,
          createdAt: audit.eventDateTime.toISOString(),
          activity: audit.activityDisplayName,
          category: audit.category,
          operationType: audit.operationType,
          result: audit.result,
          resultReason: audit.resultReason,
          correlationId: audit.correlationId,
          service: audit.loggedByService,
          initiatedBy: audit.initiatedBy,
          targetResources: audit.targetResources,
          additionalDetails: audit.additionalDetails,
        })),
        logRetention: {
          months: LOG_RETENTION_MONTHS,
          displayedRecordLimit: 5000,
        },
        exchange: {
          collection: {
            inventory: collectionState(
              'exchange.mailboxes.inventory',
              exchangeMailboxInventory.length,
              'EXCHANGE_MAILBOXES'
            ),
            settings: collectionState(
              'exchange.mailboxes.settings',
              exchangeMailboxSettings.length,
              'EXCHANGE_MAILBOX_SETTINGS'
            ),
            configuration: tenant.connection?.exchangeReadOnlyEnabledAt
              ? {
                  ...collectionState(
                    'exchange.mailboxes.configuration',
                    exchangeMailboxConfiguration.length,
                    'EXCHANGE_MAILBOX_CONFIGURATION'
                  ),
                  source: 'Microsoft Exchange Online Admin API',
                  endpoint: '/adminapi/v2.0/Mailbox',
                }
              : {
                  value: null,
                  state: 'OPTIONAL_NOT_ENABLED',
                  reasonCode: 'OPTIONAL_NOT_ENABLED',
                  message: 'Optional Exchange read-only enrichment is not enabled. Standard Graph mailbox inventory remains available.',
                  source: 'HawkView standard least-privilege mode',
                  endpoint: null,
                  lastAttemptAt: null,
                  lastSuccessfulAt: null,
                  isStale: false,
                },
            usage: collectionState(
              'exchange.mailboxes.usage',
              exchangeMailboxUsage.length,
              'EXCHANGE_MAILBOX_USAGE'
            ),
          },
          sync: {
            mailboxes: exchangeSync('EXCHANGE_MAILBOXES'),
            mailboxSettings: exchangeSync('EXCHANGE_MAILBOX_SETTINGS'),
            mailboxUsage: exchangeSync('EXCHANGE_MAILBOX_USAGE'),
            acceptedDomains: exchangeSync('EXCHANGE_ACCEPTED_DOMAINS'),
            inboxRules: exchangeSync('EXCHANGE_MAILBOX_RULES'),
            configuration: exchangeSync('EXCHANGE_MAILBOX_CONFIGURATION'),
          },
          mailboxes: exchangeMailboxInventory.map((mailbox: any) => {
            const directoryUpn = String(
              mailbox.UserPrincipalName ??
                mailbox.userPrincipalName ??
                mailbox.PrimarySmtpAddress ??
                mailbox.mail ??
                mailbox.WindowsEmailAddress ??
                ''
            )
            const enrichedMailbox = mailbox
            const upn = String(
              enrichedMailbox.UserPrincipalName ??
                enrichedMailbox.userPrincipalName ??
                enrichedMailbox.PrimarySmtpAddress ??
                enrichedMailbox.mail ??
                enrichedMailbox.WindowsEmailAddress ??
                directoryUpn
            )
            const emailAddresses = Array.isArray(enrichedMailbox.EmailAddresses)
              ? enrichedMailbox.EmailAddresses
              : []
            const mailboxIdentities = [
              mailbox.id,
              directoryUpn,
              upn,
              enrichedMailbox.PrimarySmtpAddress,
              enrichedMailbox.WindowsEmailAddress,
              enrichedMailbox.mail,
              ...(Array.isArray(mailbox.proxyAddresses) ? mailbox.proxyAddresses : []),
              ...emailAddresses,
            ]
              .map(normalizeExchangeIdentity)
              .filter(Boolean)
            const usage = mailboxIdentities
              .map((identity) => exchangeUsageByIdentity.get(identity))
              .find(Boolean)
            const settings = mailboxIdentities
              .map((identity) => exchangeMailboxSettingsByIdentity.get(identity))
              .find(Boolean)
            const configuration = mailboxIdentities
              .map((identity) => exchangeConfigurationByIdentity.get(identity))
              .find(Boolean)
            const storageBytes = parseUsageNumber(
              usageValue(usage, 'Storage Used (Byte)', 'Storage Used Bytes')
            )
            const itemCount = parseUsageNumber(
              usageValue(usage, 'Item Count', 'Items Count')
            )
            const recipientType =
              enrichedMailbox.RecipientTypeDetails ??
              enrichedMailbox.RecipientType ??
              null
            const mailboxType =
              graphMailboxPurposeToType(settings?.userPurpose) ??
              (typeof recipientType !== 'string'
                ? null
                : recipientType.includes('Shared')
                  ? 'Shared'
                  : recipientType.includes('Room')
                    ? 'Room'
                    : recipientType.includes('Equipment')
                      ? 'Equipment'
                      : 'User')
            return {
              id: String(
                enrichedMailbox.ExternalDirectoryObjectId ??
                  mailbox.id ??
                  enrichedMailbox.Guid ??
                  enrichedMailbox.Identity ??
                  upn
              ),
              displayName: String(
                enrichedMailbox.DisplayName ??
                  mailbox.displayName ??
                  enrichedMailbox.Name ??
                  upn
              ),
              userPrincipalName: upn,
              aliases: (emailAddresses.length > 0
                ? emailAddresses
                : Array.isArray(mailbox.proxyAddresses)
                  ? mailbox.proxyAddresses
                  : []
              )
                .map((address: unknown) => String(address))
                .filter((address: string) =>
                  address.toLowerCase().startsWith('smtp:')
                )
                .map((address: string) => address.slice(5)),
              mailboxType,
              sizeGB: storageBytes !== null
                ? Math.round((storageBytes / 1024 ** 3) * 100) / 100
                : null,
              itemCount,
              archiveEnabled: parseUsageBoolean(usageValue(usage, 'Has Archive')),
              retentionLabel: null,
              exchangeReadOnly: {
                enabled: Boolean(tenant.connection?.exchangeReadOnlyEnabledAt),
                collected: Boolean(configuration),
                maxSendSize:
                  typeof configuration?.maxSendSize === 'string'
                    ? configuration.maxSendSize
                    : null,
                sendOnBehalfTo: Array.isArray(configuration?.sendOnBehalfTo)
                  ? configuration.sendOnBehalfTo
                  : null,
                fullAccess: null,
                sendAs: null,
                source: configuration
                  ? 'Microsoft Exchange Online Admin API — Get-Mailbox'
                  : null,
                configurationCollectedAt: configuration
                  ? snapshotObservedAtByResource
                      .get('EXCHANGE_MAILBOX_CONFIGURATION')
                      ?.toISOString() ?? null
                  : null,
              },
              delegation: {
                fullAccess: null,
                sendAs: null,
                sendOnBehalf: Array.isArray(configuration?.sendOnBehalfTo)
                  ? configuration.sendOnBehalfTo
                  : null,
              },
              lastLogon: usage?.['Last Activity Date'] || null,
              collection: {
                inventory: collectionState(
                  'exchange.mailboxes.inventory',
                  true,
                  'EXCHANGE_MAILBOXES'
                ),
                settings: collectionState(
                  'exchange.mailboxes.settings',
                  Boolean(settings),
                  'EXCHANGE_MAILBOX_SETTINGS'
                ),
                configuration: tenant.connection?.exchangeReadOnlyEnabledAt
                  ? {
                      ...collectionState(
                        'exchange.mailboxes.configuration',
                        configuration ?? null,
                        'EXCHANGE_MAILBOX_CONFIGURATION'
                      ),
                      source: 'Microsoft Exchange Online Admin API',
                      endpoint: '/adminapi/v2.0/Mailbox',
                    }
                  : {
                      value: null,
                      state: 'OPTIONAL_NOT_ENABLED',
                      reasonCode: 'OPTIONAL_NOT_ENABLED',
                      message: 'Optional Get-Mailbox enrichment is not enabled. Full Access, Send As, and retention assignments are not available from this read-only API.',
                      source: 'HawkView standard least-privilege mode',
                      endpoint: null,
                      lastAttemptAt: null,
                      lastSuccessfulAt: null,
                      isStale: false,
                    },
                usage: collectionState(
                  'exchange.mailboxes.usage',
                  storageBytes,
                  'EXCHANGE_MAILBOX_USAGE'
                ),
              },
            }
          }),
          rules: exchangeMailboxRules.map((rule: any, index: number) => {
            const details = projectExchangeMailboxRuleDetails(rule)
            const mailboxUserId = safeExchangeMailboxRuleText(rule.mailboxUserId)
            const microsoftRuleId = safeExchangeMailboxRuleText(rule.id)
            const microsoftRuleName = rule && typeof rule === 'object' && !Array.isArray(rule) &&
              Object.prototype.hasOwnProperty.call(rule, 'displayName')
              ? safeExchangeMailboxRuleText(rule.displayName)
              : null
            const configurationCollectedAt = safeExchangeMailboxRuleCollectedAt(
              snapshotObservedAtByResource.get('EXCHANGE_MAILBOX_RULES')
            )
            return {
              id: exchangeMailboxRuleCompoundId(rule) ??
                `${mailboxUserId ?? 'mailbox'}::unidentified-rule-${index + 1}`,
              microsoftRuleId,
              microsoftRuleName,
              mailboxUserId,
              name: microsoftRuleName ?? 'Unnamed inbox rule',
              mailboxUpn: safeExchangeMailboxRuleText(rule.mailboxUpn) ?? '',
              enabled: typeof rule.isEnabled === 'boolean' ? rule.isEnabled : null,
              hasError: typeof rule.hasError === 'boolean' ? rule.hasError : null,
              isReadOnly: typeof rule.isReadOnly === 'boolean' ? rule.isReadOnly : null,
              priority: typeof rule.sequence === 'number' && Number.isSafeInteger(rule.sequence) && rule.sequence >= 0
                ? rule.sequence
                : null,
              configurationCollectedAt,
              description: summarizeExchangeMailboxRuleActions(details),
              actions: details.actions.map((fact) => fact.key),
              conditions: details.conditions.map((fact) => fact.key),
              exceptions: details.exceptions.map((fact) => fact.key),
              details,
            }
          }),
          acceptedDomains: exchangeAcceptedDomains.map((domain: any) => ({
            id: String(
              domain.Guid ??
                domain.id ??
                domain.Identity ??
                domain.DomainName ??
                domain.Name ??
                domain.domain
            ),
            domain: String(
              domain.DomainName ??
                domain.domain ??
                domain.Name ??
                domain.Identity ??
                domain.id ??
                ''
            ),
            associationType:
              domain.associationType ?? domain.type ?? null,
            capabilities: domain.capabilities ?? null,
            isDefault: Boolean(
              domain.Default ?? domain.IsDefault ?? domain.isDefault
            ),
          })),
          groups: directoryGroups
            .filter((group) => group.mailEnabled)
            .map((group) => {
              const graphGroup = groupSnapshotById.get(group.microsoftGroupId)
              return {
                id: group.microsoftGroupId,
                name: group.displayName,
                type: group.groupTypes.includes('Unified')
                  ? 'Microsoft365'
                  : group.securityEnabled
                    ? 'MailEnabledSecurity'
                    : 'DistributionList',
                email: group.mail ?? '',
                membersCount: group.memberships.length,
                members: uniquePrincipalLabels(
                  group.memberships.map(
                    (membership) => membership.directoryUser
                  )
                ),
                owners: Array.isArray(graphGroup?.owners)
                  ? uniquePrincipalLabels(graphGroup.owners)
                  : [],
                description: group.description ?? undefined,
              }
            }),
        },
        sharepoint: {
          // Versioned additive contract for the current SharePoint/OneDrive UI.
          // The legacy fields below remain temporarily for compatibility, but
          // new clients should consume this closed, source-labelled projection.
          dataContract: sharePointDataContract,
          collection: {
            inventory: collectionState(
              'sharepoint.sites.inventory',
              sharePointSites.length
            ),
            access: siteAccessNotCollected(),
            tenantSettings: collectionState(
              'sharepoint.tenant.settings',
              sharePointSettings ?? null
            ),
            usage: collectionState(
              'sharepoint.usage',
              sharePointUsageSynchronized ? reportedSharePointUsedBytes : null
            ),
            activity: collectionState(
              'sharepoint.activity',
              sharePointUsageSynchronized ? sharePointActivity.length : null
            ),
            owners: collectionState('sharepoint.owners'),
            deletedSites: collectionState('sharepoint.deleted-sites'),
          },
          sync: {
            sites: {
              status:
                sharePointSitesSyncState?.status.toLowerCase() ??
                'never-synced',
              lastSuccessfulAt:
                sharePointSitesSyncState?.lastSuccessfulAt?.toISOString() ??
                null,
              lastError: sharePointSitesSyncState?.lastErrorMessage ?? null,
            },
            settings: {
              status:
                sharePointSettingsSyncState?.status.toLowerCase() ??
                'never-synced',
              lastSuccessfulAt:
                sharePointSettingsSyncState?.lastSuccessfulAt?.toISOString() ??
                null,
              lastError: sharePointSettingsSyncState?.lastErrorMessage ?? null,
            },
            usage: {
              status:
                sharePointUsageSyncState?.status.toLowerCase() ??
                'never-synced',
              lastSuccessfulAt:
                sharePointUsageSyncState?.lastSuccessfulAt?.toISOString() ??
                null,
              lastError: sharePointUsageSyncState?.lastErrorMessage ?? null,
            },
          },
          capabilities: {
            tenantSettings: sharePointSettingsSynchronized,
            usageReport: sharePointUsageSynchronized,
            // The usage report provides one reported owner, not a complete
            // owners collection. It can still identify sites for which
            // Microsoft reports no owner at all.
            siteOwnerPresence: sharePointUsageSynchronized,
            deletedSites: sharePointUsageSynchronized,
          },
          overview: {
            totalSites: sharePointSites.length,
            summedSiteStorageUsedBytes: sharePointUsageSynchronized
              ? reportedSharePointUsedBytes
              : null,
            summedSiteQuotaBytes: sharePointUsageSynchronized
              ? reportedSharePointAllocationBytes
              : null,
            // Microsoft Graph does not expose the licensed tenant storage
            // pool. Its usage report does provide each reported site's
            // allocation, so expose that useful aggregate with an explicit
            // capability label instead of presenting it as licensed quota.
            totalStorageQuotaGB:
              sharePointUsageSynchronized &&
              reportedSharePointAllocationBytes > 0
                ? bytesToGb(reportedSharePointAllocationBytes)
                : null,
            storageQuotaSource:
              sharePointUsageSynchronized &&
              reportedSharePointAllocationBytes > 0
                ? 'reported-site-allocation'
                : 'unavailable',
            oneDriveStorageLimitGB:
              typeof sharePointSettings?.personalSiteDefaultStorageLimitInMB ===
              'number'
                ? Math.round(
                    (sharePointSettings.personalSiteDefaultStorageLimitInMB /
                      1024) *
                      100
                  ) / 100
                : null,
            siteStorageLimitsMode:
              typeof sharePointSettings?.isSitesStorageLimitAutomatic ===
              'boolean'
                ? sharePointSettings.isSitesStorageLimitAutomatic
                  ? 'Automatic'
                  : 'Manual'
                : 'Unavailable from Microsoft Graph',
            sitesMissingReportedOwner: sharePointUsageSynchronized
              ? sharePointSites.filter((site) => {
                  const usage = getSharePointUsage(site)
                  return ![
                    usage?.['Owner Principal Name'],
                    usage?.['Owner Display Name'],
                  ].some(
                    (owner) =>
                      typeof owner === 'string' && Boolean(owner.trim())
                  )
                }).length
              : null,
            activityAsOf: sharePointActivityAsOf.toISOString(),
            activityObservationWindowDays: 180,
            inactiveSites90Days: sharePointUsageSynchronized
              ? inactiveSharePointSites90Days
              : null,
            inactiveSites180Days: sharePointUsageSynchronized
              ? inactiveSharePointSites180Days
              : null,
            sitesWithActivityData: sharePointUsageSynchronized
              ? sharePointSites.length - sharePointSitesWithoutActivity
              : null,
            sitesWithoutActivityData: sharePointUsageSynchronized
              ? sharePointSitesWithoutActivity
              : null,
            activityDataStatus: sharePointUsageIdentifiersConcealed
              ? 'identifiers-concealed'
              : sharePointUsageSynchronized
                ? sharePointSitesWithoutActivity === 0
                  ? 'available'
                  : 'partial'
                : 'unavailable',
            activityReportRows: sharePointUsageRowsWithActivity.length,
            matchedActivitySites: matchedSharePointUsageRows.size,
            activityDataMessage: sharePointUsageIdentifiersConcealed
              ? 'Microsoft returned SharePoint activity dates with concealed site identifiers. Turn off concealed names in Microsoft 365 Admin Center > Settings > Org settings > Services > Reports, then synchronize again.'
              : null,
            // Canonical combined tenant policy. The aliases are a temporary
            // compatibility bridge for the deployed frontend; they always
            // equal this canonical value and are not independent observations.
            tenantSharingCapability:
              sharePointDataContract.tenantSettings.externalSharing.capability,
            sharingSharePoint:
              sharePointDataContract.tenantSettings.externalSharing.capability,
            sharingOneDrive:
              sharePointDataContract.tenantSettings.externalSharing.capability,
            sharingCompatibility: {
              canonicalField: 'tenantSharingCapability',
              deprecatedAliases: ['sharingSharePoint', 'sharingOneDrive'],
              aliasesRepresentSameCombinedTenantPolicy: true,
            },
          },
          sites: sharePointSites.map((site) => {
            const usage = getSharePointUsage(site)
            const activity = getSharePointActivity(site)
            const reportStorageUsed = parseReportBytes(
              usage?.['Storage Used (Byte)']
            )
            const reportStorageAllocated = parseReportBytes(
              usage?.['Storage Allocated (Byte)']
            )
            return {
              id: site.id,
              name: site.displayName || site.name || 'Unnamed SharePoint site',
              url: site.webUrl || '',
              type: getSharePointSiteType(site, usage),
              // Historical full-control enrichment remains historical only.
              // Never present it as current in standard least-privilege mode.
              externalSharing: null,
              guestsCount: null,
              owners: null,
              hasReportedOwner: [
                usage?.['Owner Principal Name'],
                usage?.['Owner Display Name'],
              ].some(
                (owner) => typeof owner === 'string' && Boolean(owner.trim())
              ),
              ownerDisplayName:
                typeof usage?.['Owner Display Name'] === 'string' &&
                usage['Owner Display Name'].trim()
                  ? usage['Owner Display Name'].trim()
                  : null,
              storageUsedGB: bytesToGb(
                reportStorageUsed ?? site?.driveQuota?.used
              ),
              storageQuotaGB: bytesToGb(
                reportStorageAllocated ?? site?.driveQuota?.total
              ),
              lastActivity:
                activity.activitySource === 'microsoft-d180-activity-not-reported'
                  ? 'Activity not reported by Microsoft'
                  : activity.activitySource === 'unmatched'
                    ? 'Activity unavailable for this site'
                    : activity.lastActivityAt || 'Activity date unavailable',
              lastActivityAt: activity.lastActivityAt,
              activityAgeDays: activity.activityAgeDays,
              activitySource: activity.activitySource,
              activityStatus:
                activity.activityAgeDays === null
                  ? 'unknown'
                  : activity.activityAgeDays >= 90
                    ? 'inactive'
                    : 'active',
              collection: {
                sharing: siteAccessNotCollected(),
                guests: siteAccessNotCollected(),
                storage:
                  reportStorageUsed !== null || reportStorageAllocated !== null
                    ? { ...collectionState('sharepoint.usage'), value: reportStorageUsed ?? reportStorageAllocated }
                    : collectionState('sharepoint.usage'),
                activity:
                  activity.activityAgeDays !== null
                    ? { ...collectionState('sharepoint.activity'), value: activity.lastActivityAt }
                    : collectionState('sharepoint.activity'),
                owners: collectionState('sharepoint.owners'),
              },
            }
          }),
          // This is the deleted-site signal in Microsoft's D180 usage report.
          // It is not the SharePoint recycle bin and must not be presented as
          // a complete list of recoverable sites.
          deletedSites: sharePointDataContract.reportedDeletedSites,
          deletedSitesSynchronized: sharePointUsageSynchronized,
          unsupported: {
            siteOwnerCount:
              'Microsoft Graph site inventory and usage reports do not provide a reliable owner count.',
            deletedSitesRecycleBin:
              'Microsoft Graph does not provide the complete SharePoint recycle-bin inventory; HawkView shows only the deleted flag in the D180 SharePoint usage report. That flag does not establish recoverability or deletion time.',
          },
        },
        teams: {},
        licenses: {
          rows: licenses.map((license) => ({
            skuId: license.microsoftSkuId,
            skuPartNumber: license.skuPartNumber,
            name: getMicrosoftSkuName(license.skuPartNumber),
            used: license.consumedUnits,
            total: license.enabledUnits,
            warning: license.warningUnits,
            suspended: license.suspendedUnits,
            lockedOut: license.lockedOutUnits,
            capabilityStatus: license.capabilityStatus,
          })),
        },
        entra: {
          collection: {
            conditionalAccess: {
              ...collectionState('entra.conditional-access'),
              value: (snapshotByResource.get('CONDITIONAL_ACCESS') ?? []).length,
            },
          },
          securityDefaults:
            typeof securityDefaults?.isEnabled === 'boolean'
              ? {
                  enabled: securityDefaults.isEnabled,
                  state: securityDefaults.isEnabled ? 'ENABLED' : 'DISABLED',
                }
              : null,
          groups: directoryGroups.map((group) => {
            const graphGroup = groupSnapshotById.get(group.microsoftGroupId)
            const isUnified = group.groupTypes.includes('Unified')
            const isDynamic = group.groupTypes.includes('DynamicMembership')
            const type = isUnified
              ? isDynamic
                ? 'Dynamic Microsoft 365'
                : 'Microsoft 365'
              : group.mailEnabled && group.securityEnabled
                ? 'Mail-enabled security'
                : group.mailEnabled
                  ? 'Distribution list'
                  : isDynamic
                    ? 'Dynamic security'
                    : 'Security'
            return {
              id: group.microsoftGroupId,
              objectId: group.microsoftGroupId,
              displayName: group.displayName,
              description: group.description,
              mail: group.mail,
              type,
              groupType: type,
              membershipType: isDynamic ? 'Dynamic' : 'Assigned',
              visibility: group.visibility,
              membersCount: group.memberships.length,
              members: uniquePrincipalLabels(
                group.memberships.map((membership) => membership.directoryUser)
              ),
              owners: Array.isArray(graphGroup?.owners)
                ? uniquePrincipalLabels(graphGroup.owners)
                : [],
              onPremisesSyncEnabled:
                typeof graphGroup?.onPremisesSyncEnabled === 'boolean'
                  ? graphGroup.onPremisesSyncEnabled
                  : false,
            }
          }),
          enterpriseApplications: servicePrincipals.map((principal) => ({
            id: principal.id,
            objectId: principal.id,
            appId: principal.appId,
            displayName: principal.displayName,
            description: principal.description,
            publisher:
              principal.verifiedPublisher?.displayName ??
              principal.publisherName ??
              'Publisher not verified',
            verifiedPublisher: Boolean(
              principal.verifiedPublisher?.verifiedPublisherId
            ),
            servicePrincipalType: principal.servicePrincipalType,
            accountEnabled: principal.accountEnabled,
            appRoleAssignmentRequired: principal.appRoleAssignmentRequired,
            createdDateTime: principal.createdDateTime,
            homepageUrl: principal.homepage,
            loginUrl: principal.loginUrl,
            preferredSingleSignOnMode: principal.preferredSingleSignOnMode,
            assignedUsers: Array.isArray(principal.appRoleAssignedTo)
              ? principal.appRoleAssignedTo
                  .filter(
                    (assignment: any) => assignment.principalType === 'User'
                  )
                  .map(
                    (assignment: any) =>
                      assignment.principalDisplayName ?? assignment.principalId
                  )
              : [],
            assignedGroups: Array.isArray(principal.appRoleAssignedTo)
              ? principal.appRoleAssignedTo
                  .filter(
                    (assignment: any) => assignment.principalType === 'Group'
                  )
                  .map(
                    (assignment: any) =>
                      assignment.principalDisplayName ?? assignment.principalId
                  )
              : [],
            assignedServicePrincipals: Array.isArray(
              principal.appRoleAssignedTo
            )
              ? principal.appRoleAssignedTo
                  .filter(
                    (assignment: any) =>
                      assignment.principalType === 'ServicePrincipal'
                  )
                  .map(
                    (assignment: any) =>
                      assignment.principalDisplayName ?? assignment.principalId
                  )
              : [],
            delegatedGrants: [],
            applicationPermissions: [],
          })),
          appRegistrations: applications.map((application) => {
            const now = Date.now()
            const credentials = [
              ...(Array.isArray(application.passwordCredentials)
                ? application.passwordCredentials.map((credential: any) => ({
                    type: 'Secret',
                    name: credential.displayName ?? 'Client secret',
                    startDate: credential.startDateTime,
                    endDate: credential.endDateTime,
                  }))
                : []),
              ...(Array.isArray(application.keyCredentials)
                ? application.keyCredentials.map((credential: any) => ({
                    type: 'Certificate',
                    name: credential.displayName ?? 'Certificate',
                    startDate: credential.startDateTime,
                    endDate: credential.endDateTime,
                  }))
                : []),
            ].map((credential: any) => {
              const expiration = Date.parse(credential.endDate ?? '')
              const daysRemaining = Number.isFinite(expiration)
                ? (expiration - now) / 86_400_000
                : null
              return {
                ...credential,
                status:
                  daysRemaining === null
                    ? 'Unknown'
                    : daysRemaining < 0
                      ? 'Expired'
                      : daysRemaining <= 30
                        ? 'Expiring'
                        : 'Active',
              }
            })
            const apiPermissions = Array.isArray(
              application.requiredResourceAccess
            )
              ? application.requiredResourceAccess.flatMap((resource: any) =>
                  Array.isArray(resource.resourceAccess)
                    ? resource.resourceAccess.map((permission: any) => {
                        const resourceApi = resourceApiByAppId.get(
                          String(resource.resourceAppId ?? '').toLowerCase()
                        )
                        const permissionName =
                          resourceApi?.permissionsById.get(
                            String(permission.id ?? '').toLowerCase()
                          ) ?? permission.id
                        return {
                          name: permissionName,
                          resourceApi:
                            resourceApi?.displayName ?? resource.resourceAppId,
                          type:
                            permission.type === 'Role'
                              ? 'Application'
                              : 'Delegated',
                          scopeOrRole: permissionName,
                        }
                      })
                    : []
                )
              : []
            return {
              id: application.id,
              objectId: application.id,
              appId: application.appId,
              displayName: application.displayName,
              description: application.description,
              createdDateTime: application.createdDateTime,
              publisherDomain: application.publisherDomain,
              signInAudience: application.signInAudience,
              homepageUrl: application.web?.homePageUrl,
              identifierUris: application.identifierUris ?? [],
              owners: Array.isArray(application.owners)
                ? application.owners.map(
                    (owner: any) =>
                      owner.displayName ?? owner.userPrincipalName ?? owner.id
                  )
                : [],
              credentials,
              apiPermissions,
            }
          }),
          caPolicies: (snapshotByResource.get('CONDITIONAL_ACCESS') ?? []).map(
            (policy) => {
              const includeUsers = policy?.conditions?.users?.includeUsers ?? []
              const includeGroups =
                policy?.conditions?.users?.includeGroups ?? []
              const includeRoles = policy?.conditions?.users?.includeRoles ?? []
              const grants = policy?.grantControls?.builtInControls ?? []
              const state =
                policy?.state === 'enabled'
                  ? 'ON'
                  : policy?.state === 'enabledForReportingButNotEnforced'
                    ? 'REPORT_ONLY'
                    : 'OFF'
              return {
                id: policy.id,
                name: policy.displayName ?? 'Unnamed policy',
                state,
                origin: policy.templateId ? 'MICROSOFT_TEMPLATE' : 'CUSTOM',
                targetSummary: includeUsers.includes('All')
                  ? 'All Users'
                  : `${includeUsers.length + includeGroups.length + includeRoles.length} targets`,
                grantSummary:
                  grants.length > 0
                    ? grants
                        .map((grant: string) =>
                          grant === 'mfa'
                            ? 'Require multifactor authentication'
                            : grant === 'block'
                              ? 'Block access'
                              : grant
                        )
                        .join(', ')
                    : 'No grant controls',
                assignments: {
                  usersAndGroups: {
                    include: [
                      ...includeUsers,
                      ...includeGroups,
                      ...includeRoles,
                    ],
                    exclude: [
                      ...(policy?.conditions?.users?.excludeUsers ?? []),
                      ...(policy?.conditions?.users?.excludeGroups ?? []),
                      ...(policy?.conditions?.users?.excludeRoles ?? []),
                    ],
                  },
                  cloudApps: {
                    include: (
                      policy?.conditions?.applications?.includeApplications ??
                      []
                    ).map(resolveApplicationTarget),
                    exclude: (
                      policy?.conditions?.applications?.excludeApplications ??
                      []
                    ).map(resolveApplicationTarget),
                  },
                },
                conditions: {
                  platforms:
                    policy?.conditions?.platforms?.includePlatforms ?? [],
                },
                accessControls: {
                  grant: grants.map((grant: string) =>
                    grant === 'mfa'
                      ? 'Require multifactor authentication'
                      : grant === 'block'
                        ? 'Block access'
                        : grant
                  ),
                },
              }
            }
          ),
          authMethods: (
            snapshotByResource.get('AUTH_METHOD_POLICIES') ?? []
          ).map((method) => ({
            id: method.id,
            name: formatAuthenticationMethodName(method.id),
            target: summarizeAuthenticationMethodTargets(method),
            status: method.state === 'enabled' ? 'ENABLED' : 'DISABLED',
          })),
          namedLocations: (snapshotByResource.get('NAMED_LOCATIONS') ?? []).map(
            (location) => ({
              id: location.id,
              name: location.displayName ?? 'Unnamed location',
              type: location.isTrusted === true ? 'TRUSTED' : 'OTHER',
              addresses: Array.isArray(location.ipRanges)
                ? location.ipRanges
                    .map((range: any) => range.cidrAddress)
                    .filter(Boolean)
                : (location.countriesAndRegions ?? []),
            })
          ),
        },
        syncedAt: lastSync?.toISOString() ?? null,
        sync: {
          users: {
            status: userSyncState?.status.toLowerCase() ?? 'never-synced',
            lastSuccessfulAt:
              userSyncState?.lastSuccessfulAt?.toISOString() ?? null,
            lastError: userSyncState?.lastErrorMessage ?? null,
          },
          licenses: {
            status: licenseSyncState?.status.toLowerCase() ?? 'never-synced',
            lastSuccessfulAt:
              licenseSyncState?.lastSuccessfulAt?.toISOString() ?? null,
            lastError: licenseSyncState?.lastErrorMessage ?? null,
          },
          domains: {
            status: domainSyncState?.status.toLowerCase() ?? 'never-synced',
            lastSuccessfulAt:
              domainSyncState?.lastSuccessfulAt?.toISOString() ?? null,
            lastError: domainSyncState?.lastErrorMessage ?? null,
          },
          groups: {
            status: groupSyncState?.status.toLowerCase() ?? 'never-synced',
            lastSuccessfulAt:
              groupSyncState?.lastSuccessfulAt?.toISOString() ?? null,
            lastError: groupSyncState?.lastErrorMessage ?? null,
          },
          signIns: {
            status: signInSyncState?.status.toLowerCase() ?? 'never-synced',
            lastSuccessfulAt:
              signInSyncState?.lastSuccessfulAt?.toISOString() ?? null,
            lastError: signInSyncState?.lastErrorMessage ?? null,
          },
          auditLogs: {
            status: auditLogSyncState?.status.toLowerCase() ?? 'never-synced',
            lastSuccessfulAt:
              auditLogSyncState?.lastSuccessfulAt?.toISOString() ?? null,
            lastError: auditLogSyncState?.lastErrorMessage ?? null,
          },
          m365Audit: {
            status: m365AuditSyncState?.status.toLowerCase() ?? 'never-synced',
            lastSuccessfulAt:
              m365AuditSyncState?.lastSuccessfulAt?.toISOString() ?? null,
            lastError: m365AuditSyncState?.lastErrorMessage ?? null,
            source: 'Office 365 Management Activity API',
            pollingIsAuthoritative: true,
            subscriptions: m365AuditSubscriptions.map((subscription) => ({
              contentType: subscription.contentType,
              status: subscription.status.toLowerCase(),
              lastStartRequestedAt:
                subscription.lastStartRequestedAt?.toISOString() ?? null,
              lastVerifiedAt: subscription.lastVerifiedAt?.toISOString() ?? null,
              lastSuccessfulPollAt:
                subscription.lastSuccessfulPollAt?.toISOString() ?? null,
              discoveryWindowStart:
                subscription.discoveryWindowStart?.toISOString() ?? null,
              discoveryWindowEnd:
                subscription.discoveryWindowEnd?.toISOString() ?? null,
              discoveryHasContinuation: Boolean(subscription.discoveryNextPageUri),
              lastError: subscription.lastError,
            })),
            backlog: {
              pending: m365AuditCounts.PENDING ?? 0,
              processing: m365AuditCounts.PROCESSING ?? 0,
              retrying: m365AuditCounts.RETRY ?? 0,
              failed: m365AuditCounts.FAILED ?? 0,
              oldestAt:
                (oldestM365AuditBacklog?.contentCreatedAt ??
                  oldestM365AuditBacklog?.discoveredAt)?.toISOString() ?? null,
            },
            costBudget: {
              usageDate: m365AuditToday.toISOString().slice(0, 10),
              downloadedBytes: Number(m365AuditUsage?.downloadedBytes ?? 0n),
              recordsStored: m365AuditUsage?.recordsStored ?? 0,
              blobsProcessed: m365AuditUsage?.blobsProcessed ?? 0,
              monthDownloadedBytes: Number(m365AuditMonthlyUsage._sum.downloadedBytes ?? 0n),
              monthRecordsStored: m365AuditMonthlyUsage._sum.recordsStored ?? 0,
              monthBlobsProcessed: m365AuditMonthlyUsage._sum.blobsProcessed ?? 0,
              tenantDailyDownloadLimitBytes: Number(m365AuditLimits.tenantBytes),
              deploymentDailyDownloadLimitBytes: Number(m365AuditLimits.deploymentBytes),
              tenantMonthlyDownloadLimitBytes: Number(m365AuditLimits.tenantMonthlyBytes),
              deploymentMonthlyDownloadLimitBytes: Number(m365AuditLimits.deploymentMonthlyBytes),
              tenantDailyRecordLimit: m365AuditLimits.tenantRecords,
              deploymentDailyRecordLimit: m365AuditLimits.deploymentRecords,
              tenantMonthlyRecordLimit: m365AuditLimits.tenantMonthlyRecords,
              deploymentMonthlyRecordLimit: m365AuditLimits.deploymentMonthlyRecords,
              dailyResetsAt: new Date(m365AuditToday.getTime() + 24 * 60 * 60 * 1000).toISOString(),
              monthlyResetsAt: new Date(Date.UTC(
                m365AuditToday.getUTCFullYear(),
                m365AuditToday.getUTCMonth() + 1,
                1
              )).toISOString(),
            },
          },
          sharePointSites: {
            status: sharePointSitesSyncState?.status.toLowerCase() ?? 'never-synced',
            lastSuccessfulAt: sharePointSitesSyncState?.lastSuccessfulAt?.toISOString() ?? null,
            lastError: sharePointSitesSyncState?.lastErrorMessage ?? null,
          },
          sharePointSettings: {
            status: sharePointSettingsSyncState?.status.toLowerCase() ?? 'never-synced',
            lastSuccessfulAt: sharePointSettingsSyncState?.lastSuccessfulAt?.toISOString() ?? null,
            lastError: sharePointSettingsSyncState?.lastErrorMessage ?? null,
          },
          sharePointUsage: {
            status: sharePointUsageSyncState?.status.toLowerCase() ?? 'never-synced',
            lastSuccessfulAt: sharePointUsageSyncState?.lastSuccessfulAt?.toISOString() ?? null,
            lastError: sharePointUsageSyncState?.lastErrorMessage ?? null,
          },
          applications: exchangeSync('APPLICATIONS'),
          servicePrincipals: exchangeSync('SERVICE_PRINCIPALS'),
          securityDefaults: exchangeSync('SECURITY_DEFAULTS'),
        },
      },
    }
  }
}
