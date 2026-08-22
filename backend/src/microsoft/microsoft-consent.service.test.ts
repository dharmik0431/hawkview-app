import assert from 'node:assert/strict'
import test from 'node:test'
import {
  MicrosoftConsentService,
  normalizeConfiguredRequiredPermissions,
} from './microsoft-consent.service.js'

test('filters only resource-qualified deprecated SharePoint full-control overrides', () => {
  const result = normalizeConfiguredRequiredPermissions([
    ' Sites.Read.All ',
    'ActivityFeed.Read',
    'sharepoint: Sites . FullControl . All',
    'https://contoso.sharepoint.com/Sites.FullControl.All',
    'Office 365 SharePoint Online/SITES.FULLCONTROL.ALL',
    'https://graph.microsoft.com/Sites.Read.All',
  ].join(','))

  assert.deepEqual(result.permissions, [
    'Sites.Read.All',
    'ActivityFeed.Read',
  ])
  assert.equal(result.rejected.length, 3)
  assert.match(result.rejected.join('\n'), /SharePoint/i)
})

test('keeps canonical bare Graph values while rejecting unknown and mismatched resources safely', () => {
  const result = normalizeConfiguredRequiredPermissions(
    '  Sites.Read.All , graph:AuditLog.Read.All, https://evil.example/Sites.FullControl.All, Sites.FullControl.All '
  )
  assert.deepEqual(result.permissions, [
    'Sites.Read.All',
    'AuditLog.Read.All',
  ])
  assert.match(result.rejected.join('\n'), /unknown|unrecognized/i)
})

test('rejects SharePoint application-id, label, URL, separator, and encoding bypasses', () => {
  const probes = [
    '00000003-0000-0ff1-ce00-000000000000/Sites.FullControl.All',
    '00000003-0000-0ff1-ce00-000000000000:Sites.FullControl.All',
    '00000003-0000-0ff1-ce00-000000000000%2fSites.FullControl.All',
    '00000003-0000-0ff1-ce00-000000000000%253ASites.FullControl.All',
    'SharePoint%3aSites.FullControl.All',
    'https%3a%2f%2fcontoso.sharepoint.com%2fSites.FullControl.All',
    'https%253a%252f%252fcontoso.sharepoint.com%252fSites.FullControl.All',
    'sharepoint\\Sites.FullControl.All',
    'sharepoint:Sites%ZZFullControl.All',
  ]
  const result = normalizeConfiguredRequiredPermissions([...probes, 'ActivityFeed.Read'].join(','))
  assert.deepEqual(result.permissions, ['ActivityFeed.Read'])
  assert.equal(result.rejected.length, probes.length)
  assert.equal(result.rejected.some((entry) => /fullcontrol/i.test(entry) && !/SharePoint|unknown|malformed/i.test(entry)), false)
})

test('accepts only explicit Graph and Office 365 Management resource representations', () => {
  const result = normalizeConfiguredRequiredPermissions([
    'https://graph.microsoft.com/Policy.Read.All',
    'graph:Reports.Read.All',
    'https://manage.office.com/ActivityFeed.Read',
    'office365management:ActivityFeed.Read',
    'https://graph.microsoft.com/ActivityFeed.Read',
    'https://manage.office.com/Policy.Read.All',
  ].join(','))
  assert.deepEqual(result.permissions, [
    'Policy.Read.All', 'Reports.Read.All', 'ActivityFeed.Read',
  ])
  assert.equal(result.rejected.length, 2)
})

test('applies the same override filtering independently for managed and customer connector flows', () => {
  for (const mode of ['MANAGED', 'CUSTOMER_MANAGED']) {
    const result = normalizeConfiguredRequiredPermissions(
      `sharepoint/Sites.FullControl.All, ${mode === 'MANAGED' ? 'Organization.Read.All' : 'Reports.Read.All'}`
    )
    assert.equal(result.permissions.some((permission) => /fullcontrol/i.test(permission)), false)
    assert.equal(result.permissions.length, 1)
    assert.equal(result.rejected.length, 1)
  }
})

