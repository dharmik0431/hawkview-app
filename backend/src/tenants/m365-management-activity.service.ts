import { Inject, Injectable, Logger } from '@nestjs/common'
import { createHash } from 'node:crypto'
import { PrismaService } from '../prisma/prisma.service.js'
import { MicrosoftConsentService } from '../microsoft/microsoft-consent.service.js'
import { redactSensitiveValues } from '../changes/change-evidence.service.js'
import {
  classifyManagementActivity,
  type ManagementActivityRole,
} from '../changes/m365-activity-classification.js'
import { classifyEvidenceTrust } from '../changes/evidence-trust-catalog.js'
import type { Prisma } from '../generated/prisma/client.js'

export { classifyManagementActivity, managementActivityRoleFromEvidence } from '../changes/m365-activity-classification.js'

export const M365_ACTIVITY_CONTENT_TYPES = [
  'Audit.AzureActiveDirectory',
  'Audit.Exchange',
  'Audit.SharePoint',
  'Audit.General',
] as const

const MANAGEMENT_HOST = 'manage.office.com'
const SUBSCRIPTION_VERIFY_MS = 24 * 60 * 60 * 1000
const SUBSCRIPTION_START_COOLDOWN_MS = 15 * 60 * 1000
const DEFAULT_POLL_INTERVAL_MS = 15 * 60 * 1000
const CONTENT_LEDGER_RETENTION_MS = 30 * 24 * 60 * 60 * 1000
const EVIDENCE_RETENTION_MONTHS = 6
const MAX_CONTENT_PAGES_PER_TYPE_PER_RUN = 100
const MAX_RECORDS_PER_BLOB = 20_000
const MAX_DISCOVERY_RESPONSE_BYTES = 2 * 1024 * 1024
const MAX_CONTENT_RESPONSE_BYTES = 10 * 1024 * 1024
const MAX_ERROR_RESPONSE_BYTES = 64 * 1024
const PROCESSING_LEASE_MS = 15 * 60 * 1000

type JsonObject = Record<string, unknown>
type TenantTarget = {
  id: string
  organizationId: string
  microsoftTenantId: string
  connection: {
    connectionMode: string
    clientId: string | null
    credentialReference: string | null
  } | null
}

export type ManagementActivityChange = {
  activityDisplayName: string
  category: string | null
  loggedByService: string | null
  targetResources: unknown
}

const object = (value: unknown): JsonObject =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as JsonObject)
    : {}
const text = (value: unknown) =>
  typeof value === 'string' && value.trim() ? value.trim() : null
const array = (value: unknown): unknown[] => (Array.isArray(value) ? value : [])
const validDate = (value: unknown) => {
  if (typeof value !== 'string') return null
  const date = new Date(value)
  return Number.isFinite(date.getTime()) ? date : null
}
const boundedInt = (value: string | undefined, fallback: number, maximum: number) => {
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed > 0
    ? Math.min(parsed, maximum)
    : fallback
}
const safeMessage = (error: unknown) =>
  (error instanceof Error ? error.message : String(error)).slice(0, 1_000)

const boundedText = (value: unknown, maximum: number) =>
  text(value)?.slice(0, maximum) ?? null

function boundedSourceEventId(value: string) {
  if (value.length <= 200) return value
  const digest = createHash('sha256').update(value).digest('hex')
  return `${value.slice(0, 134)}:${digest}`
}

export class ManagementActivityHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly retryAfterSeconds: number | null = null
  ) {
    super(message)
  }
}

export class M365AuditBudgetError extends Error {
  constructor(message: string, readonly retryAt = nextUtcUsageDate()) {
    super(message)
  }
}

export function m365AuditUsageDate(value = new Date()) {
  return new Date(Date.UTC(
    value.getUTCFullYear(),
    value.getUTCMonth(),
    value.getUTCDate()
  ))
}

function nextUtcUsageDate(value = new Date()) {
  return new Date(m365AuditUsageDate(value).getTime() + 24 * 60 * 60 * 1000)
}

function nextUtcMonthDate(value = new Date()) {
  return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth() + 1, 1))
}

export function m365AuditUsageLimits() {
  return {
    tenantBytes: BigInt(
      boundedInt(process.env.M365_AUDIT_TENANT_DAILY_DOWNLOAD_MB, 50, 10_000)
    ) * 1024n * 1024n,
    deploymentBytes: BigInt(
      boundedInt(process.env.M365_AUDIT_DEPLOYMENT_DAILY_DOWNLOAD_MB, 100, 100_000)
    ) * 1024n * 1024n,
    tenantMonthlyBytes: BigInt(
      boundedInt(process.env.M365_AUDIT_TENANT_MONTHLY_DOWNLOAD_MB, 1_000, 100_000)
    ) * 1024n * 1024n,
    deploymentMonthlyBytes: BigInt(
      boundedInt(process.env.M365_AUDIT_DEPLOYMENT_MONTHLY_DOWNLOAD_MB, 2_000, 1_000_000)
    ) * 1024n * 1024n,
    tenantRecords: boundedInt(
      process.env.M365_AUDIT_TENANT_DAILY_RECORDS,
      1_000,
      1_000_000
    ),
    deploymentRecords: boundedInt(
      process.env.M365_AUDIT_DEPLOYMENT_DAILY_RECORDS,
      2_000,
      10_000_000
    ),
    tenantMonthlyRecords: boundedInt(
      process.env.M365_AUDIT_TENANT_MONTHLY_RECORDS,
      20_000,
      10_000_000
    ),
    deploymentMonthlyRecords: boundedInt(
      process.env.M365_AUDIT_DEPLOYMENT_MONTHLY_RECORDS,
      40_000,
      100_000_000
    ),
  }
}

export function retryDelayMs(
  attempt: number,
  retryAfterSeconds: number | null,
  random = Math.random
) {
  if (retryAfterSeconds !== null && retryAfterSeconds >= 0) {
    return Math.min(retryAfterSeconds * 1_000, 15 * 60 * 1_000)
  }
  const base = Math.min(1_000 * 2 ** Math.max(0, attempt), 60_000)
  return Math.round(base * (0.8 + random() * 0.4))
}

export function validateManagementUrl(url: string, microsoftTenantId: string) {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new Error('Microsoft returned an invalid Management Activity URL.')
  }
  const tenantPath = `/api/v1.0/${microsoftTenantId.toLowerCase()}/activity/feed/`
  if (
    parsed.protocol !== 'https:' ||
    parsed.hostname.toLowerCase() !== MANAGEMENT_HOST ||
    !parsed.pathname.toLowerCase().startsWith(tenantPath)
  ) {
    throw new Error('Microsoft returned a Management Activity URL outside the connected tenant.')
  }
  return parsed
}

export function managementContentWindows(start: Date, end: Date) {
  const windows: Array<{ start: Date; end: Date }> = []
  let cursor = new Date(start)
  while (cursor < end) {
    const windowEnd = new Date(
      Math.min(end.getTime(), cursor.getTime() + 24 * 60 * 60 * 1000)
    )
    windows.push({ start: cursor, end: windowEnd })
    cursor = windowEnd
  }
  return windows
}

/**
 * The Management Activity API carries high-volume usage telemetry. HawkView's
 * primary timeline is intentionally limited to genuine administrative,
 * configuration, security, permission, and sharing changes.
 */
