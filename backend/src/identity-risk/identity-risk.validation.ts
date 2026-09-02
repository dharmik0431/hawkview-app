import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import {
  BadRequestException,
  ServiceUnavailableException,
} from '@nestjs/common'
import {
  IDENTITY_RISK_DEFAULT_PAGE_SIZE,
  IDENTITY_RISK_MAX_FUTURE_SKEW_MS,
  IDENTITY_RISK_MAX_PAGE_SIZE,
} from './identity-risk.contract.js'

const SAFE_OPAQUE_ID = /^[A-Za-z0-9._:-]+$/
const SAFE_CURSOR = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/

export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

export function boundedSafeString(
  value: unknown,
  maximumLength: number,
): string | null {
  if (typeof value !== 'string') return null
  const normalized = value.trim()
  if (
    normalized.length === 0 ||
    normalized.length > maximumLength ||
    /[\p{Cc}\p{Cf}]/u.test(normalized)
  ) return null
  return normalized
}

export function boundedOpaqueId(
  value: unknown,
  maximumLength: number,
): string | null {
  const normalized = boundedSafeString(value, maximumLength)
  return normalized && SAFE_OPAQUE_ID.test(normalized) ? normalized : null
}

export function parseTimestamp(
  value: unknown,
  now: Date,
): Date | null {
  const date = value instanceof Date
    ? new Date(value.getTime())
    : typeof value === 'string'
      ? new Date(value)
      : null
  if (
    !date ||
    !Number.isFinite(date.getTime()) ||
    date.getTime() > now.getTime() + IDENTITY_RISK_MAX_FUTURE_SKEW_MS
  ) return null
  return date
}

export function parsePageLimit(value: unknown): number {
  if (value === undefined || value === null || value === '') {
    return IDENTITY_RISK_DEFAULT_PAGE_SIZE
  }
  if (typeof value !== 'string' || !/^\d+$/.test(value)) {
    throw new BadRequestException('Pagination request is invalid.')
  }
  const limit = Number(value)
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > IDENTITY_RISK_MAX_PAGE_SIZE) {
    throw new BadRequestException('Pagination request is invalid.')
  }
  return limit
}

type CursorChannel = 'h' | 'm'
export type IdentityRiskCursorPosition = Readonly<{
  observedAt: Date
  id: string
}>

type CursorPayload = Readonly<{
  v: 1
  c: CursorChannel
  s: string
  a: number
  i: string
  f: 1
}>

function cursorSecret() {
  const secret = process.env.HAWKVIEW_IDENTITY_RISK_CURSOR_SECRET
  if (!secret || secret.length < 32) {
    throw new ServiceUnavailableException('Identity risk pagination is unavailable.')
  }
  return secret
}

function scopeDigest(organizationId: string, customerTenantId: string) {
  return createHash('sha256')
    .update(`v1\u0000${organizationId}\u0000${customerTenantId}`)
    .digest('hex')
    .slice(0, 24)
}

export function encodeIdentityRiskCursor(input: {
  channel: CursorChannel
  organizationId: string
  customerTenantId: string
  position: IdentityRiskCursorPosition
}): string {
  const id = boundedOpaqueId(input.position.id, 200)
  if (!id || !Number.isFinite(input.position.observedAt.getTime())) {
    throw new ServiceUnavailableException('Identity risk pagination is unavailable.')
  }
  const payload: CursorPayload = {
    v: 1,
    c: input.channel,
    s: scopeDigest(input.organizationId, input.customerTenantId),
    a: input.position.observedAt.getTime(),
    i: id,
    f: 1,
  }
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url')
  const signature = createHmac('sha256', cursorSecret())
    .update(body)
    .digest('base64url')
  const cursor = `${body}.${signature}`
  if (cursor.length > 256) {
    throw new ServiceUnavailableException('Identity risk pagination is unavailable.')
  }
  return cursor
}

export function decodeIdentityRiskCursor(input: {
  cursor: unknown
  channel: CursorChannel
  organizationId: string
  customerTenantId: string
  now: Date
}): IdentityRiskCursorPosition | null {
  if (input.cursor === undefined || input.cursor === null || input.cursor === '') return null
  if (
    typeof input.cursor !== 'string' ||
    input.cursor.length > 256 ||
    !SAFE_CURSOR.test(input.cursor)
  ) throw new BadRequestException('Pagination cursor is invalid.')

  try {
    const [body, supplied] = input.cursor.split('.')
    const expected = createHmac('sha256', cursorSecret()).update(body).digest()
    const suppliedBuffer = Buffer.from(supplied, 'base64url')
    if (
      suppliedBuffer.length !== expected.length ||
      !timingSafeEqual(suppliedBuffer, expected)
    ) throw new Error('signature')
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as unknown
    if (
      !isPlainRecord(payload) ||
      Object.keys(payload).sort().join(',') !== 'a,c,f,i,s,v' ||
      payload.v !== 1 ||
      payload.c !== input.channel ||
      payload.f !== 1 ||
      payload.s !== scopeDigest(input.organizationId, input.customerTenantId) ||
      typeof payload.a !== 'number' ||
      !Number.isSafeInteger(payload.a) ||
      !boundedOpaqueId(payload.i, 200)
    ) throw new Error('payload')
    const observedAt = parseTimestamp(new Date(payload.a), input.now)
    if (!observedAt) throw new Error('timestamp')
    return { observedAt, id: payload.i as string }
  } catch (error) {
    if (error instanceof ServiceUnavailableException) throw error
    throw new BadRequestException('Pagination cursor is invalid.')
  }
}

export function tenantScopedOpaqueId(
  prefix: string,
  organizationId: string,
  customerTenantId: string,
  sourceId: string,
) {
  return `${prefix}_${createHash('sha256')
    .update(`v1\u0000${organizationId}\u0000${customerTenantId}\u0000${sourceId}`)
    .digest('hex')
    .slice(0, 32)}`
}