test('never reports a deprecated SharePoint full-control override as required consent', () => {
  const prior = process.env.MICROSOFT_REQUIRED_PERMISSIONS
  process.env.MICROSOFT_REQUIRED_PERMISSIONS = [
    'sharepoint:Sites.FullControl.All',
    'https://contoso.sharepoint.com/Sites.FullControl.All',
    'ActivityFeed.Read',
  ].join(',')
  try {
    const service = new MicrosoftConsentService({} as never, {} as never)
    const names = service.getRequiredPermissions().map((permission) => permission.name)
    assert.equal(names.some((name) => /sharepoint.*fullcontrol/i.test(name)), false)
    assert.ok(names.includes('Sites.Read.All'))
    assert.ok(names.includes('ActivityFeed.Read'))
    assert.ok(names.includes('Directory.Read.All'))
  } finally {
    if (prior === undefined) delete process.env.MICROSOFT_REQUIRED_PERMISSIONS
    else process.env.MICROSOFT_REQUIRED_PERMISSIONS = prior
  }
})

test('standard onboarding requests only the compiled least-privilege permissions', () => {
  const service = new MicrosoftConsentService({} as never, {} as never)
  const required = service.getRequiredPermissions().map((item) => item.name)
  assert.equal(required.includes('Exchange.ManageAsAppV2'), false)
  assert.equal(required.includes('MailboxSettings.Read'), true)
  assert.equal(required.includes('Reports.Read.All'), true)
})

test('optional Exchange consent is isolated from the standard Graph consent scope', async () => {
  const priorRedirect = process.env.MICROSOFT_ADMIN_CONSENT_REDIRECT_URI
  process.env.MICROSOFT_ADMIN_CONSENT_REDIRECT_URI = 'https://app.hawkview.example/auth/microsoft/callback'
  try {
    const service = new MicrosoftConsentService({
      platformMicrosoftConnector: {
        findUnique: async () => ({
          clientId: '11111111-2222-4333-8444-555555555555',
          homeTenantId: 'home-tenant',
          credentialReference: 'managed-secret',
        }),
      },
    } as never, {
      accessOrCreate: async () => 'a'.repeat(64),
      access: async () => 'managed-secret-value',
    } as never)
    const exchange = await service.createExchangeReadOnlyConsentUrl(
      'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
      {
        customerTenantId: 'tenant-record',
        organizationId: 'organization-record',
      },
    )
    const standard = await service.createAdminConsentUrl(
      'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
      {
        customerTenantId: 'tenant-record',
        organizationId: 'organization-record',
      },
    )
    assert.equal(new URL(exchange.consentUrl).searchParams.get('scope'), 'https://outlook.office365.com/.default')
    assert.equal(new URL(standard.consentUrl).searchParams.get('scope'), 'https://graph.microsoft.com/.default')
    const state = await service.verifyConsentState(new URL(exchange.consentUrl).searchParams.get('state')!)
    assert.equal(state.flow, 'exchange-readonly')
  } finally {
    if (priorRedirect === undefined) delete process.env.MICROSOFT_ADMIN_CONSENT_REDIRECT_URI
    else process.env.MICROSOFT_ADMIN_CONSENT_REDIRECT_URI = priorRedirect
  }
})