export function isPrimaryManagementActivity(record: unknown) {
  return classifyManagementActivity(record) === 'primary_change'
}

function limitEvidence(value: unknown, depth = 0): unknown {
  if (depth > 5) return '[TRUNCATED]'
  if (typeof value === 'string') return value.slice(0, 4_000)
  if (Array.isArray(value)) {
    return value.slice(0, 50).map((entry) => limitEvidence(entry, depth + 1))
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as JsonObject)
        .slice(0, 100)
        .map(([key, child]) => [key, limitEvidence(child, depth + 1)])
    )
  }
  return value
}

const retainedEvidenceKeys = new Set([
  'Id', 'RecordType', 'CreationTime', 'Operation', 'OrganizationId', 'UserType',
  'UserKey', 'Workload', 'ResultStatus', 'ObjectId', 'UserId', 'ClientIP',
  'ClientRequestId', 'CorrelationId', 'ActorIpAddress', 'EventSource', 'ItemType',
  'ExternalAccess', 'SiteUrl', 'SourceFileName', 'SourceRelativeUrl',
  'TargetUserOrGroupName', 'TargetUserOrGroupType', 'MailboxOwnerUPN',
  'hawkviewSupportingActivityCount', 'hawkviewSupportingFirstSeenAt',
  'hawkviewSupportingLastSeenAt', 'hawkviewSupportingSampleRecordIds',
  'Parameters', 'ModifiedProperties', 'ExtendedProperties', 'Members',
])

const sensitivePropertyName = /(?:password|secret|token|authorization|credential|private.?key|client.?secret|assertion|certificate)/i

function redactNamedProperties(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactNamedProperties)
  if (!value || typeof value !== 'object') return value
  const entry = value as JsonObject
  const propertyName = text(entry.Name) ?? text(entry.DisplayName)
  return Object.fromEntries(
    Object.entries(entry).map(([key, child]) => [
      key,
      propertyName && sensitivePropertyName.test(propertyName) &&
      /^(?:value|oldvalue|newvalue)$/i.test(key)
        ? '[REDACTED]'
        : redactNamedProperties(child),
    ])
  )
}

export function compactManagementEvidence(record: unknown) {
  const source = object(record)
  const selected = Object.fromEntries(
    Object.entries(source).filter(([key]) => retainedEvidenceKeys.has(key))
  )
  return limitEvidence(
    redactSensitiveValues(redactNamedProperties(selected))
  ) as JsonObject
}

export async function readBoundedJson(
  response: Response,
  maximumBytes: number,
  budget?: { remainingBytes: number }
) {
  const effectiveMaximum = Math.min(
    maximumBytes,
    budget?.remainingBytes ?? maximumBytes
  )
  if (effectiveMaximum <= 0) {
    throw new Error('Microsoft 365 activity download budget is exhausted for this run.')
  }
  const declaredLength = Number(response.headers.get('Content-Length'))
  if (Number.isFinite(declaredLength) && declaredLength > effectiveMaximum) {
    throw new Error(`Microsoft 365 activity response exceeded the ${effectiveMaximum}-byte safety limit.`)
  }
  if (!response.body) return null
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let length = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    length += value.byteLength
    if (length > effectiveMaximum) {
      await reader.cancel()
      throw new Error(`Microsoft 365 activity response exceeded the ${effectiveMaximum}-byte safety limit.`)
    }
    chunks.push(value)
  }
  const body = Buffer.concat(chunks, length).toString('utf8')
  if (budget) budget.remainingBytes -= length
  return body ? JSON.parse(body) : null
}

export async function readBoundedText(response: Response, maximumBytes: number) {
  if (!response.body) return ''
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let length = 0
  let truncated = false
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    const remaining = maximumBytes - length
    if (value.byteLength > remaining) {
      if (remaining > 0) chunks.push(value.slice(0, remaining))
      length = maximumBytes
      truncated = true
      await reader.cancel()
      break
    }
    chunks.push(value)
    length += value.byteLength
  }
  const body = Buffer.concat(chunks, length).toString('utf8')
  return truncated ? `${body} [TRUNCATED]` : body
}

function categoryFor(operation: string, workload: string | null) {
  const classified = classifyEvidenceTrust({
    source: 'Office 365 Management Activity API', workload, operation,
  })
  return classified.category === 'Unknown' ? 'Microsoft 365' : classified.category
}

function severityFor(operation: string, workload: string | null) {
  return classifyEvidenceTrust({
    source: 'Office 365 Management Activity API', workload, operation,
  }).severity
}

function changedState(record: JsonObject) {
  const before: JsonObject = {}
  const after: JsonObject = {}
  const fields: string[] = []
  for (const property of array(record.ModifiedProperties).map(object)) {
    const name = text(property.Name) ?? text(property.DisplayName)
    if (!name) continue
    fields.push(name)
    before[name] = redactSensitiveValues(property.OldValue, name)
    after[name] = redactSensitiveValues(property.NewValue, name)
  }
  for (const parameter of array(record.Parameters).map(object)) {
    const name = text(parameter.Name)
    if (!name || fields.includes(name)) continue
    fields.push(name)
    after[name] = redactSensitiveValues(parameter.Value, name)
  }
  return {
    before: Object.keys(before).length ? before : null,
    after: Object.keys(after).length ? after : null,
    fields: fields.length ? fields : null,
  }
}

function evidenceExpiration(now: Date) {
  const expiresAt = new Date(now)
  expiresAt.setUTCMonth(expiresAt.getUTCMonth() + EVIDENCE_RETENTION_MONTHS)
  return expiresAt
}

function normalizedAction(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '')
}

function sameAction(left: string, right: string) {
  const a = normalizedAction(left)
  const b = normalizedAction(right)
  return a === b || (Math.min(a.length, b.length) >= 12 && (a.includes(b) || b.includes(a)))
}

async function wait(milliseconds: number) {
  await new Promise((resolve) => setTimeout(resolve, milliseconds))
}

