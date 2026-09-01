const MAX_INPUT_LENGTH = 8_192
const MAX_OUTPUT_LENGTH = 500
const SECRET_KEY = /^(?:access[_-]?token|refresh[_-]?token|id[_-]?token|client[_-]?secret|api[_-]?key|token|secret|password|authorization[_-]?code)$/i

export type AuditSyncResourceHealth = {
  resourceType?: unknown
  classification?: unknown
  reasonCode?: unknown
  message?: unknown
  lastAttemptAt?: unknown
  lastSuccessfulAt?: unknown
}

export function isM365AuditSyncDeepLink(section: string | null, resource: string | null) {
  return section === 'sync' && resource === 'M365_AUDIT'
}

export function auditSyncFocusTarget(section: string | null, resource: string | null) {
  return isM365AuditSyncDeepLink(section, resource) ? 'sync-health' : null
}

/** Defense in depth for health text received over the API. */
export function sanitizeSyncFailure(value: unknown) {
  const raw = readableFailure(value)
  if (!raw.trim()) return 'No current failure reason was provided.'
  if (raw.length > MAX_INPUT_LENGTH) return safeFailure('OVERSIZED ERROR', raw)

  const decoded = boundedDecode(raw)
  if (decoded === null) return safeFailure('ENCODED ERROR', raw)
  const structured = parseStructuredError(decoded)
  if (structured !== null) return limit(JSON.stringify(structured))

  return limit(redactFreeText(redactEmbeddedStructuredJson(stripUrls(decoded))))
}

function readableFailure(value: unknown) {
  if (typeof value === 'string') return value
  if (!value || typeof value !== 'object' || Array.isArray(value)) return ''
  return formatProjectedDiagnostic(projectStructuredDiagnostic(value))
}

function boundedDecode(value: string) {
  let decoded = value
  for (let depth = 0; depth < 2; depth += 1) {
    if (!decoded.includes('%')) return decoded
    try {
      const next = decodeURIComponent(decoded)
      if (next.length > MAX_INPUT_LENGTH || next === decoded) return next.length > MAX_INPUT_LENGTH ? null : decoded
      decoded = next
    } catch {
      return null
    }
  }
  return decoded
}

function parseStructuredError(value: string): Record<string, string> | null {
  const candidate = value.trim()
  if (!((candidate.startsWith('{') && candidate.endsWith('}')) || (candidate.startsWith('[') && candidate.endsWith(']')))) return null
  try {
    return projectStructuredDiagnostic(JSON.parse(candidate)) ?? { diagnostic: '[REDACTED STRUCTURED ERROR]' }
  } catch {
    return null
  }
}

function projectStructuredDiagnostic(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  const nestedError = objectField(record, 'error')
  const projection: Record<string, string> = {}
  const status = firstPrimitive(record, ['status', 'statusCode', 'httpStatus'])
  const code = firstPrimitive(nestedError ?? record, ['code', 'errorCode'])
  const message = firstPrimitive(nestedError ?? record, ['message', 'error_description']) ?? firstPrimitive(record, ['message', 'error_description'])
  const correlationId = firstPrimitive(record, ['correlationId', 'correlation_id', 'requestId', 'clientRequestId']) ?? firstPrimitive(nestedError ?? {}, ['correlationId', 'requestId', 'clientRequestId'])
  const tenantId = firstPrimitive(record, ['tenantId', 'tenant_id', 'organizationId', 'organization_id'])
  const url = firstPrimitive(record, ['url', 'requestUrl', 'uri'])
  if (status !== null) projection.status = safeDiagnostic(status)
  if (code !== null) projection.code = safeDiagnostic(code)
  if (message !== null) projection.message = safeDiagnostic(message)
  if (correlationId !== null) projection.correlationId = safeDiagnostic(correlationId)
  if (tenantId !== null) projection.tenantId = safeDiagnostic(tenantId)
  if (url !== null) projection.url = safeDiagnostic(url)
  return Object.keys(projection).length ? projection : null
}

function objectField(record: Record<string, unknown>, expected: string) {
  const entry = Object.entries(record).find(([key]) => canonicalKey(key) === canonicalKey(expected))?.[1]
  return entry && typeof entry === 'object' && !Array.isArray(entry) ? entry as Record<string, unknown> : null
}

function firstPrimitive(record: Record<string, unknown>, names: string[]) {
  for (const [key, value] of Object.entries(record)) {
    if (names.some((name) => canonicalKey(name) === canonicalKey(key)) && !SECRET_KEY.test(key) && (typeof value === 'string' || typeof value === 'number')) return String(value)
  }
  return null
}

function canonicalKey(key: string) {
  return key.replace(/[_-]/g, '').toLowerCase()
}

function safeDiagnostic(value: string) {
  return limit(redactFreeText(stripUrls(value.slice(0, MAX_INPUT_LENGTH))))
}

