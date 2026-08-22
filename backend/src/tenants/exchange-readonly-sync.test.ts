import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { TenantSyncService } from './tenant-sync.service.js'

function service(microsoftConsent: Record<string, unknown> = {}) {
  return new TenantSyncService(
    {} as never,
    microsoftConsent as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  )
}

const tenant = {
  id: 'tenant-record',
  organizationId: 'organization-record',
  microsoftTenantId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
  displayName: 'Tenant',
  primaryDomain: 'contoso.example',
  status: 'ACTIVE',
  connection: {
    connectionMode: 'HAWKVIEW_MANAGED',
    clientId: null,
    credentialReference: null,
    lastVerifiedAt: null,
    exchangeReadOnlyEnabledAt: null,
  },
}

test('collector sends Get-Mailbox only and persists only the closed read projection', async () => {
  const instance = service()
  let capturedUrl = ''
  let capturedInit: RequestInit | undefined
  ;(instance as any).fetchGraphPage = async (
    url: string,
    _token: string,
    _label: string,
    options: { init?: RequestInit },
  ) => {
    capturedUrl = url
    capturedInit = options.init
    return new Response(JSON.stringify({
      value: [{
        ExternalDirectoryObjectId: '11111111-2222-4333-8444-555555555555',
        UserPrincipalName: 'alex@contoso.example',
        DisplayName: 'Alex',
        MaxSendSize: '35 MB',
        GrantSendOnBehalfToWithDisplayNames: [{ DisplayName: 'Delegate One' }],
        RetentionPolicy: 'must-not-cross-boundary',
        ForwardingSmtpAddress: 'outside@example.test',
      }],
    }))
  }

  const rows = await (instance as any).collectExchangeReadOnlyMailboxes(tenant, 'token')
  assert.match(capturedUrl, /^https:\/\/outlook\.office365\.com\/adminapi\/v2\.0\//)
  assert.match(capturedUrl, /Mailbox\?\$select=/)
  assert.equal(capturedInit?.method, 'POST')
  const body = JSON.parse(String(capturedInit?.body))
  assert.deepEqual(body.CmdletInput, {
    CmdletName: 'Get-Mailbox',
    Parameters: {
      ResultSize: 'Unlimited',
      IncludeGrantSendOnBehalfToWithDisplayNames: true,
    },
  })
  assert.deepEqual(rows, [{
    externalDirectoryObjectId: '11111111-2222-4333-8444-555555555555',
    userPrincipalName: 'alex@contoso.example',
    primarySmtpAddress: null,
    displayName: 'Alex',
    recipientType: null,
    recipientTypeDetails: null,
    maxSendSize: '35 MB',
    sendOnBehalfTo: ['Delegate One'],
  }])
  assert.equal(JSON.stringify(rows).includes('RetentionPolicy'), false)
  assert.equal(JSON.stringify(rows).includes('outside@example.test'), false)
})

test('verification enables optional mode only inside the successful snapshot transaction hook', async () => {
  const instance = service({
    getTenantExchangeAccessToken: async () => 'exchange-token',
  })
  ;(instance as any).getReadableTenant = async () => tenant
  ;(instance as any).collectExchangeReadOnlyMailboxes = async () => [{
    externalDirectoryObjectId: null,
    userPrincipalName: 'alex@contoso.example',
    primarySmtpAddress: null,
    displayName: 'Alex',
    recipientType: null,
    recipientTypeDetails: null,
    maxSendSize: null,
    sendOnBehalfTo: [],
  }]
  let savedResource: string | null = null
  let enabledUpdate: any = null
  ;(instance as any).saveSnapshot = async (
    _tenant: unknown,
    resource: string,
    _snapshot: unknown,
    afterPersist: (transaction: any) => Promise<void>,
  ) => {
    savedResource = resource
    await afterPersist({
      tenantConnection: {
        update: async (input: unknown) => { enabledUpdate = input },
      },
    })
  }

  const result = await instance.verifyExchangeReadOnlyForIdentity(
    { subject: 'subject', email: 'owner@example.test' },
    tenant.id,
  )
  assert.equal(savedResource, 'EXCHANGE_MAILBOX_CONFIGURATION')
  assert.deepEqual(enabledUpdate.where.customerTenantId_organizationId, {
    customerTenantId: tenant.id,
    organizationId: tenant.organizationId,
  })
  assert.ok(enabledUpdate.data.exchangeReadOnlyEnabledAt instanceof Date)
  assert.equal(result.enabled, true)
  assert.equal(result.collectedMailboxes, 1)
})

test('failed probe never saves a snapshot or enables optional mode', async () => {
  const instance = service({
    getTenantExchangeAccessToken: async () => 'exchange-token',
  })
  ;(instance as any).getReadableTenant = async () => tenant
  ;(instance as any).collectExchangeReadOnlyMailboxes = async () => {
    throw new Error('Microsoft returned 403')
  }
  let saved = false
  ;(instance as any).saveSnapshot = async () => { saved = true }

  await assert.rejects(
    instance.verifyExchangeReadOnlyForIdentity(
      { subject: 'subject', email: 'owner@example.test' },
      tenant.id,
    ),
    /403/,
  )
  assert.equal(saved, false)
})

test('daily/full collection schedules Exchange enrichment only after durable verification', () => {
  const source = readFileSync(new URL('./tenant-sync.service.ts', import.meta.url), 'utf8')
  const moduleStart = source.indexOf('const snapshotModules')
  const guardedStart = source.indexOf('if (tenant.connection.exchangeReadOnlyEnabledAt)', moduleStart)
  assert.ok(moduleStart >= 0 && guardedStart > moduleStart)
  assert.equal(
    source.slice(moduleStart, guardedStart).includes("resource: 'EXCHANGE_MAILBOX_CONFIGURATION'"),
    false,
  )
  assert.match(
    source,
    /if \(tenant\.connection\.exchangeReadOnlyEnabledAt\) \{[\s\S]{0,500}resource: 'EXCHANGE_MAILBOX_CONFIGURATION'/,
  )
})
