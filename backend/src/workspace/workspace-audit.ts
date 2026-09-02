import { randomUUID } from 'node:crypto'
import { HttpException, HttpStatus } from '@nestjs/common'

export const WORKSPACE_AUDIT_EVENT_VERSION = 2
export const WORKSPACE_AUDIT_RETENTION_DAYS = 365

const SAFE_REQUEST_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const SAFE_VALUE = /^[A-Za-z0-9][A-Za-z0-9 ._:/+-]{0,99}$/
const SAFE_METADATA_KEYS = new Set([
  'changedFields',
  'delivery',
  'factorsRemoved',
  'idempotent',
  'priorRole',
  'priorStatus',
  'role',
  'status',
])
const SAFE_ERROR_CODES = new Set([
  'AUTH_EMAIL_RATE_LIMITED',
  'INVITATION_NOT_PENDING',
  'PASSWORD_RESET_REQUIRES_ACCEPTED_ACCOUNT',
])

export type WorkspaceAuditMetadata = Record<
  string,
  string | number | boolean | null | string[]
>

export type WorkspaceAuditOperation = {
  requestId: string
  operationId: string
}

export function createWorkspaceAuditOperation(
  requestId?: string
): WorkspaceAuditOperation {
  return {
    requestId:
      typeof requestId === 'string' && SAFE_REQUEST_ID.test(requestId)
        ? requestId
        : randomUUID(),
    operationId: randomUUID(),
  }
}

export function workspaceAuditExpiration(now = new Date()) {
  return new Date(
    now.getTime() + WORKSPACE_AUDIT_RETENTION_DAYS * 24 * 60 * 60 * 1000
  )
}

export function safeWorkspaceAuditMetadata(
  input?: WorkspaceAuditMetadata
): WorkspaceAuditMetadata | undefined {
  if (!input) return undefined
  const output: WorkspaceAuditMetadata = {}
  for (const [key, value] of Object.entries(input)) {
    if (!SAFE_METADATA_KEYS.has(key)) continue
    if (typeof value === 'string') {
      if (SAFE_VALUE.test(value)) output[key] = value
      continue
    }
    if (typeof value === 'number') {
      if (Number.isSafeInteger(value) && value >= 0 && value <= 100_000) {
        output[key] = value
      }
      continue
    }
    if (typeof value === 'boolean' || value === null) {
      output[key] = value
      continue
    }
    if (Array.isArray(value)) {
      const safe = value
        .filter(
          (entry): entry is string =>
            typeof entry === 'string' && SAFE_VALUE.test(entry)
        )
        .slice(0, 20)
      output[key] = safe
    }
  }
  return Object.keys(output).length ? output : undefined
}

export function workspaceAuditErrorCode(error: unknown): string {
  if (error instanceof HttpException) {
    const response = error.getResponse()
    if (response && typeof response === 'object' && !Array.isArray(response)) {
      const code = (response as { code?: unknown }).code
      if (typeof code === 'string' && SAFE_ERROR_CODES.has(code)) return code
    }
    switch (error.getStatus()) {
      case HttpStatus.BAD_REQUEST:
        return 'WORKSPACE_REQUEST_REJECTED'
      case HttpStatus.UNAUTHORIZED:
        return 'AUTHENTICATION_REQUIRED'
      case HttpStatus.FORBIDDEN:
        return 'WORKSPACE_AUTHORIZATION_DENIED'
      case HttpStatus.NOT_FOUND:
        return 'WORKSPACE_TARGET_NOT_FOUND'
      case HttpStatus.CONFLICT:
        return 'WORKSPACE_CONFLICT'
      case HttpStatus.TOO_MANY_REQUESTS:
        return 'AUTH_EMAIL_RATE_LIMITED'
      case HttpStatus.SERVICE_UNAVAILABLE:
      case HttpStatus.BAD_GATEWAY:
      case HttpStatus.GATEWAY_TIMEOUT:
        return 'WORKSPACE_DEPENDENCY_UNAVAILABLE'
      default:
        return 'WORKSPACE_OPERATION_FAILED'
    }
  }
  const candidate = error as { code?: unknown } | null
  if (candidate?.code === 'P2002') return 'WORKSPACE_CONFLICT'
  if (candidate?.code === 'P2025') return 'WORKSPACE_TARGET_NOT_FOUND'
  return 'WORKSPACE_OPERATION_FAILED'
}