function formatProjectedDiagnostic(projection: Record<string, string> | null) {
  if (!projection) return ''
  return [
    projection.status ? `HTTP ${projection.status}` : null,
    projection.code ? `Code ${projection.code}` : null,
    projection.message,
    projection.correlationId ? `Correlation ID ${projection.correlationId}` : null,
    projection.tenantId ? `Tenant ${projection.tenantId}` : null,
    projection.url,
  ].filter((value): value is string => Boolean(value)).join(': ')
}

function redactEmbeddedStructuredJson(value: string) {
  let output = ''
  let cursor = 0
  while (cursor < value.length) {
    const start = value.slice(cursor).search(/[\[{]/)
    if (start < 0) return output + value.slice(cursor)
    const absoluteStart = cursor + start
    output += value.slice(cursor, absoluteStart)
    const end = findJsonEnd(value, absoluteStart)
    if (end === null) {
      output += value[absoluteStart]
      cursor = absoluteStart + 1
      continue
    }
    const candidate = value.slice(absoluteStart, end + 1)
    try {
      output += JSON.stringify(projectStructuredDiagnostic(JSON.parse(candidate)) ?? { diagnostic: '[REDACTED STRUCTURED ERROR]' })
      cursor = end + 1
    } catch {
      output += value[absoluteStart]
      cursor = absoluteStart + 1
    }
  }
  return output
}

function findJsonEnd(value: string, start: number) {
  const stack: string[] = []
  let quoted = false
  let escaped = false
  for (let index = start; index < value.length; index += 1) {
    const character = value[index]
    if (quoted) {
      if (escaped) escaped = false
      else if (character === '\\') escaped = true
      else if (character === '"') quoted = false
      continue
    }
    if (character === '"') quoted = true
    else if (character === '{') stack.push('}')
    else if (character === '[') stack.push(']')
    else if (character === '}' || character === ']') {
      if (stack.pop() !== character) return null
      if (stack.length === 0) return index
    }
  }
  return null
}

function stripUrls(value: string) {
  return value.replace(/https?:\/\/[^\s"'<>]+/gi, (url) => {
    try {
      const parsed = new URL(url)
      return `${parsed.origin}${parsed.pathname}`
    } catch {
      return '[URL REDACTED]'
    }
  })
}

function redactFreeText(value: string) {
  const bearer = /(bearer\s+)([\s\S]*)$/i.exec(value)
  const credentialAssignment = /(?:access[_-]?token|refresh[_-]?token|id[_-]?token|client[_-]?secret|api[_-]?key|token|secret|password|authorization[_-]?code)["']?\s*[=:]\s*/i.exec(value)
  if (bearer && (!credentialAssignment || bearer.index <= credentialAssignment.index)) {
    return `${value.slice(0, bearer.index)}${bearer[1]}[REDACTED]`
  }
  if (credentialAssignment) {
    // An unstructured value has no reliable endpoint: redact its entire suffix.
    return `${value.slice(0, credentialAssignment.index)}${credentialAssignment[0]}[REDACTED]`
  }
  const codeAssignment = /\bcode\s*[=:]\s*/i.exec(value)
  if (codeAssignment && /(?:oauth|authorize|authorization|grant)/i.test(value)) {
    return `${value.slice(0, codeAssignment.index)}${codeAssignment[0]}[REDACTED]`
  }
  if (bearer) return `${value.slice(0, bearer.index)}${bearer[1]}[REDACTED]`

  return value.replace(/\beyJ[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\b/g, '[REDACTED_JWT]')
}

function safeFailure(kind: string, raw: string) {
  const status = /\bHTTP\s+\d{3}\b/i.exec(raw)?.[0]
  return `${status ? `${status}: ` : ''}[REDACTED ${kind}]`
}

function limit(value: string) {
  return value.slice(0, MAX_OUTPUT_LENGTH)
}

export function m365AuditSyncHealth(value: unknown) {
  const resources = Array.isArray(value) ? value as AuditSyncResourceHealth[] : []
  const resource = resources.find((candidate) => candidate?.resourceType === 'M365_AUDIT')
  if (!resource) return null
  return {
    classification: typeof resource.classification === 'string' ? resource.classification : 'UNKNOWN',
    reasonCode: typeof resource.reasonCode === 'string' ? resource.reasonCode : null,
    message: sanitizeSyncFailure(resource.message),
    lastAttemptAt: typeof resource.lastAttemptAt === 'string' ? resource.lastAttemptAt : null,
    lastSuccessfulAt: typeof resource.lastSuccessfulAt === 'string' ? resource.lastSuccessfulAt : null,
  }
}

const ACTIONABLE_AUDIT_SYNC_CLASSIFICATIONS = new Set([
  'FAILED',
  'PERMISSION_REQUIRED',
  'STALE',
  'BACKLOGGED',
  'FAILED_TRANSIENT',
  'BLOCKED_PERMISSION',
  'BLOCKED_TENANT_CONFIGURATION',
  'NEVER_SUCCEEDED',
])

/** Closed mapping: unfamiliar and successful states never become priority. */
export function auditSyncRequiresAction(value: { classification?: unknown } | null) {
  return typeof value?.classification === 'string' &&
    ACTIONABLE_AUDIT_SYNC_CLASSIFICATIONS.has(value.classification.toUpperCase())
}