@Injectable()
export class M365ManagementActivityService {
  private readonly logger = new Logger(M365ManagementActivityService.name)

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(MicrosoftConsentService)
    private readonly microsoftConsent: MicrosoftConsentService
  ) {}

  private async request(
    url: string,
    init: RequestInit,
    microsoftTenantId: string,
    publisherIdentifier: string
  ) {
    const requestUrl = validateManagementUrl(url, microsoftTenantId)
    requestUrl.searchParams.set('PublisherIdentifier', publisherIdentifier)
    let lastError: unknown
    // Microsoft requires a 15-minute gap between subscription-start
    // requests. Never automatically replay that POST after an ambiguous
    // timeout; the durable subscription state schedules a later verification.
    const maximumAttempts = init.method?.toUpperCase() === 'POST' ? 1 : 3
    for (let attempt = 0; attempt < maximumAttempts; attempt += 1) {
      try {
        const response = await fetch(requestUrl, {
          ...init,
          redirect: 'error',
          signal: AbortSignal.timeout(30_000),
        })
        if (response.ok) return response
        const retryAfter = Number(response.headers.get('Retry-After'))
        const retryAfterSeconds = Number.isFinite(retryAfter) ? retryAfter : null
        const body = (await readBoundedText(response, MAX_ERROR_RESPONSE_BYTES)).slice(0, 500)
        const error = new ManagementActivityHttpError(
          `Microsoft 365 activity feed returned HTTP ${response.status}${body ? `: ${body}` : '.'}`,
          response.status,
          retryAfterSeconds
        )
        throw error
      } catch (error) {
        if (error instanceof ManagementActivityHttpError && error.status < 500 && error.status !== 429) throw error
        lastError = error
        if (attempt >= maximumAttempts - 1) break
        const delay = retryDelayMs(
          attempt,
          error instanceof ManagementActivityHttpError
            ? error.retryAfterSeconds
            : null
        )
        // The Render cron caller has a four-minute deadline for an entire
        // tenant batch. Honor long Retry-After values by deferring to the next
        // scheduled run instead of sleeping through the worker lease.
        if (delay > 5_000) break
        await wait(delay)
      }
    }
    throw lastError instanceof Error ? lastError : new Error('Microsoft 365 activity feed request failed.')
  }

  private headers(token: string) {
    return { Authorization: `Bearer ${token}`, Accept: 'application/json' }
  }

  private baseUrl(tenant: TenantTarget) {
    return `https://${MANAGEMENT_HOST}/api/v1.0/${encodeURIComponent(tenant.microsoftTenantId)}/activity/feed`
  }

  private async readMeteredJson(
    tenant: TenantTarget,
    response: Response,
    maximumBytes: number,
    sharedBudget?: { remainingBytes: number }
  ) {
    const budget = sharedBudget ?? { remainingBytes: maximumBytes }
    const reservedBytes = Math.min(maximumBytes, budget.remainingBytes)
    const usageNow = new Date()
    await this.reserveDailyUsage(tenant, { bytes: reservedBytes }, usageNow)
    const remainingBeforeRead = budget.remainingBytes
    try {
      const payload = await readBoundedJson(response, maximumBytes, budget)
      const consumedBytes = remainingBeforeRead - budget.remainingBytes
      await this.releaseUnusedDownloadReservation(
        tenant,
        Math.max(0, reservedBytes - consumedBytes),
        usageNow
      )
      return payload
    } catch (error) {
      // Keep the conservative reservation when a response is interrupted or
      // malformed: Render may already have received those bytes.
      throw error
    }
  }

  private async reserveSubscriptionStart(
    tenant: TenantTarget,
    enabled: ReadonlySet<string>,
    now: Date
  ) {
    return this.prisma.$transaction(async (transaction) => {
      await transaction.$executeRawUnsafe(
        'SELECT pg_advisory_xact_lock(hashtext($1))',
        `hawkview:m365-subscription-start:${tenant.id}`
      )
      const stored = await transaction.m365ActivitySubscription.findMany({
        where: {
          organizationId: tenant.organizationId,
          customerTenantId: tenant.id,
        },
      })
      const lastStartRequestedAt = stored
        .map((entry) => entry.lastStartRequestedAt)
        .filter((value): value is Date => Boolean(value))
        .sort((left, right) => right.getTime() - left.getTime())[0]
      if (
        lastStartRequestedAt &&
        now.getTime() - lastStartRequestedAt.getTime() <
          SUBSCRIPTION_START_COOLDOWN_MS
      ) return null
      const storedByContentType = new Map(
        stored.map((entry) => [entry.contentType, entry])
      )
      const contentType = M365_ACTIVITY_CONTENT_TYPES
        .filter((candidate) => !enabled.has(candidate))
        .sort((left, right) => {
          const leftAttempt = storedByContentType.get(left)?.lastStartRequestedAt
          const rightAttempt = storedByContentType.get(right)?.lastStartRequestedAt
          if (!leftAttempt && rightAttempt) return -1
          if (leftAttempt && !rightAttempt) return 1
          if (leftAttempt && rightAttempt) {
            const difference = leftAttempt.getTime() - rightAttempt.getTime()
            if (difference !== 0) return difference
          }
          return (
            M365_ACTIVITY_CONTENT_TYPES.indexOf(left) -
            M365_ACTIVITY_CONTENT_TYPES.indexOf(right)
          )
        })[0]
      if (!contentType) return null
      await transaction.m365ActivitySubscription.upsert({
        where: {
          customerTenantId_contentType: {
            customerTenantId: tenant.id,
            contentType,
          },
        },
        create: {
          organizationId: tenant.organizationId,
          customerTenantId: tenant.id,
          contentType,
          status: 'STARTING',
          lastStartRequestedAt: now,
          lastVerifiedAt: now,
        },
        update: {
          status: 'STARTING',
          lastStartRequestedAt: now,
          lastVerifiedAt: now,
          lastError: null,
        },
      })
      return contentType
    })
  }

  private async ensureSubscriptions(
    tenant: TenantTarget,
    token: string,
    publisherIdentifier: string,
    now: Date
  ) {
    const stored = await this.prisma.m365ActivitySubscription.findMany({
      where: { organizationId: tenant.organizationId, customerTenantId: tenant.id },
    })
    const stillFresh =
      stored.length === M365_ACTIVITY_CONTENT_TYPES.length &&
      stored.every(
        (entry) =>
          entry.status === 'ENABLED' &&
          entry.lastVerifiedAt &&
          now.getTime() - entry.lastVerifiedAt.getTime() < SUBSCRIPTION_VERIFY_MS
      )
    if (stillFresh) return new Set<string>(M365_ACTIVITY_CONTENT_TYPES)

    const baseUrl = this.baseUrl(tenant)
    const listResponse = await this.request(
      `${baseUrl}/subscriptions/list`,
      { headers: this.headers(token) },
      tenant.microsoftTenantId,
      publisherIdentifier
    )
    const subscriptions = (await this.readMeteredJson(
      tenant,
      listResponse,
      MAX_DISCOVERY_RESPONSE_BYTES
    )) as Array<{
      contentType?: string
      status?: string
    }>
    if (!Array.isArray(subscriptions)) {
      throw new Error('Microsoft 365 activity subscription verification returned an invalid payload.')
    }
    const enabled = new Set(
      subscriptions
        .filter((entry) => entry.status?.toLowerCase() === 'enabled')
        .map((entry) => entry.contentType)
        .filter((value): value is string => Boolean(value))
    )

    const contentTypeToStart = await this.reserveSubscriptionStart(
      tenant,
      enabled,
      now
    )
    const startFailures = new Map<string, string>()

    if (contentTypeToStart) {
      try {
        await this.request(
          `${baseUrl}/subscriptions/start?contentType=${encodeURIComponent(contentTypeToStart)}`,
          { method: 'POST', headers: this.headers(token) },
          tenant.microsoftTenantId,
          publisherIdentifier
        )
        enabled.add(contentTypeToStart)
      } catch (error) {
        // A second worker or an earlier interrupted run can start the same
        // subscription between list and start. Verify a 400 race rather than
        // treating an already-enabled feed as missing coverage.
        if (!(error instanceof ManagementActivityHttpError) || error.status !== 400) throw error
        const verification = await this.request(
          `${baseUrl}/subscriptions/list`,
          { headers: this.headers(token) },
          tenant.microsoftTenantId,
          publisherIdentifier
        )
        const current = (await this.readMeteredJson(
          tenant,
          verification,
          MAX_DISCOVERY_RESPONSE_BYTES
        )) as Array<{ contentType?: string; status?: string }>
        const isEnabled = Array.isArray(current) && current.some(
          (entry) =>
            entry.contentType === contentTypeToStart &&
            entry.status?.toLowerCase() === 'enabled'
        )
        if (isEnabled) {
          enabled.add(contentTypeToStart)
        } else {
          // One workload can be unavailable or not provisioned while another
          // remains usable. Persist the exact content-type failure and keep
          // polling already-enabled workloads instead of turning it into an
          // all-or-nothing tenant outage.
          startFailures.set(contentTypeToStart, safeMessage(error))
        }
      }
    }

    const storedByContentType = new Map(
      stored.map((entry) => [entry.contentType, entry])
    )
    for (const contentType of M365_ACTIVITY_CONTENT_TYPES) {
      const isEnabled = enabled.has(contentType)
      const startFailure = startFailures.get(contentType)
      const previousFailure = storedByContentType.get(contentType)?.status === 'FAILED'
        ? storedByContentType.get(contentType)?.lastError
        : null
      const failure = startFailure ?? previousFailure
      await this.prisma.m365ActivitySubscription.upsert({
        where: {
          customerTenantId_contentType: {
            customerTenantId: tenant.id,
            contentType,
          },
        },
        create: {
          organizationId: tenant.organizationId,
          customerTenantId: tenant.id,
          contentType,
          status: isEnabled ? 'ENABLED' : failure ? 'FAILED' : 'PENDING',
          lastVerifiedAt: now,
          lastError: isEnabled
            ? null
            : failure ?? 'Subscription activation is pending Microsoft verification.',
        },
        update: {
          status: isEnabled ? 'ENABLED' : failure ? 'FAILED' : 'PENDING',
          lastVerifiedAt: now,
          lastError: isEnabled
            ? null
            : failure ?? 'Subscription activation is pending Microsoft verification.',
        },
      })
    }
    return enabled
  }

  private async discoverContent(
    tenant: TenantTarget,
    token: string,
    publisherIdentifier: string,
    enabledContentTypes: ReadonlySet<string>,
    now: Date,
    deadline: number,
    downloadBudget: { remainingBytes: number }
  ) {
    const baseUrl = this.baseUrl(tenant)
    const ledgerExpiresAt = new Date(now.getTime() + CONTENT_LEDGER_RETENTION_MS)
    let hasBacklog = false
    for (const contentType of M365_ACTIVITY_CONTENT_TYPES) {
      if (!enabledContentTypes.has(contentType)) continue
      const seen = new Set<string>()
      let pageCount = 0
      let state: Awaited<ReturnType<typeof this.prisma.m365ActivitySubscription.findUnique>> =
        await this.prisma.m365ActivitySubscription.findUnique({
        where: {
          customerTenantId_contentType: { customerTenantId: tenant.id, contentType },
        },
      })
      let contiguousStart: Date | null = null
      while (Date.now() < deadline) {
        const earliest = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000)
        const savedStart = state?.discoveryWindowStart
        const savedEnd = state?.discoveryWindowEnd
        const savedNext = state?.discoveryNextPageUri
        const freshStart = state?.lastSuccessfulPollAt
          ? new Date(
              Math.max(
                earliest.getTime(),
                state.lastSuccessfulPollAt.getTime() - 5 * 60 * 1000
              )
            )
          : new Date(now.getTime() - 24 * 60 * 60 * 1000)
        const windowStart: Date = savedStart && savedEnd && savedNext
          ? savedStart
          : (contiguousStart ?? freshStart)
        const windowEnd: Date = savedStart && savedEnd && savedNext
          ? savedEnd
          : new Date(
              Math.min(
                now.getTime(),
                windowStart.getTime() + 24 * 60 * 60 * 1000
              )
            )
        let nextUrl = savedStart && savedEnd && savedNext
          ? savedNext
          : `${baseUrl}/subscriptions/content?contentType=${encodeURIComponent(contentType)}&startTime=${encodeURIComponent(windowStart.toISOString())}&endTime=${encodeURIComponent(windowEnd.toISOString())}`

        if (seen.has(nextUrl)) {
          throw new Error('Microsoft 365 activity content pagination repeated a page URL.')
        }
        if (pageCount >= MAX_CONTENT_PAGES_PER_TYPE_PER_RUN) {
          hasBacklog = true
          break
        }
        pageCount += 1
        seen.add(nextUrl)
        const response = await this.request(
          nextUrl,
          { headers: this.headers(token) },
          tenant.microsoftTenantId,
          publisherIdentifier
        )
        const items = (await this.readMeteredJson(
          tenant,
          response,
          MAX_DISCOVERY_RESPONSE_BYTES,
          downloadBudget
        )) as Array<Record<string, unknown>>
        if (!Array.isArray(items)) {
          throw new Error('Microsoft 365 activity content discovery returned an invalid payload.')
        }
        const discovered: Array<Record<string, unknown>> = []
        for (const item of items) {
          const microsoftContentId = text(item.contentId)
          const contentUri = text(item.contentUri)
          if (!microsoftContentId || !contentUri) continue
          validateManagementUrl(contentUri, tenant.microsoftTenantId)
          discovered.push({
            organizationId: tenant.organizationId,
            customerTenantId: tenant.id,
            contentType,
            microsoftContentId: microsoftContentId.slice(0, 500),
            contentUri,
            contentCreatedAt: validDate(item.contentCreated),
            contentExpiresAt: validDate(item.contentExpiration),
            ledgerExpiresAt,
          })
        }
        for (let offset = 0; offset < discovered.length; offset += 500) {
          await this.prisma.m365ActivityContent.createMany({
            data: discovered.slice(offset, offset + 500) as never,
            skipDuplicates: true,
          })
        }
        const continuation = response.headers.get('NextPageUri')
        if (continuation) validateManagementUrl(continuation, tenant.microsoftTenantId)
        if (continuation) {
          state = await this.prisma.m365ActivitySubscription.update({
            where: {
              customerTenantId_contentType: { customerTenantId: tenant.id, contentType },
            },
            data: {
              lastContentPollAt: new Date(),
              discoveryWindowStart: windowStart,
              discoveryWindowEnd: windowEnd,
              discoveryNextPageUri: continuation,
              lastError: null,
            },
          })
          continue
        }

        state = await this.prisma.m365ActivitySubscription.update({
          where: {
            customerTenantId_contentType: { customerTenantId: tenant.id, contentType },
          },
          data: {
            lastContentPollAt: new Date(),
            lastSuccessfulPollAt: windowEnd,
            discoveryWindowStart: null,
            discoveryWindowEnd: null,
            discoveryNextPageUri: null,
            lastError: null,
          },
        })
        contiguousStart = windowEnd
        if (windowEnd >= now) break
      }
      if (
        Date.now() >= deadline ||
        (state?.lastSuccessfulPollAt && state.lastSuccessfulPollAt < now)
      ) hasBacklog = true
    }
    return hasBacklog
  }

  private async existingDirectoryDuplicates(tenant: TenantTarget, records: JsonObject[]) {
    const ids = records.map((record) => text(record.Id)).filter((value): value is string => Boolean(value))
    const correlations = records
      .map((record) => text(record.CorrelationId) ?? text(record.ClientRequestId))
      .filter((value): value is string => Boolean(value))
    if (!ids.length && !correlations.length) return new Set<string>()
    const times = records.map((record) => validDate(record.CreationTime)).filter((value): value is Date => Boolean(value))
    const lower = times.length ? new Date(Math.min(...times.map((date) => date.getTime())) - 15 * 60 * 1000) : undefined
    const upper = times.length ? new Date(Math.max(...times.map((date) => date.getTime())) + 15 * 60 * 1000) : undefined
    const directory: Array<{
      microsoftAuditId: string
      correlationId: string | null
      activityDisplayName: string
      eventDateTime: Date
    }> = []
    const queryBatchSize = 500
    for (let offset = 0; offset < Math.max(ids.length, correlations.length); offset += queryBatchSize) {
      const idBatch = ids.slice(offset, offset + queryBatchSize)
      const correlationBatch = correlations.slice(offset, offset + queryBatchSize)
      directory.push(...(await this.prisma.directoryAuditLog.findMany({
        where: {
          organizationId: tenant.organizationId,
          customerTenantId: tenant.id,
          ...(lower && upper ? { eventDateTime: { gte: lower, lte: upper } } : {}),
          OR: [
            ...(idBatch.length ? [{ microsoftAuditId: { in: idBatch } }] : []),
            ...(correlationBatch.length ? [{ correlationId: { in: correlationBatch } }] : []),
          ],
        },
        select: {
          microsoftAuditId: true,
          correlationId: true,
          activityDisplayName: true,
          eventDateTime: true,
        },
      })))
    }
    const duplicates = new Set<string>()
    for (const record of records) {
      const id = text(record.Id)
      if (!id) continue
      const correlation = text(record.CorrelationId) ?? text(record.ClientRequestId)
      const eventTime = validDate(record.CreationTime)
      if (
        directory.some(
          (entry) =>
            entry.microsoftAuditId === id ||
            (correlation &&
              entry.correlationId === correlation &&
              eventTime &&
              Math.abs(entry.eventDateTime.getTime() - eventTime.getTime()) <= 15 * 60 * 1000 &&
              sameAction(text(record.Operation) ?? '', entry.activityDisplayName))
        )
      ) duplicates.add(id)
    }
    return duplicates
  }

  private async reserveDailyUsage(
    tenant: TenantTarget,
    usage: { bytes?: number; records?: number; blobs?: number },
    now = new Date()
  ) {
    await this.prisma.$transaction((transaction) =>
      this.reserveUsageInTransaction(transaction, tenant, usage, now)
    )
  }

  private async reserveUsageInTransaction(
    transaction: Prisma.TransactionClient,
    tenant: TenantTarget,
    usage: { bytes?: number; records?: number; blobs?: number },
    now: Date
  ) {
    const usageDate = m365AuditUsageDate(now)
    const bytes = BigInt(Math.max(0, Math.ceil(usage.bytes ?? 0)))
    const records = Math.max(0, Math.ceil(usage.records ?? 0))
    const blobs = Math.max(0, Math.ceil(usage.blobs ?? 0))
    const limits = m365AuditUsageLimits()
    const monthStart = new Date(Date.UTC(
      usageDate.getUTCFullYear(),
      usageDate.getUTCMonth(),
      1
    ))
    const monthEnd = nextUtcMonthDate(usageDate)
    // Every reservation takes the deployment/month lock first, then the
    // deployment/day lock. The shared month key serializes reservations made
    // on different UTC days so monthly aggregates cannot race at midnight.
    await transaction.$executeRawUnsafe(
      'SELECT pg_advisory_xact_lock(hashtext($1))',
      `hawkview:m365-monthly-budget:${monthStart.toISOString()}`
    )
    await transaction.$executeRawUnsafe(
      'SELECT pg_advisory_xact_lock(hashtext($1))',
      `hawkview:m365-daily-budget:${usageDate.toISOString()}`
    )
      const [tenantUsage, deploymentUsage, tenantMonthlyUsage, deploymentMonthlyUsage] = await Promise.all([
        transaction.m365AuditDailyUsage.findUnique({
          where: {
            customerTenantId_usageDate: {
              customerTenantId: tenant.id,
              usageDate,
            },
          },
        }),
        transaction.m365AuditDailyUsage.aggregate({
          where: { usageDate },
          _sum: { downloadedBytes: true, recordsStored: true },
        }),
        transaction.m365AuditDailyUsage.aggregate({
          where: {
            customerTenantId: tenant.id,
            usageDate: { gte: monthStart, lt: monthEnd },
          },
          _sum: { downloadedBytes: true, recordsStored: true },
        }),
        transaction.m365AuditDailyUsage.aggregate({
          where: { usageDate: { gte: monthStart, lt: monthEnd } },
          _sum: { downloadedBytes: true, recordsStored: true },
        }),
      ])
      const tenantBytes = tenantUsage?.downloadedBytes ?? 0n
      const tenantRecords = tenantUsage?.recordsStored ?? 0
      const deploymentBytes = deploymentUsage._sum.downloadedBytes ?? 0n
      const deploymentRecords = deploymentUsage._sum.recordsStored ?? 0
      const tenantMonthlyBytes = tenantMonthlyUsage._sum.downloadedBytes ?? 0n
      const tenantMonthlyRecords = tenantMonthlyUsage._sum.recordsStored ?? 0
      const deploymentMonthlyBytes = deploymentMonthlyUsage._sum.downloadedBytes ?? 0n
      const deploymentMonthlyRecords = deploymentMonthlyUsage._sum.recordsStored ?? 0
      const dailyExceeded =
        tenantBytes + bytes > limits.tenantBytes ||
        deploymentBytes + bytes > limits.deploymentBytes ||
        tenantRecords + records > limits.tenantRecords ||
        deploymentRecords + records > limits.deploymentRecords
      const monthlyExceeded =
        tenantMonthlyBytes + bytes > limits.tenantMonthlyBytes ||
        deploymentMonthlyBytes + bytes > limits.deploymentMonthlyBytes ||
        tenantMonthlyRecords + records > limits.tenantMonthlyRecords ||
        deploymentMonthlyRecords + records > limits.deploymentMonthlyRecords
      if (dailyExceeded || monthlyExceeded) {
        throw new M365AuditBudgetError(
          `Microsoft 365 audit ${monthlyExceeded ? 'monthly' : 'daily'} cost budget is exhausted; ingestion will resume after the next UTC ${monthlyExceeded ? 'month' : 'day'} boundary.`,
          monthlyExceeded ? nextUtcMonthDate(now) : nextUtcUsageDate(now)
        )
      }
    await transaction.m365AuditDailyUsage.upsert({
        where: {
          customerTenantId_usageDate: {
            customerTenantId: tenant.id,
            usageDate,
          },
        },
        create: {
          organizationId: tenant.organizationId,
          customerTenantId: tenant.id,
          usageDate,
          downloadedBytes: bytes,
          recordsStored: records,
          blobsProcessed: blobs,
        },
        update: {
          downloadedBytes: { increment: bytes },
          recordsStored: { increment: records },
          blobsProcessed: { increment: blobs },
        },
    })
  }

  private async releaseUnusedDownloadReservation(
    tenant: TenantTarget,
    bytes: number,
    now = new Date()
  ) {
    if (bytes <= 0) return
    await this.prisma.m365AuditDailyUsage.updateMany({
      where: {
        organizationId: tenant.organizationId,
        customerTenantId: tenant.id,
        usageDate: m365AuditUsageDate(now),
        downloadedBytes: { gte: BigInt(Math.ceil(bytes)) },
      },
      data: { downloadedBytes: { decrement: BigInt(Math.ceil(bytes)) } },
    })
  }

  private async processContent(
    tenant: TenantTarget,
    token: string,
    publisherIdentifier: string,
    downloadBudget: { remainingBytes: number },
    content: any
  ) {
    const claimed = await this.prisma.m365ActivityContent.updateMany({
      where: {
        id: content.id,
        organizationId: tenant.organizationId,
        customerTenantId: tenant.id,
        status: { in: ['PENDING', 'RETRY'] },
      },
      data: { status: 'PROCESSING', attemptCount: { increment: 1 }, lastError: null },
    })
    if (claimed.count !== 1) return [] as ManagementActivityChange[]

    try {
      const response = await this.request(
        content.contentUri,
        { headers: this.headers(token) },
        tenant.microsoftTenantId,
        publisherIdentifier
      )
      // Reserve the maximum possible body before reading it. Content-Length
      // is not trusted for enforcement because a lying or missing header could
      // otherwise bypass the daily/deployment byte ceiling.
      const reservedBytes = Math.min(
        MAX_CONTENT_RESPONSE_BYTES,
        downloadBudget.remainingBytes
      )
      const usageNow = new Date()
      await this.reserveDailyUsage(tenant, { bytes: reservedBytes }, usageNow)
      const remainingBeforeRead = downloadBudget.remainingBytes
      let payload: unknown
      try {
        payload = await readBoundedJson(
          response,
          MAX_CONTENT_RESPONSE_BYTES,
          downloadBudget
        )
      } catch (error) {
        // Keep the conservative reservation when a stream is interrupted: the
        // network transfer still consumed Render bandwidth.
        throw error
      }
      const consumedBytes = remainingBeforeRead - downloadBudget.remainingBytes
      await this.releaseUnusedDownloadReservation(
        tenant,
        Math.max(0, reservedBytes - consumedBytes),
        usageNow
      )
      if (!Array.isArray(payload)) throw new Error('Microsoft 365 activity content returned an invalid payload.')
      if (payload.length > MAX_RECORDS_PER_BLOB) throw new Error('Microsoft 365 activity content exceeded its record limit.')

      const allRecords = payload.map(object)
      for (const record of allRecords) {
        const organizationId = text(record.OrganizationId)
        if (!organizationId || organizationId.toLowerCase() !== tenant.microsoftTenantId.toLowerCase()) {
          throw new Error('Microsoft 365 activity content did not prove an exact connected-tenant match.')
        }
      }
      const retainedById = new Map<string, { record: JsonObject; role: ManagementActivityRole }>()
      const supportingGroups = new Map<string, JsonObject[]>()
      for (const record of allRecords) {
        const role = classifyManagementActivity(record)
        if (role === 'routine_activity') continue
        const id = text(record.Id)
        if (!id) continue
        if (role === 'primary_change') {
          if (!retainedById.has(id)) retainedById.set(id, { record, role })
          continue
        }
        const eventTime = validDate(record.CreationTime)
        if (!eventTime) continue
        // Supporting mailbox activity can be very high volume. Preserve a
        // deterministic 15-minute actor/mailbox/operation summary per source
        // blob instead of duplicating every message event in PostgreSQL.
        const bucket = Math.floor(eventTime.getTime() / (15 * 60 * 1000))
        const groupingKey = [
          text(record.Workload) ?? '',
          text(record.Operation) ?? '',
          text(record.UserId) ?? text(record.UserKey) ?? '',
          text(record.MailboxOwnerUPN) ?? text(record.TargetUserOrGroupName) ?? '',
          text(record.CorrelationId) ?? text(record.ClientRequestId) ?? '',
          String(bucket),
        ].join('\u0000').toLowerCase()
        const group = supportingGroups.get(groupingKey) ?? []
        if (!group.some((candidate) => text(candidate.Id) === id)) group.push(record)
        supportingGroups.set(groupingKey, group)
      }
      for (const [groupingKey, records] of supportingGroups) {
        records.sort((left, right) => validDate(left.CreationTime)!.getTime() - validDate(right.CreationTime)!.getTime())
        const first = records[0]!
        const last = records.at(-1)!
        const digest = createHash('sha256')
          .update(`${content.microsoftContentId}\u0000${groupingKey}`)
          .digest('hex')
          .slice(0, 40)
        const summaryId = `support:${content.microsoftContentId}:${digest}`
        retainedById.set(summaryId, {
          role: 'security_supporting_activity',
          record: {
            ...first,
            Id: summaryId,
            ObjectId: text(first.MailboxOwnerUPN) ?? text(first.TargetUserOrGroupName) ?? text(first.ObjectId),
            hawkviewSupportingActivityCount: records.length,
            hawkviewSupportingFirstSeenAt: text(first.CreationTime),
            hawkviewSupportingLastSeenAt: text(last.CreationTime),
            hawkviewSupportingSampleRecordIds: records.slice(0, 10).map((record) => text(record.Id)).filter(Boolean),
          },
        })
      }
      const retained = [...retainedById.values()]
      const ids = retained.map(({ record }) => text(record.Id)).filter((value): value is string => Boolean(value))
      const storedIds = ids.map(boundedSourceEventId)
      const existing = new Set<string>()
      for (let offset = 0; offset < storedIds.length; offset += 500) {
        const stored = await this.prisma.m365AuditRecord.findMany({
          where: {
            organizationId: tenant.organizationId,
            customerTenantId: tenant.id,
            microsoftRecordId: { in: storedIds.slice(offset, offset + 500) },
          },
          select: { microsoftRecordId: true },
        })
        for (const entry of stored) existing.add(entry.microsoftRecordId)
      }
      const newRecords = retained.filter(({ record }) => {
        const id = text(record.Id)
        return Boolean(id && validDate(record.CreationTime) && text(record.Operation) && !existing.has(boundedSourceEventId(id)))
      })
      const primaryRecords = newRecords
        .filter(({ role }) => role === 'primary_change')
        .map(({ record }) => record)
      const directoryDuplicates = content.contentType === 'Audit.AzureActiveDirectory'
        ? await this.existingDirectoryDuplicates(tenant, primaryRecords)
        : new Set<string>()
      const ingestedAt = new Date()
      const expiresAt = evidenceExpiration(ingestedAt)
      const rawRows = newRecords.map(({ record, role }) => ({
        organizationId: tenant.organizationId,
        customerTenantId: tenant.id,
        contentType: content.contentType,
        microsoftRecordId: boundedSourceEventId(text(record.Id)!),
        eventDateTime: validDate(record.CreationTime)!,
        workload: boundedText(record.Workload, 100),
        operation: text(record.Operation)!.slice(0, 500),
        actorId: boundedText(record.UserId, 320) ?? boundedText(record.UserKey, 320),
        actorType: boundedText(record.UserType, 80),
        objectId: text(record.ObjectId),
        result: boundedText(record.ResultStatus, 100),
        clientIp: boundedText(record.ClientIP, 128) ?? boundedText(record.ActorIpAddress, 128),
        correlationId: boundedText(record.CorrelationId, 200) ?? boundedText(record.ClientRequestId, 200),
        raw: {
          ...compactManagementEvidence(record),
          hawkviewEvidenceRole: role,
        },
        ingestedAt,
        expiresAt,
      }))
      const evidenceRows = primaryRecords
        .filter((record) => !directoryDuplicates.has(text(record.Id)!))
        .map((record) => {
          const operation = text(record.Operation)!
          const workload = text(record.Workload)
          const state = changedState(record)
          const sourceEventId = text(record.Id)!
          return {
            organizationId: tenant.organizationId,
            customerTenantId: tenant.id,
            source: 'M365_UNIFIED_AUDIT',
            sourceEventId: boundedSourceEventId(sourceEventId),
            eventDateTime: validDate(record.CreationTime)!,
            workload,
            category: categoryFor(operation, workload),
            severity: severityFor(operation, workload),
            operationName: operation.slice(0, 500),
            summary: `${workload ?? 'Microsoft 365'} reported ${operation}${text(record.ResultStatus) ? ` · ${text(record.ResultStatus)}` : ''}.`,
            actorId: boundedText(record.UserKey, 128),
            actorDisplayName: null,
            actorPrincipalName: boundedText(record.UserId, 320),
            targetId: text(record.ObjectId)?.slice(0, 128) ?? null,
            targetDisplayName: text(record.ObjectId)?.slice(0, 500) ?? null,
            targetType: workload?.slice(0, 100) ?? null,
            correlationId: (text(record.CorrelationId) ?? text(record.ClientRequestId))?.slice(0, 128) ?? null,
            result: boundedText(record.ResultStatus, 50),
            ipAddress: (text(record.ClientIP) ?? text(record.ActorIpAddress))?.slice(0, 64) ?? null,
            location: null,
            beforeState: state.before,
            afterState: state.after,
            changedFields: state.fields,
            raw: {
              ...compactManagementEvidence(record),
              hawkviewEvidenceRole: 'primary_change',
              evidenceOrigin: 'microsoft_audit_event',
              microsoftSource: `Office 365 Management Activity API / ${content.contentType}`,
            },
            ingestedAt,
            expiresAt,
          }
        })

      await this.prisma.$transaction(async (transaction) => {
        let insertedRecordCount = 0
        for (let offset = 0; offset < rawRows.length; offset += 500) {
          const inserted = await transaction.m365AuditRecord.createMany({
            data: rawRows.slice(offset, offset + 500) as never,
            skipDuplicates: true,
          })
          insertedRecordCount += inserted.count
        }
        // Charge only records the database actually accepted. This remains in
        // the same transaction, so cross-blob duplicates count zero and any
        // quota/evidence failure rolls both storage and accounting back.
        await this.reserveUsageInTransaction(
          transaction,
          tenant,
          { records: insertedRecordCount, blobs: 1 },
          ingestedAt
        )
        for (let offset = 0; offset < evidenceRows.length; offset += 500) {
          await transaction.changeEvidenceEvent.createMany({
            data: evidenceRows.slice(offset, offset + 500) as never,
            skipDuplicates: true,
          })
        }
        await transaction.m365ActivityContent.update({
          where: { id: content.id },
          data: { status: 'COMPLETED', processedAt: ingestedAt, nextRetryAt: null, lastError: null },
        })
      })

      return primaryRecords.map((record) => ({
        activityDisplayName: text(record.Operation)!,
        category: text(record.RecordType),
        loggedByService: text(record.Workload),
        targetResources: [{ id: text(record.ObjectId), type: text(record.Workload) }],
      }))
    } catch (error) {
      const attempts = Number(content.attemptCount ?? 0) + 1
      const permanent = error instanceof ManagementActivityHttpError && [400, 401, 403, 404].includes(error.status)
      const budgetLimited = error instanceof M365AuditBudgetError
      await this.prisma.m365ActivityContent.updateMany({
        where: {
          id: content.id,
          organizationId: tenant.organizationId,
          customerTenantId: tenant.id,
        },
        data: {
          status: permanent ? 'FAILED' : 'RETRY',
          nextRetryAt: permanent
            ? null
            : budgetLimited
              ? error.retryAt
              : new Date(Date.now() + retryDelayMs(Math.min(attempts, 8), null)),
          lastError: safeMessage(error),
          ...(permanent
            ? { ledgerExpiresAt: evidenceExpiration(new Date()) }
            : {}),
        },
      })
      if (error instanceof ManagementActivityHttpError && [401, 403].includes(error.status)) throw error
      if (permanent) {
        this.logger.error(JSON.stringify({ event: 'm365_activity_content', phase: 'INGESTION', outcome: 'FAILED', reasonCode: 'CONTENT_UNAVAILABLE' }))
        return []
      }
      this.logger.warn(JSON.stringify({ event: 'm365_activity_content', phase: 'INGESTION', outcome: 'RETRY_PENDING', reasonCode: 'CONTENT_UNAVAILABLE' }))
      return []
    }
  }

  async syncTenant(tenant: TenantTarget) {
    if (!tenant.connection) throw new Error('The Microsoft tenant connection is incomplete.')
    const now = new Date()
    const pollMinutes = boundedInt(process.env.M365_AUDIT_POLL_INTERVAL_MINUTES, 15, 60)
    const maxBlobs = boundedInt(process.env.M365_AUDIT_MAX_BLOBS_PER_RUN, 12, 100)
    const maxDownloadMegabytes = boundedInt(
      process.env.M365_AUDIT_MAX_DOWNLOAD_MB_PER_RUN,
      12,
      256
    )
    const runtimeSeconds = boundedInt(
      process.env.M365_AUDIT_MAX_RUNTIME_SECONDS,
      45,
      180
    )
    const processingDeadline = Date.now() + runtimeSeconds * 1_000
    const state = await this.prisma.syncState.findUnique({
      where: {
        customerTenantId_resourceType: { customerTenantId: tenant.id, resourceType: 'M365_AUDIT' },
      },
    })
    const workDue = await this.prisma.m365ActivityContent.count({
      where: {
        organizationId: tenant.organizationId,
        customerTenantId: tenant.id,
        OR: [
          { status: 'PENDING' },
          { status: 'RETRY', OR: [{ nextRetryAt: null }, { nextRetryAt: { lte: now } }] },
        ],
      },
    })
    if (
      workDue === 0 &&
      state?.lastSuccessfulAt &&
      now.getTime() - state.lastSuccessfulAt.getTime() < pollMinutes * 60_000
    ) return [] as ManagementActivityChange[]

    await this.prisma.syncState.upsert({
      where: {
        customerTenantId_resourceType: { customerTenantId: tenant.id, resourceType: 'M365_AUDIT' },
      },
      create: {
        organizationId: tenant.organizationId,
        customerTenantId: tenant.id,
        resourceType: 'M365_AUDIT',
        status: 'RUNNING',
        lastAttemptAt: now,
      },
      update: { status: 'RUNNING', lastAttemptAt: now, lastErrorCode: null, lastErrorMessage: null },
    })

    try {
      const { accessToken: token, publisherIdentifier } =
        await this.microsoftConsent.getTenantManagementActivityContext({
        microsoftTenantId: tenant.microsoftTenantId,
        connectionMode: tenant.connection.connectionMode === 'CUSTOMER_MANAGED' ? 'CUSTOMER_MANAGED' : 'HAWKVIEW_MANAGED',
        clientId: tenant.connection.clientId,
        credentialReference: tenant.connection.credentialReference,
        })
      await this.prisma.m365ActivityContent.updateMany({
        where: {
          organizationId: tenant.organizationId,
          customerTenantId: tenant.id,
          status: 'PROCESSING',
          updatedAt: { lt: new Date(now.getTime() - PROCESSING_LEASE_MS) },
        },
        data: { status: 'RETRY', nextRetryAt: now, lastError: 'Recovered an interrupted processing lease.' },
      })
      const enabledContentTypes = await this.ensureSubscriptions(
        tenant,
        token,
        publisherIdentifier,
        now
      )
      const subscriptionStates = await this.prisma.m365ActivitySubscription.findMany({
        where: {
          organizationId: tenant.organizationId,
          customerTenantId: tenant.id,
        },
        select: { contentType: true, status: true, lastError: true },
      })
      const failedSubscriptions = subscriptionStates.filter(
        (subscription) => subscription.status === 'FAILED'
      )
      const downloadBudget = {
        remainingBytes: maxDownloadMegabytes * 1024 * 1024,
      }
      const discoveryBacklog = await this.discoverContent(
        tenant,
        token,
        publisherIdentifier,
        enabledContentTypes,
        now,
        processingDeadline,
        downloadBudget
      )
      const pending = await this.prisma.m365ActivityContent.findMany({
        where: {
          organizationId: tenant.organizationId,
          customerTenantId: tenant.id,
          OR: [
            { status: 'PENDING' },
            { status: 'RETRY', OR: [{ nextRetryAt: null }, { nextRetryAt: { lte: now } }] },
          ],
        },
        orderBy: [{ contentCreatedAt: 'asc' }, { discoveredAt: 'asc' }],
        take: maxBlobs,
      })
      const changes: ManagementActivityChange[] = []
      // Sequential processing is deliberate on Render's 0.15 CPU / 512 MB
      // free web instance. Blob count is bounded and only unseen blobs run.
      for (const content of pending) {
        if (
          downloadBudget.remainingBytes < 256 * 1024 ||
          Date.now() >= processingDeadline
        ) break
        changes.push(...(await this.processContent(
          tenant,
          token,
          publisherIdentifier,
          downloadBudget,
          content
        )))
      }
      const [pendingBacklog, processingBacklog, retryBacklog, failedBacklog] = await Promise.all([
        this.prisma.m365ActivityContent.count({
          where: {
            organizationId: tenant.organizationId,
            customerTenantId: tenant.id,
            status: 'PENDING',
          },
        }),
        this.prisma.m365ActivityContent.count({
          where: {
            organizationId: tenant.organizationId,
            customerTenantId: tenant.id,
            status: 'PROCESSING',
          },
        }),
        this.prisma.m365ActivityContent.count({
          where: {
            organizationId: tenant.organizationId,
            customerTenantId: tenant.id,
            status: 'RETRY',
          },
        }),
        this.prisma.m365ActivityContent.count({
          where: {
            organizationId: tenant.organizationId,
            customerTenantId: tenant.id,
            status: 'FAILED',
          },
        }),
      ])
      const subscriptionBacklog =
        M365_ACTIVITY_CONTENT_TYPES.length - enabledContentTypes.size
      const blocked =
        pendingBacklog +
        processingBacklog +
        retryBacklog +
        failedBacklog +
        subscriptionBacklog +
        (discoveryBacklog ? 1 : 0)
      await this.prisma.$transaction([
        this.prisma.m365AuditRecord.deleteMany({ where: { organizationId: tenant.organizationId, customerTenantId: tenant.id, expiresAt: { lte: now } } }),
        this.prisma.m365ActivityContent.deleteMany({ where: { organizationId: tenant.organizationId, customerTenantId: tenant.id, ledgerExpiresAt: { lte: now } } }),
        this.prisma.m365AuditDailyUsage.deleteMany({
          where: {
            organizationId: tenant.organizationId,
            customerTenantId: tenant.id,
            usageDate: { lt: new Date(m365AuditUsageDate(now).getTime() - 35 * 24 * 60 * 60 * 1000) },
          },
        }),
        this.prisma.syncState.update({
          where: {
            customerTenantId_resourceType: { customerTenantId: tenant.id, resourceType: 'M365_AUDIT' },
          },
          data: failedBacklog > 0 || failedSubscriptions.length > 0
            ? {
                status: 'FAILED',
                lastErrorCode: failedSubscriptions.length > 0
                  ? 'm365-audit-subscription-incomplete'
                  : 'm365-audit-content-unavailable',
                lastErrorMessage: failedSubscriptions.length > 0
                  ? `${failedSubscriptions.length} Microsoft audit subscription(s) failed: ${failedSubscriptions.map((subscription) => `${subscription.contentType}: ${subscription.lastError ?? 'activation failed'}`).join('; ')}. Enabled=${enabledContentTypes.size}/${M365_ACTIVITY_CONTENT_TYPES.length}; content pending=${pendingBacklog}, processing=${processingBacklog}, retry=${retryBacklog}, permanently unavailable=${failedBacklog}.`.slice(0, 1_000)
                  : `${failedBacklog} Microsoft audit content blob(s) are permanently unavailable; pending=${pendingBacklog}, processing=${processingBacklog}, retry=${retryBacklog}.`,
                consecutiveFailures: { increment: 1 },
              }
            : blocked > 0
              ? {
                // A bounded backlog is expected recovery work, not a failed
                // Microsoft request. RUNNING keeps service freshness honest
                // without turning cost backpressure into a permanent failure.
                status: 'RUNNING',
                lastErrorCode: 'm365-audit-backlog',
                lastErrorMessage: `${subscriptionBacklog} subscription(s) await activation; discovery backlog=${discoveryBacklog}; content pending=${pendingBacklog}, processing=${processingBacklog}, retry=${retryBacklog}, permanently unavailable=${failedBacklog}.`,
                consecutiveFailures: 0,
              }
              : {
                status: 'SUCCEEDED',
                lastSuccessfulAt: new Date(),
                lastErrorCode: null,
                lastErrorMessage: null,
                consecutiveFailures: 0,
              },
        }),
      ])
      return changes
    } catch (error) {
      if (error instanceof M365AuditBudgetError) {
        await this.prisma.syncState.update({
          where: {
            customerTenantId_resourceType: { customerTenantId: tenant.id, resourceType: 'M365_AUDIT' },
          },
          data: {
            status: 'RUNNING',
            lastErrorCode: 'm365-audit-budget-exhausted',
            lastErrorMessage: safeMessage(error),
            consecutiveFailures: 0,
          },
        })
        return [] as ManagementActivityChange[]
      }
      const code = error instanceof ManagementActivityHttpError
        ? error.status === 401 || error.status === 403
          ? 'm365-audit-permission-denied'
          : `m365-audit-http-${error.status}`
        : /does not exist|audit.*not.*enabled|unified audit/i.test(safeMessage(error))
          ? 'm365-audit-disabled'
          : 'm365-audit-sync-failed'
      await this.prisma.syncState.update({
        where: {
          customerTenantId_resourceType: { customerTenantId: tenant.id, resourceType: 'M365_AUDIT' },
        },
        data: {
          status: 'FAILED',
          lastErrorCode: code,
          lastErrorMessage: safeMessage(error),
          consecutiveFailures: { increment: 1 },
        },
      })
      throw error
    }
  }
}
