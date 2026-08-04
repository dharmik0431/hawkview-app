import type { SignInEvent, AuditEvent } from '../data/types'

function fmtUTC(iso?: string) {
  if (!iso) return ''
  const date = new Date(iso)
  if (!Number.isFinite(date.getTime())) return iso
  return date.toISOString().replace('T', ' ').replace('Z', ' UTC').slice(0, 23)
}

function sanitizeCsvValue(val: any): string {
  if (val === undefined || val === null) return ''
  let str = String(val)
  // Protect against CSV formula injection (=, +, -, @)
  if (/^[=+\-@]/.test(str)) {
    str = "'" + str
  }
  // Double-quote escaping for values with commas, quotes, or newlines
  if (
    str.includes('"') ||
    str.includes(',') ||
    str.includes('\n') ||
    str.includes('\r')
  ) {
    str = '"' + str.replace(/"/g, '""') + '"'
  }
  return str
}

export function exportSignInsToCsv(
  events: SignInEvent[],
  tenantName?: string
): boolean {
  try {
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
      'Event ID',
    ]

    const rows = events.map((r) => [
      fmtUTC(r.createdAt),
      r.tenantName || tenantName || '',
      r.userDisplayName || '',
      r.userPrincipalName || '',
      r.appDisplayName || '',
      r.clientAppUsed || '',
      r.status || '',
      r.failureReason || '',
      r.conditionalAccess || '',
      r.ipAddress || '',
      r.location || '',
      r.os || '',
      r.browser || '',
      r.device || '',
      r.correlationId || '',
      r.id || '',
    ])

    const dateStr = new Date().toISOString().slice(0, 10)
    const sanitizedTenant = tenantName
      ? tenantName
          .replace(/[^a-zA-Z0-9]/g, '-')
          .replace(/-+/g, '-')
          .replace(/^-|-$/g, '')
      : ''

    const filename = sanitizedTenant
      ? `hawkview-${sanitizedTenant}-sign-in-logs-${dateStr}.csv`
      : `hawkview-sign-in-logs-${dateStr}.csv`

    downloadCsvFile(filename, headers, rows)
    return true
  } catch (err) {
    console.error('Failed to export sign-ins CSV', err)
    return false
  }
}

export function exportAuditLogsToCsv(
  events: AuditEvent[],
  tenantName?: string
): boolean {
  try {
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
      'Event ID',
    ]

    const rows = events.map((r) => {
      let modifiedPropsStr = ''
      if (
        Array.isArray(r.modifiedProperties) &&
        r.modifiedProperties.length > 0
      ) {
        modifiedPropsStr = r.modifiedProperties
          .map((p) => {
            const name = p.name || 'Property'
            const oldV =
              p.oldValue !== undefined && p.oldValue !== ''
                ? p.oldValue
                : 'none'
            const newV =
              p.newValue !== undefined && p.newValue !== ''
                ? p.newValue
                : 'none'
            return `${name}: ${oldV} -> ${newV}`
          })
          .join('; ')
      }

      return [
        fmtUTC(r.createdAt),
        r.tenantName || tenantName || '',
        r.activity || '',
        r.category || '',
        r.service || '',
        r.result || '',
        r.resultReason || '',
        r.actor || '',
        r.actorPrincipalName || '',
        r.actorType || '',
        r.target || '',
        r.targetType || '',
        r.targetId || '',
        modifiedPropsStr,
        r.correlationId || '',
        r.id || '',
      ]
    })

    const dateStr = new Date().toISOString().slice(0, 10)
    const sanitizedTenant = tenantName
      ? tenantName
          .replace(/[^a-zA-Z0-9]/g, '-')
          .replace(/-+/g, '-')
          .replace(/^-|-$/g, '')
      : ''

    const filename = sanitizedTenant
      ? `hawkview-${sanitizedTenant}-audit-logs-${dateStr}.csv`
      : `hawkview-audit-logs-${dateStr}.csv`

    downloadCsvFile(filename, headers, rows)
    return true
  } catch (err) {
    console.error('Failed to export audit logs CSV', err)
    return false
  }
}

function downloadCsvFile(
  filename: string,
  headers: string[],
  rows: (string | number | undefined | null)[][]
) {
  const bom = '\uFEFF'
  const headerRow = headers.map(sanitizeCsvValue).join(',')
  const dataRows = rows
    .map((row) => row.map(sanitizeCsvValue).join(','))
    .join('\r\n')
  const csvContent = bom + headerRow + '\r\n' + dataRows

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
