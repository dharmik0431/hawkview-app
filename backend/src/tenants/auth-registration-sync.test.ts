import assert from 'node:assert/strict'
import test from 'node:test'
import {
  AUTH_REGISTRATION_FALLBACK_LIMITS,
  graphErrorCodeFromBody,
  MicrosoftGraphCollectionError,
  NON_PREMIUM_AUTH_REGISTRATION_ERROR_CODE,
  projectMfaTruth,
  readGraphOperationalError,
  TenantSyncService,
  type AuthRegistrationFallbackLimits,
} from './tenant-sync.service.js'

type TenantRef = { id: string; organizationId: string }
const tenant: TenantRef = { id: 'tenant-1', organizationId: 'org-1' }

function serviceWithPrisma(prisma: Record<string, unknown>) {
  return new TenantSyncService(
    prisma as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  )
}

type InternalAuthSync = {
  syncAuthenticationRegistrations: (
    tenant: TenantRef,
    accessToken: string,
  ) => Promise<unknown>
  collectEntraCollection: (...args: unknown[]) => Promise<unknown[]>
  collectPerUserAuthenticationMethods: (
    accessToken: string,
    limits?: Readonly<AuthRegistrationFallbackLimits>,
  ) => Promise<unknown[]>
  enrichAuthenticationRegistrationsWithPerUserMfaState: (
    accessToken: string,
    registrations: unknown[],
    limits?: Readonly<AuthRegistrationFallbackLimits>,
  ) => Promise<unknown[]>
  runSnapshotSync: (
    tenant: TenantRef,
    resource: string,
    collect: () => Promise<void>,
  ) => Promise<void>
  saveEntraSnapshot: (
    tenant: TenantRef,
    resource: string,
    rows: unknown[],
  ) => Promise<void>
}

function internal(service: TenantSyncService) {
  return service as unknown as InternalAuthSync
}

test('extracts only a bounded safe Microsoft Graph error code', () => {
  assert.equal(
    graphErrorCodeFromBody(JSON.stringify({
      error: {
        code: NON_PREMIUM_AUTH_REGISTRATION_ERROR_CODE,
        message: 'Neither tenant is B2C or tenant does not have a premium license',
        access_token: 'do-not-log',
      },
    })),
    NON_PREMIUM_AUTH_REGISTRATION_ERROR_CODE,
  )
  for (const body of [
    '',
    'not-json',
    JSON.stringify({ error: { code: 'bad code with spaces' } }),
    JSON.stringify({ error: { code: 'x'.repeat(129) } }),
    JSON.stringify({ error: { code: { nested: 'value' } } }),
    JSON.stringify({ code: NON_PREMIUM_AUTH_REGISTRATION_ERROR_CODE }),
    'x'.repeat(32 * 1024 + 1),
  ]) {
    assert.equal(graphErrorCodeFromBody(body), null)
  }
})

test('keeps the exact safe Graph code for control flow without leaking credentials', async () => {
  const response = new Response(JSON.stringify({
    error: {
      code: NON_PREMIUM_AUTH_REGISTRATION_ERROR_CODE,
      message: 'Premium report unavailable',
      access_token: 'secret-access-token',
      password: 'secret-password',
      innerError: { authorization: 'Bearer secret-jwt' },
    },
  }), { status: 403, headers: { 'content-type': 'application/json' } })
  const result = await readGraphOperationalError(response)
  assert.equal(result.code, NON_PREMIUM_AUTH_REGISTRATION_ERROR_CODE)
  assert.match(result.suffix, /Authentication_RequestFromNonPremiumTenantOrB2CTenant/)
  assert.doesNotMatch(result.suffix, /secret-access-token|secret-password|secret-jwt/)
})

test('fails closed when a Graph error body exceeds the bounded reader', async () => {
  let cancelled = false
  const response = new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('x'.repeat(40)))
    },
    cancel() {
      cancelled = true
    },
  }), { status: 403 })
  const result = await readGraphOperationalError(response, 16)
  assert.equal(result.code, null)
  assert.match(result.suffix, /bounded response-size limit/)
  assert.equal(cancelled, true)
})