test('optional Exchange token requires the exact app-only permission', async () => {
  const service = new MicrosoftConsentService({
    platformMicrosoftConnector: {
      findUnique: async () => ({
        clientId: 'managed-app',
        homeTenantId: 'home-tenant',
        credentialReference: 'managed-secret',
      }),
    },
  } as never, {
    access: async () => 'secret',
  } as never)
  ;(service as any).requestAccessToken = async (_tenant: string, _credentials: unknown, scope: string) => ({
    accessToken: 'exchange-token',
    grantedPermissions: scope === 'https://outlook.office365.com/.default'
      ? ['Exchange.ManageAsAppV2']
      : [],
    directoryRoleIds: [],
  })
  assert.equal(await service.getTenantExchangeAccessToken({
    microsoftTenantId: 'tenant',
    connectionMode: 'HAWKVIEW_MANAGED',
    clientId: null,
    credentialReference: null,
  }), 'exchange-token')

  ;(service as any).requestAccessToken = async () => ({
    accessToken: 'wrong-token',
    grantedPermissions: ['Exchange.ManageAsApp'],
  })
  await assert.rejects(
    service.getTenantExchangeAccessToken({
      microsoftTenantId: 'tenant',
      connectionMode: 'HAWKVIEW_MANAGED',
      clientId: null,
      credentialReference: null,
    }),
    /Exchange\.ManageAsAppV2/,
  )

  ;(service as any).requestAccessToken = async () => ({
    accessToken: 'broad-token',
    grantedPermissions: ['Exchange.ManageAsAppV2'],
    directoryRoleIds: ['29232cdf-9323-42fd-ade2-1d097af3e4de'],
  })
  await assert.rejects(
    service.getTenantExchangeAccessToken({
      microsoftTenantId: 'tenant',
      connectionMode: 'HAWKVIEW_MANAGED',
      clientId: null,
      credentialReference: null,
    }),
    /broader Microsoft Entra directory role/,
  )
})

test('managed and customer verification paths do not make a deprecated override missing', async () => {
  const prior = process.env.MICROSOFT_REQUIRED_PERMISSIONS
  process.env.MICROSOFT_REQUIRED_PERMISSIONS = [
    '00000003-0000-0ff1-ce00-000000000000%253ASites.FullControl.All',
    'https://contoso.sharepoint.com/Sites.FullControl.All',
  ].join(',')
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async () => new Response(JSON.stringify({
    value: [{ id: 'tenant-1', displayName: 'Tenant', verifiedDomains: [] }],
  }))) as typeof fetch
  try {
    for (const connectionMode of ['HAWKVIEW_MANAGED', 'CUSTOMER_MANAGED'] as const) {
      const service = new MicrosoftConsentService({
        platformMicrosoftConnector: {
          findUnique: async () => ({ clientId: 'managed-app', homeTenantId: 'home-tenant', credentialReference: 'managed-secret' }),
        },
      } as never, {
        access: async () => 'secret',
      } as never)
      ;(service as any).requestAccessToken = async (_tenant: string, _credentials: unknown, scope?: string) => ({
        accessToken: 'token',
        grantedPermissions: scope === 'https://manage.office.com/.default'
          ? ['ActivityFeed.Read']
          : [
              'Organization.Read.All', 'User.Read.All', 'GroupMember.Read.All', 'Member.Read.Hidden',
              'AuditLog.Read.All', 'Directory.Read.All', 'UserAuthenticationMethod.Read.All', 'Policy.Read.All',
              'Policy.Read.AuthenticationMethod', 'Device.Read.All', 'RoleManagement.Read.Directory',
              'Application.Read.All', 'Sites.Read.All', 'SharePointTenantSettings.Read.All',
              'Reports.Read.All', 'MailboxSettings.Read', 'SecurityEvents.Read.All',
            ],
      })
      const result = await service.verifyConnectedTenant({
        microsoftTenantId: 'tenant-1', connectionMode,
        clientId: connectionMode === 'CUSTOMER_MANAGED' ? 'customer-app' : null,
        credentialReference: connectionMode === 'CUSTOMER_MANAGED' ? 'customer-secret' : null,
      })
      assert.deepEqual(result.missingPermissions, [])
    }
  } finally {
    globalThis.fetch = originalFetch
    if (prior === undefined) delete process.env.MICROSOFT_REQUIRED_PERMISSIONS
    else process.env.MICROSOFT_REQUIRED_PERMISSIONS = prior
  }
})
