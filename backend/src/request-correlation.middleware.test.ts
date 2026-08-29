import assert from 'node:assert/strict'
import test from 'node:test'
import type { NextFunction, Request, Response } from 'express'
import {
  type CorrelatedRequest,
  REQUEST_ID_HEADER,
  RequestCorrelationMiddleware,
} from './request-correlation.middleware.js'

test('request correlation is server-generated, returned, and ignores caller values', () => {
  const request = {
    headers: { 'x-request-id': 'caller-controlled-value' },
  } as unknown as Request
  const headers = new Map<string, string>()
  const response = {
    setHeader: (name: string, value: string) => {
      headers.set(name, value)
    },
  } as unknown as Response
  let nextCalled = false

  new RequestCorrelationMiddleware().use(request, response, (() => {
    nextCalled = true
  }) as NextFunction)

  const requestId = (request as CorrelatedRequest).requestId
  assert.match(
    requestId,
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
  )
  assert.notEqual(requestId, 'caller-controlled-value')
  assert.equal(headers.get(REQUEST_ID_HEADER), requestId)
  assert.equal(nextCalled, true)
})