test('falls back only for the exact non-premium report error', async () => {
  const subject = internal(serviceWithPrisma({}))
  subject.runSnapshotSync = async (_tenant, _resource, collect) => collect()
  let savedRows: unknown[] | null = null
  subject.saveEntraSnapshot = async (_tenant, resource, rows) => {
    assert.equal(resource, 'AUTH_REGISTRATIONS')
    savedRows = rows
  }
  let fallbackCalls = 0
  subject.collectPerUserAuthenticationMethods = async () => {
    fallbackCalls += 1
    return [{ id: 'fallback-user' }]
  }
  subject.enrichAuthenticationRegistrationsWithPerUserMfaState = async (_token, rows) => rows
  subject.collectEntraCollection = async () => {
    throw new MicrosoftGraphCollectionError(
      'Microsoft auth registrations synchronization returned 403.',
      403,
      NON_PREMIUM_AUTH_REGISTRATION_ERROR_CODE,
    )
  }
  await subject.syncAuthenticationRegistrations(tenant, 'graph-token')
  assert.equal(fallbackCalls, 1)
  assert.deepEqual(savedRows, [{ id: 'fallback-user' }])

  subject.collectEntraCollection = async () => {
    throw new MicrosoftGraphCollectionError(
      'Microsoft auth registrations synchronization returned 403.',
      403,
      'Authorization_RequestDenied',
    )
  }
  await assert.rejects(
    subject.syncAuthenticationRegistrations(tenant, 'graph-token'),
    /returned 403/,
  )
  assert.equal(fallbackCalls, 1)
})

