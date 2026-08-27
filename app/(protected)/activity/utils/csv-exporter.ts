import type { SignInEvent, AuditEvent } from '../data/types'
import { sanitizeActivityText } from '../data/normalize.ts'

function fmtUTC(iso?: string) {
  if (!iso) return 'Not reported'
  const date = new Date(iso)
  if (!Number.isFinite(date.getTime())) return 'Not reported'
  return date.toISOString().replace('T', ' ').replace('Z', ' UTC').slice(0, 23)
}

/** Protects spreadsheet consumers as well as bounding/redacting every cell. */
export function sanitizeCsvValue(value: unknown): string {
  const sanitized = sanitizeActivityText(value, 2_000) ?? ''
  const formulaSafe = /^[\s]*[=+\-@]/.test(sanitized)
    ? `'${sanitized}`
    : sanitized
  if (
    formulaSafe.includes('"') ||
    formulaSafe.includes(',') ||
    formulaSafe.includes('\n') ||
    formulaSafe.includes('\r')
  ) {
    return `"${formulaSafe.replace(/"/g, '""')}"`
  }
  return formulaSafe
}

function serializeCsv(
  headers: string[],
  rows: (string | number | undefined | null)[][],
) {
  const headerRow = headers.map(sanitizeCsvValue).join(',')
  const dataRows = rows
    .map((row) => row.map(sanitizeCsvValue).join(','))
    .join('\r\n')
  return `\uFEFF${headerRow}\r\n${dataRows}`
}

export function buildSignInsCsvContent(
  events: SignInEvent[],
  tenantName?: string,
) {
  const headers = [
    'Date UTC',
    'Tenant',
    'User display name',
    'Principal name',
    'Application',
    'Client application',
    'Status',
    'Failure reason',
    'Conditional Access',
    'IP address',
    'Location',
    'Operating system',
    'Browser',
    'Device ID',
    'Correlation ID',
    'Microsoft Event ID',
  ]
  const rows = events.map((event) => [
    fmtUTC(event.createdAt),
    event.tenantName || tenantName || 'Not reported',
    event.userDisplayName,
    event.userPrincipalName,
    event.appDisplayName,
    event.clientAppUsed || 'Not reported',
    event.status,
    event.failureReason || 'Not reported',
    event.conditionalAccess || 'Not reported',
    event.ipAddress || 'Not reported',
    event.location || 'Not reported',
    event.os || 'Not reported',
    event.browser || 'Not reported',
    event.device || 'Not reported',
    event.correlationId || 'Not reported',
    event.eventId || 'Not reported',
  ])
  return serializeCsv(headers, rows)
}

export function buildAuditLogsCsvContent(
  events: AuditEvent[],
  tenantName?: string,
) {
  const headers = [
    'Date UTC',
    'Tenant',
    'Activity',
    'Category',
    'Service',
    'Result',
    'Result reason',
    'Performed by',
    'Actor principal name',
    'Actor type',
    'Target',
    'Target type',
    'Target ID',
    'Modified properties',
    'Correlation ID',
    'Microsoft Event ID',
  ]
  const rows = events.map((event) => {
    const modifiedProperties = event.modifiedProperties?.length
      ? event.modifiedProperties
          .map((property) => {
            const oldValue = property.oldValue || 'Not reported'
            const newValue = property.newValue || 'Not reported'
            return `${property.name}: ${oldValue} -> ${newValue}`
          })
          .join('; ')
      : 'Not reported'

    return [
      fmtUTC(event.createdAt),
      event.tenantName || tenantName || 'Not reported',
      event.activity,
      event.category || 'Not reported',
      event.service || 'Not reported',
      event.result || 'Not reported',
      event.resultReason || 'Not reported',
      event.actor || 'Not reported',
      event.actorPrincipalName || 'Not reported',
      event.actorType || 'Not reported',
      event.target || 'Not reported',
      event.targetType || 'Not reported',
      event.targetId || 'Not reported',
      modifiedProperties,
      event.correlationId || 'Not reported',
      event.eventId || 'Not reported',
    ]
  })
  return serializeCsv(headers, rows)
}

export function exportSignInsToCsv(
  events: SignInEvent[],
  tenantName?: string,
): boolean {
  try {
    const date = new Date().toISOString().slice(0, 10)
    const tenant = filenameSegment(tenantName)
    const filename = tenant
      ? `hawkview-${tenant}-sign-in-logs-${date}.csv`
      : `hawkview-sign-in-logs-${date}.csv`
    downloadCsvFile(filename, buildSignInsCsvContent(events, tenantName))
    return true
  } catch (error) {
    console.error('Failed to export sign-ins CSV', error)
    return false
  }
}

export function exportAuditLogsToCsv(
  events: AuditEvent[],
  tenantName?: string,
): boolean {
  try {
    const date = new Date().toISOString().slice(0, 10)
    const tenant = filenameSegment(tenantName)
    const filename = tenant
      ? `hawkview-${tenant}-audit-logs-${date}.csv`
      : `hawkview-audit-logs-${date}.csv`
    downloadCsvFile(filename, buildAuditLogsCsvContent(events, tenantName))
    return true
  } catch (error) {
    console.error('Failed to export audit logs CSV', error)
    return false
  }
}

function filenameSegment(value?: string) {
  return value
    ? value
        .replace(/[^a-zA-Z0-9]/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-|-$/g, '')
        .slice(0, 100)
    : ''
}

function downloadCsvFile(filename: string, csvContent: string) {
  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.setAttribute('href', url)
  link.setAttribute('download', filename)
  link.style.visibility = 'hidden'
  document.body.appendChild(link)
  link.click()
  document.body.removeChild(link)
  URL.revokeObjectURL(url)
}