test('uses the actual Graph response path to classify non-premium and permission 403 responses', async () => {
  const subject = internal(serviceWithPrisma({}))
  let wrapperCalls = 0
  subject.runSnapshotSync = async (_tenant, _resource, collect) => {
    wrapperCalls += 1
    return collect()
  }
  let savedRows: unknown[] | null = null
  subject.saveEntraSnapshot = async (_tenant, resource, rows) => {
    assert.equal(resource, 'AUTH_REGISTRATIONS')
    savedRows = rows
  }
  let fallbackCalls = 0
  subject.collectPerUserAuthenticationMethods = async () => {
    fallbackCalls += 1
    return [{ id: 'fallback-user' }]
  }
  subject.enrichAuthenticationRegistrationsWithPerUserMfaState = async (_token, rows) => rows
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => new Response(JSON.stringify({
    error: {
      code: NON_PREMIUM_AUTH_REGISTRATION_ERROR_CODE,
      message: 'Premium report unavailable',
      access_token: 'must-not-leak',
    },
  }), {
    status: 403,
    headers: { 'content-type': 'application/json', 'request-id': 'request-safe-id' },
  })
  try {
    await subject.syncAuthenticationRegistrations(tenant, 'graph-token')
    assert.equal(wrapperCalls, 1)
    assert.equal(fallbackCalls, 1)
    assert.deepEqual(savedRows, [{ id: 'fallback-user' }])

    globalThis.fetch = async () => new Response(JSON.stringify({
      error: {
        code: 'Authorization_RequestDenied',
        message: 'Insufficient privileges',
        client_secret: 'must-not-leak-either',
      },
    }), { status: 403, headers: { 'content-type': 'application/json' } })
    await assert.rejects(
      subject.syncAuthenticationRegistrations(tenant, 'graph-token'),
      (error: unknown) => {
        assert.ok(error instanceof MicrosoftGraphCollectionError)
        assert.equal(error.graphErrorCode, 'Authorization_RequestDenied')
        assert.doesNotMatch(error.message, /must-not-leak-either/)
        return true
      },
    )
    assert.equal(wrapperCalls, 2)
    assert.equal(fallbackCalls, 1)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('collects the separate legacy per-user MFA requirement without changing registration truth', async () => {
  const subject = internal(serviceWithPrisma({}))
  const originalFetch = globalThis.fetch
  const requestedUrls: string[] = []
  globalThis.fetch = async (input, init) => {
    assert.equal(String(input), 'https://graph.microsoft.com/beta/$batch')
    const payload = JSON.parse(String(init?.body)) as {
      requests: Array<{ id: string; url: string }>
    }
    requestedUrls.push(...payload.requests.map((request) => request.url))
    return new Response(JSON.stringify({
      responses: [
        { id: '1', status: 200, body: { perUserMfaState: 'disabled' } },
        { id: '2', status: 200, body: { perUserMfaState: 'enforced' } },
        { id: '3', status: 200, body: { perUserMfaState: 'unexpected' } },
      ],
    }), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  try {
    const result = await subject.enrichAuthenticationRegistrationsWithPerUserMfaState(
      'graph-token',
      [
        { id: 'user-a', isMfaRegistered: true },
        { id: 'user-b', isMfaRegistered: false },
        { id: 'user-c', isMfaRegistered: true },
      ],
    ) as Array<Record<string, unknown>>
    assert.deepEqual(requestedUrls, [
      '/users/user-a/authentication/requirements',
      '/users/user-b/authentication/requirements',
      '/users/user-c/authentication/requirements',
    ])
    assert.equal(result[0]?.isMfaRegistered, true)
    assert.equal(result[0]?.perUserMfaState, 'disabled')
    assert.equal(result[1]?.isMfaRegistered, false)
    assert.equal(result[1]?.perUserMfaState, 'enforced')
    assert.equal(result[2]?.perUserMfaState, null)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('retains registration data when the optional per-user MFA lookup fails', async () => {
  const subject = internal(serviceWithPrisma({}))
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => new Response(JSON.stringify({
    error: { code: 'Authorization_RequestDenied', client_secret: 'must-not-leak' },
  }), { status: 403, headers: { 'content-type': 'application/json' } })
  try {
    const result = await subject.enrichAuthenticationRegistrationsWithPerUserMfaState(
      'graph-token',
      [{ id: 'user-a', isMfaRegistered: true, methodsRegistered: ['Passkey'] }],
    ) as Array<Record<string, unknown>>
    assert.equal(result[0]?.isMfaRegistered, true)
    assert.deepEqual(result[0]?.methodsRegistered, ['Passkey'])
    assert.equal(result[0]?.perUserMfaState, null)
    assert.doesNotMatch(JSON.stringify(result), /must-not-leak/)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('projects registration and per-user MFA as independent facts', () => {
  assert.deepEqual(projectMfaTruth({
    isMfaRegistered: true,
    perUserMfaState: 'disabled',
    collectionSource: 'per-user-authentication-methods',
  }), {
    mfa: 'Enabled',
    mfaRegistration: 'Registered',
    perUserMfaState: 'Disabled',
    mfaRegistrationSource: 'microsoft-graph-authentication-methods',
    perUserMfaStateSource: 'microsoft-graph-beta-authentication-requirements',
  })
  assert.deepEqual(projectMfaTruth(null), {
    mfa: 'Unknown',
    mfaRegistration: 'Unknown',
    perUserMfaState: 'Unknown',
    mfaRegistrationSource: null,
    perUserMfaStateSource: null,
  })
})

test('uses bounded 20-user Graph batches and returns one complete fallback collection', async () => {
  const users = Array.from({ length: 41 }, (_, index) => ({
    microsoftUserId: `user-${String(index).padStart(3, '0')}`,
    userPrincipalName: `user${index}@example.test`,
  }))
  const subject = internal(serviceWithPrisma({}))
  const originalFetch = globalThis.fetch
  const batchSizes: number[] = []
  globalThis.fetch = async (input, init) => {
    if (String(input).includes('/users?')) {
      return new Response(JSON.stringify({ value: users.map((user) => ({
        id: user.microsoftUserId,
        userPrincipalName: user.userPrincipalName,
      })) }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    const payload = JSON.parse(String(init?.body)) as {
      requests: Array<{ id: string; url: string }>
    }
    batchSizes.push(payload.requests.length)
    return new Response(JSON.stringify({
      responses: payload.requests.map((request) => ({
        id: request.id,
        status: 200,
        body: {
          value: [{ '@odata.type': '#microsoft.graph.microsoftAuthenticatorAuthenticationMethod' }],
        },
      })),
    }), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  try {
    const rows = await subject.collectPerUserAuthenticationMethods(
      'graph-token',
      AUTH_REGISTRATION_FALLBACK_LIMITS,
    )
    assert.equal(rows.length, 41)
    assert.deepEqual(rows[0], {
      id: 'user-000',
      userPrincipalName: 'user0@example.test',
      isMfaRegistered: true,
      isMfaCapable: true,
      methodsRegistered: ['Microsoft Authenticator'],
      collectionSource: 'per-user-authentication-methods',
    })
  } finally {
    globalThis.fetch = originalFetch
  }

  assert.deepEqual(batchSizes, [20, 20, 1])
})

test('fails before method batches when fresh Graph user discovery exceeds the fallback cap', async () => {
  const subject = internal(serviceWithPrisma({}))
  let fetches = 0
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => {
    fetches += 1
    return new Response(JSON.stringify({ value: [
      { id: 'user-1', userPrincipalName: 'one@example.test' },
      { id: 'user-2', userPrincipalName: 'two@example.test' },
      { id: 'user-3', userPrincipalName: 'three@example.test' },
    ] }), { status: 200 })
  }
  try {
    await assert.rejects(
      subject.collectPerUserAuthenticationMethods('graph-token', {
        ...AUTH_REGISTRATION_FALLBACK_LIMITS,
        maxUsers: 2,
        maxBatches: 1,
      }),
      /bounded 2-user limit/,
    )
  } finally {
    globalThis.fetch = originalFetch
  }
  assert.equal(fetches, 1)
})

test('rejects repeated fresh-user pagination before any authentication-method batch', async () => {
  const subject = internal(serviceWithPrisma({}))
  const userUrl =
    'https://graph.microsoft.com/v1.0/users?$select=id,userPrincipalName&$top=999'
  let batchFetched = false
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (input) => {
    if (String(input) === userUrl) {
      return new Response(JSON.stringify({
        value: [{ id: 'user-1', userPrincipalName: 'one@example.test' }],
        '@odata.nextLink': userUrl,
      }), { status: 200 })
    }
    batchFetched = true
    throw new Error('unexpected batch fetch')
  }
  try {
    await assert.rejects(
      subject.collectPerUserAuthenticationMethods('graph-token'),
      /invalid or repeated users pagination link/,
    )
  } finally {
    globalThis.fetch = originalFetch
  }
  assert.equal(batchFetched, false)
})

test('rejects invalid or over-20 Graph batch bounds before fetching tenant users', async () => {
  const subject = internal(serviceWithPrisma({}))
  let fetched = false
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => {
    fetched = true
    throw new Error('unexpected fetch')
  }
  for (const limits of [
    { ...AUTH_REGISTRATION_FALLBACK_LIMITS, batchSize: 0 },
    { ...AUTH_REGISTRATION_FALLBACK_LIMITS, batchSize: 21 },
    { ...AUTH_REGISTRATION_FALLBACK_LIMITS, responseBytes: Number.NaN },
  ]) {
    await assert.rejects(
      subject.collectPerUserAuthenticationMethods('graph-token', limits),
      /invalid bounded collection configuration/,
    )
  }
  globalThis.fetch = originalFetch
  assert.equal(fetched, false)
})

test('fails before Graph calls when the bounded fallback batch ceiling is exceeded', async () => {
  const subject = internal(serviceWithPrisma({}))
  let batchFetched = false
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (input) => {
    if (String(input).includes('/users?')) {
      return new Response(JSON.stringify({ value: [
        { id: 'user-1', userPrincipalName: 'one@example.test' },
        { id: 'user-2', userPrincipalName: 'two@example.test' },
      ] }), { status: 200 })
    }
    batchFetched = true
    throw new Error('unexpected batch fetch')
  }
  try {
    await assert.rejects(
      subject.collectPerUserAuthenticationMethods('graph-token', {
        ...AUTH_REGISTRATION_FALLBACK_LIMITS,
        batchSize: 1,
        maxBatches: 1,
      }),
      /bounded 1-batch limit/,
    )
  } finally {
    globalThis.fetch = originalFetch
  }
  assert.equal(batchFetched, false)
})

test('rejects the fallback collection when a Graph batch item fails', async () => {
  const subject = internal(serviceWithPrisma({}))
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (input) => String(input).includes('/users?')
    ? new Response(JSON.stringify({ value: [
        { id: 'user-1', userPrincipalName: 'one@example.test' },
      ] }), { status: 200 })
    : new Response(JSON.stringify({
        responses: [{ id: '1', status: 403, body: { error: { code: 'Authorization_RequestDenied' } } }],
      }), { status: 200, headers: { 'content-type': 'application/json' } })
  try {
    await assert.rejects(
      subject.collectPerUserAuthenticationMethods('graph-token'),
      /returned 403.*UserAuthenticationMethod\.Read\.All/,
    )
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('rejects duplicate or incomplete Graph batch response IDs', async () => {
  const subject = internal(serviceWithPrisma({}))
  const originalFetch = globalThis.fetch
  let batchAttempt = 0
  globalThis.fetch = async (input) => {
    if (String(input).includes('/users?')) {
      return new Response(JSON.stringify({ value: [
        { id: 'user-1', userPrincipalName: 'one@example.test' },
        { id: 'user-2', userPrincipalName: 'two@example.test' },
      ] }), { status: 200 })
    }
    batchAttempt += 1
    return new Response(JSON.stringify({
      responses: batchAttempt === 1
        ? [
            { id: '1', status: 200, body: { value: [] } },
            { id: '1', status: 200, body: { value: [] } },
          ]
        : [{ id: '1', status: 200, body: { value: [] } }],
    }), { status: 200 })
  }
  try {
    await assert.rejects(
      subject.collectPerUserAuthenticationMethods('graph-token'),
      /invalid batch response/,
    )
    await assert.rejects(
      subject.collectPerUserAuthenticationMethods('graph-token'),
      /incomplete batch response/,
    )
  } finally {
    globalThis.fetch = originalFetch
  }
})
