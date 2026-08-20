import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import {
  classifyExchangeRule,
  compareExchangeRulePriority,
  exchangeRuleEnabledState,
  exchangeRulePriority,
  exchangeRuleRelatedAuditParams,
  normalizeExchangeRuleDrawer,
  normalizeExchangeRuleRelatedAuditResponse,
} from './exchange-rule-drawer.ts'

test('normalizes internal and external forwarding plus multiple conditions and destinations', () => {
  const rule = normalizeExchangeRuleDrawer({
    name: 'Forward invoices', microsoftRuleName: 'Forward invoices', mailboxUpn: 'user@contoso.com', enabled: true, priority: 2,
    hasError: false, isReadOnly: true, configurationCollectedAt: '2026-08-19T12:00:00.000Z',
    details: {
      conditions: [
        { key: 'subjectContains', label: 'untrusted', values: ['Invoice', 'Urgent'], truncated: false },
        { key: 'fromAddresses', values: ['Accounts <billing@contoso.com>'] },
        { key: 'recipientContains', values: ['@contoso.com'] },
        { key: 'withinSizeRange', values: ['Minimum 64 KB', 'Maximum 2048 KB'] },
      ],
      exceptions: [
        { key: 'recipientContains', values: ['service@example.net'] },
        { key: 'senderContains', values: ['trusted.example'] },
        { key: 'withinSizeRange', values: ['Minimum 1 KB', 'Maximum 32 KB'] },
      ],
      actions: [
        { key: 'forwardTo', values: ['review@contoso.com', 'archive@example.net'] },
        { key: 'moveToFolder', values: ['Archive'] },
        { key: 'delete', values: [] },
      ],
    },
  }, new Date('2026-08-20T12:00:00.000Z'))

  assert.equal(rule?.name, 'Forward invoices')
  assert.equal(rule?.microsoftRuleName, 'Forward invoices')
  assert.equal(rule?.mailboxUpn, 'user@contoso.com')
  assert.equal(rule?.hasError, false)
  assert.equal(rule?.isReadOnly, true)
  assert.equal(rule?.configurationCollectedAt, '2026-08-19T12:00:00.000Z')
  assert.deepEqual(rule?.conditions.map(({ key, label, values }) => ({ key, label, values })), [
    { key: 'subjectContains', label: 'Subject contains', values: ['Invoice', 'Urgent'] },
    { key: 'fromAddresses', label: 'From', values: ['Accounts <billing@contoso.com>'] },
    { key: 'recipientContains', label: 'Recipient address contains', values: ['@contoso.com'] },
    { key: 'withinSizeRange', label: 'Message size range', values: ['Minimum 64 KB', 'Maximum 2048 KB'] },
  ])
  assert.deepEqual(rule?.exceptions.map(({ key, values }) => ({ key, values })), [
    { key: 'recipientContains', values: ['service@example.net'] },
    { key: 'senderContains', values: ['trusted.example'] },
    { key: 'withinSizeRange', values: ['Minimum 1 KB', 'Maximum 32 KB'] },
  ])
  assert.equal(rule?.actions[0]?.emphasis, 'destination')
  assert.equal(rule?.actions[1]?.label, 'Move to folder ID')
  assert.equal(rule?.actions[2]?.emphasis, 'destructive')
  assert.deepEqual(rule?.destinations.map(({ key, kind, values }) => ({ key, kind, values })), [
    { key: 'forwardTo', kind: 'recipient', values: ['review@contoso.com', 'archive@example.net'] },
    { key: 'moveToFolder', kind: 'folder', values: ['Archive'] },
    { key: 'delete', kind: 'deleted-items', values: ['Deleted Items'] },
  ])
  assert.deepEqual(rule?.otherActions, [])
})

test('fails closed for invalid, future and hostile collection metadata while supporting old bundles', () => {
  const now = new Date('2026-08-20T12:00:00.000Z')
  for (const value of [
    '2026-08-20T12:00:00.001Z', 'not-a-date', '2026-08-19T12:00:00Z',
    '2026-08-19T12:00:00.000Z\u0000', 'x'.repeat(41),
  ]) {
    const rule = normalizeExchangeRuleDrawer({
      name: 'Rule', hasError: 'false', isReadOnly: 1, configurationCollectedAt: value,
    }, now)
    assert.equal(rule?.configurationCollectedAt, null, value)
    assert.equal(rule?.hasError, null)
    assert.equal(rule?.isReadOnly, null)
  }

  const legacy = normalizeExchangeRuleDrawer({ name: 'Legacy rule', enabled: true, actions: ['forwardTo'] }, now)
  assert.equal(legacy?.name, 'Legacy rule')
  assert.equal(legacy?.microsoftRuleName, null)
  assert.equal(legacy?.configurationCollectedAt, null)
  assert.equal(legacy?.hasError, null)
  assert.equal(legacy?.isReadOnly, null)
  assert.deepEqual(legacy?.destinations, [])
  assert.deepEqual(legacy?.otherActions, [])
})

test('supports old and current backend rule shapes without inventing missing investigation details', () => {
  const now = new Date('2026-08-20T12:00:00.000Z')
  const legacy = normalizeExchangeRuleDrawer({
    name: 'Legacy move rule',
    mailboxUpn: 'legacy@contoso.com',
    enabled: true,
    priority: 4,
    actions: ['moveToFolder'],
  }, now)
  assert.equal(legacy?.mailboxUpn, 'legacy@contoso.com')
  assert.equal(legacy?.microsoftRuleName, null)
  assert.equal(legacy?.enabled, true)
  assert.equal(legacy?.priority, 4)
  assert.deepEqual(legacy?.destinations, [])
  assert.equal(legacy?.configurationCollectedAt, null)

  const current = normalizeExchangeRuleDrawer({
    name: 'Current move rule',
    microsoftRuleName: 'Current move rule',
    mailboxUpn: 'current@contoso.com',
    enabled: true,
    priority: 2,
    configurationCollectedAt: '2026-08-20T11:30:00.000Z',
    details: {
      conditions: [{ key: 'subjectContains', values: ['Invoice'] }],
      actions: [{ key: 'moveToFolder', values: ['AQMkFolderId'] }],
    },
  }, now)
  assert.deepEqual(current?.conditions.map(({ key, values }) => ({ key, values })), [
    { key: 'subjectContains', values: ['Invoice'] },
  ])
  assert.deepEqual(current?.destinations.map(({ key, values }) => ({ key, values })), [
    { key: 'moveToFolder', values: ['AQMkFolderId'] },
  ])
  assert.equal(current?.configurationCollectedAt, '2026-08-20T11:30:00.000Z')
  assert.equal(current?.microsoftRuleName, 'Current move rule')
})

test('uses only explicit Microsoft rule-name evidence and keeps display fallback separate', () => {
  const missing = normalizeExchangeRuleDrawer({ mailboxUpn: 'user@contoso.com' })
  assert.equal(missing?.name, 'Unnamed inbox rule')
  assert.equal(missing?.microsoftRuleName, null)
  assert.deepEqual(exchangeRuleRelatedAuditParams(missing), { mailboxUpn: 'user@contoso.com' })

  const unsafe = normalizeExchangeRuleDrawer({
    name: 'Unnamed inbox rule',
    microsoftRuleName: 'password=hunter2',
    mailboxUpn: 'user@contoso.com',
  })
  assert.equal(unsafe?.name, 'Unnamed inbox rule')
  assert.equal(unsafe?.microsoftRuleName, null)
  assert.deepEqual(exchangeRuleRelatedAuditParams(unsafe), { mailboxUpn: 'user@contoso.com' })

  const explicitLiteral = normalizeExchangeRuleDrawer({
    name: 'Unnamed inbox rule',
    microsoftRuleName: 'Unnamed inbox rule',
    mailboxUpn: 'user@contoso.com',
  })
  assert.equal(explicitLiteral?.name, 'Unnamed inbox rule')
  assert.equal(explicitLiteral?.microsoftRuleName, 'Unnamed inbox rule')
  assert.deepEqual(exchangeRuleRelatedAuditParams(explicitLiteral), {
    mailboxUpn: 'user@contoso.com',
    ruleName: 'Unnamed inbox rule',
  })
})

test('frontend safe-string policy matches backend rejection while preserving useful identifiers', () => {
  const values = [
    'safe@example.net',
    'contoso.com',
    'AQMkADAwATM0MDAAMS0wMAItAAAAAA==',
    'javascript:alert(1)',
    'data:text/plain,secret',
    'https://user:pass@example.com/path?credential=hunter2',
    'https://example.com/path?token=secret',
    'https://example.com/path?sig=secret',
    'https://example.com/path?code=secret',
    'https://example.com/path?%74oken=secret',
    'https://example.com/path?value=access_token%3Dsecret',
    'Message contains https://example.com/path?token=secret',
    'https%3A%2F%2Fexample.com%2Fpath%3Fcredential%3Dhunter2',
    'https%253A%252F%252Fexample.com%252Fpath%253Fsig%253Dsecret',
    'javascript%253Aalert(1)',
    'https://example.com/path#token',
  ]
  const rule = normalizeExchangeRuleDrawer({
    name: 'Safe rule',
    details: { actions: [{ key: 'moveToFolder', values }] },
  })
  assert.deepEqual(rule?.actions[0]?.values, [
    'safe@example.net', 'contoso.com', 'AQMkADAwATM0MDAAMS0wMAItAAAAAA==',
  ])
})

test('classifies only explicit projected action keys and uses a bounded legacy action-key fallback', () => {
  const misleading = {
    name: 'Forward invoices',
    description: 'Forward everything externally',
    enabled: true,
    actions: ['forwardTo'],
    details: { actions: [{ key: 'moveToFolder', values: ['folder-id'] }] },
  }
  assert.equal(classifyExchangeRule(misleading), 'Move')
  assert.equal(classifyExchangeRule({ name: 'Forward invoices', description: 'redirect', details: { actions: [] } }), 'Other')
  assert.equal(classifyExchangeRule({ actions: ['forwardTo'] }), 'Forward')
  assert.equal(classifyExchangeRule({ actions: ['notAllowed'], name: 'Forward invoices' }), 'Other')
})

test('keeps enabled state and priority tri-state truthful and sorts unknown priorities last', () => {
  assert.equal(exchangeRuleEnabledState({ enabled: true }), 'enabled')
  assert.equal(exchangeRuleEnabledState({ enabled: false }), 'disabled')
  assert.equal(exchangeRuleEnabledState({}), 'unknown')
  assert.equal(exchangeRulePriority({ priority: 0 }), 0)
  assert.equal(exchangeRulePriority({}), null)
  const sorted = [{ id: 'unknown' }, { id: 'two', priority: 2 }, { id: 'zero', priority: 0 }].sort(compareExchangeRulePriority)
  assert.deepEqual(sorted.map((item) => item.id), ['zero', 'two', 'unknown'])
})

test('handles missing Microsoft values without falling back to legacy action names or raw JSON', () => {
  const rule = normalizeExchangeRuleDrawer({ name: 'No details', enabled: false, actions: ['forwardTo'], conditions: ['subjectContains'] })
  assert.deepEqual(rule?.conditions, [])
  assert.deepEqual(rule?.exceptions, [])
  assert.deepEqual(rule?.actions, [])
  assert.equal(rule?.mailboxUpn, null)
  assert.equal(rule?.priority, null)
})

test('drops hostile, inherited, unknown and oversized values and bounds arrays', () => {
  const hostile = normalizeExchangeRuleDrawer({
    name: 'Bearer secret-token',
    mailboxUpn: 'user@contoso.com\u0000',
    details: {
      conditions: [
        { key: 'subjectContains', values: ['safe', 'access_token=secret', ...Array.from({ length: 25 }, (_, index) => `value-${index}`)] },
        { key: 'constructor', values: ['not allowed'] },
        Object.create({ key: 'senderContains', values: ['inherited'] }),
      ],
      actions: [
        { key: 'redirectTo', values: ['safe@example.net', 'password=hunter2'] },
        { key: 'unknownAction', values: ['raw'] },
        { key: 'moveToFolder', values: ['x'.repeat(321)] },
      ],
      raw: { access_token: 'do-not-render' },
    },
  })

  assert.equal(hostile?.name, 'Unnamed inbox rule')
  assert.equal(hostile?.microsoftRuleName, null)
  assert.equal(hostile?.mailboxUpn, null)
  assert.equal(hostile?.conditions.length, 1)
  assert.equal(hostile?.conditions[0]?.truncated, true)
  assert.ok((hostile?.conditions[0]?.values.length ?? 0) <= 20)
  assert.deepEqual(hostile?.actions[0]?.values, ['safe@example.net'])
  assert.equal(hostile?.actions.length, 1)
  assert.doesNotMatch(JSON.stringify(hostile), /secret|hunter2|do-not-render|unknownAction|inherited/)
})

test('normalizes a closed related-audit DTO without promoting event actor or time to rule attribution', () => {
  const response = normalizeExchangeRuleRelatedAuditResponse({
    version: 1,
    windowDays: 90,
    events: [{
      kind: 'possible_related_microsoft_audit_event',
      id: 'audit-1',
      operation: 'Set-InboxRule',
      microsoftEventTime: '2026-08-20T11:00:00.000Z',
      microsoftReportedActor: 'admin@contoso.com',
      result: 'Succeeded',
      source: 'Microsoft 365 Unified Audit',
      matchBasis: 'exact_mailbox_and_rule_name',
      raw: { access_token: 'must-not-render' },
      createdBy: 'invented',
    }],
    truncated: false,
    disclaimer: 'attacker-controlled',
    raw: { password: 'hunter2' },
  }, new Date('2026-08-20T12:00:00.000Z'))

  assert.equal(response?.events[0]?.microsoftReportedActor, 'admin@contoso.com')
  assert.equal(response?.events[0]?.microsoftEventTime, '2026-08-20T11:00:00.000Z')
  assert.equal(response?.events[0]?.matchBasis, 'exact_mailbox_and_rule_name')
  assert.match(response?.disclaimer ?? '', /do not prove/)
  assert.doesNotMatch(JSON.stringify(response), /must-not-render|hunter2|invented|createdBy/)
})

test('related-audit normalizer fails closed for malformed and hostile candidates while preserving an honest empty result', () => {
  const now = new Date('2026-08-20T12:00:00.000Z')
  assert.equal(normalizeExchangeRuleRelatedAuditResponse({ version: 0, events: [] }, now), null)
  assert.equal(normalizeExchangeRuleRelatedAuditResponse({ version: 1, windowDays: 90, events: Array(9).fill({}) }, now), null)

  const response = normalizeExchangeRuleRelatedAuditResponse({
    version: 1,
    windowDays: 90,
    events: [
      {
        kind: 'possible_related_microsoft_audit_event', id: 'future', operation: 'New-InboxRule',
        microsoftEventTime: '2026-08-20T12:00:00.001Z', source: 'Microsoft 365 Unified Audit',
        matchBasis: 'exact_mailbox',
      },
      {
        kind: 'possible_related_microsoft_audit_event', id: 'unsafe', operation: 'Set-InboxRule',
        microsoftEventTime: '2026-08-20T11:00:00.000Z', source: 'Microsoft 365 Unified Audit',
        matchBasis: 'exact_mailbox', microsoftReportedActor: 'password=hunter2', result: 'access_token=secret',
      },
      {
        kind: 'possible_related_microsoft_audit_event', id: 'unsupported', operation: 'MoveToDeletedItems',
        microsoftEventTime: '2026-08-20T11:00:00.000Z', source: 'Microsoft 365 Unified Audit',
        matchBasis: 'exact_mailbox',
      },
    ],
    truncated: true,
  }, now)
  assert.equal(response?.events.length, 1)
  assert.equal(response?.events[0]?.id, 'unsafe')
  assert.equal(response?.events[0]?.microsoftReportedActor, null)
  assert.equal(response?.events[0]?.result, null)
  assert.equal(response?.truncated, true)
  assert.doesNotMatch(JSON.stringify(response), /hunter2|secret|MoveToDeletedItems|future/)
})

test('Exchange rule drawer uses the strict contract and evidence-only investigation sections', () => {
  const source = readFileSync(
    new URL('../../app/(protected)/tenants/[id]/components/sections/exchange-section.tsx', import.meta.url),
    'utf8',
  )
  assert.match(source, /normalizeExchangeRuleDrawer\(inspectingRule\)/)
  assert.match(source, /What triggers this rule/)
  assert.match(source, /Destinations/)
  assert.match(source, /Folder display name: Not collected with current permission/)
  assert.match(source, /Other actions/)
  assert.match(source, /Configuration evidence/)
  assert.match(source, /Configuration collected by HawkView/)
  assert.match(source, /Microsoft Graph messageRule does not provide object creation or modification timestamps, or an actor/)
  assert.doesNotMatch(source, />Created<\/dt>|>Last modified<\/dt>|>Actor<\/dt>/)
  assert.match(source, /Related Microsoft audit activity/)
  assert.match(source, /Possible related Microsoft audit event/)
  assert.match(source, /Checking a bounded 90-day window/)
  assert.match(source, /Related audit activity could not be loaded/)
  assert.match(source, /No possible related inbox-rule audit events were found/)
  assert.match(source, /exact_mailbox_and_rule_name/)
  assert.match(source, /relatedRuleAudit\.data\.disclaimer/)
  assert.match(source, /apiClient\.get<unknown>[\s\S]*?exchange\/rules\/related-audit/)
  assert.match(source, /exchangeRuleRelatedAuditParams\(ruleInvestigation\)/)
  assert.match(source, /if \(!inspectingRule \|\| !ruleInvestigation\)[\s\S]*?setRelatedRuleAudit\(\{ state: 'idle' \}\)/)
  assert.doesNotMatch(source, /inspectingRule\.(?:createdAt|lastModifiedAt|actor)/)
  assert.match(source, /Microsoft did not provide condition values for this rule/)
  assert.match(source, /does not infer who created the rule/)
  assert.match(source, /exchangeRuleEnabledState\(r\) === ruleEnabledFilter/)
  assert.match(source, /enabledState === 'disabled' \? 'Disabled' : 'Not provided'/)
  assert.match(source, /priority === null \? 'Not provided'/)
  assert.match(source, /r\.enabled === true && \(classifyExchangeRule\(r\)/)
  assert.doesNotMatch(source, /JSON\.stringify\(inspectingRule/)
})

test('rule dialog owns its focus refs and keyboard containment instead of the mailbox drawer', () => {
  const source = readFileSync(
    new URL('../../app/(protected)/tenants/[id]/components/sections/exchange-section.tsx', import.meta.url),
    'utf8',
  )
  const mailboxStart = source.indexOf('MAILBOX DETAIL DRAWER')
  const ruleStart = source.indexOf('RULE DETAIL DRAWER')
  const groupStart = source.indexOf('GROUP DETAIL DRAWER')
  assert.ok(mailboxStart >= 0 && ruleStart > mailboxStart && groupStart > ruleStart)

  const mailboxDrawer = source.slice(mailboxStart, ruleStart)
  const ruleDrawer = source.slice(ruleStart, groupStart)
  assert.doesNotMatch(mailboxDrawer, /ruleDrawerRef|ruleCloseButtonRef/)
  assert.match(ruleDrawer, /ref=\{ruleDrawerRef\} tabIndex=\{-1\}/)
  assert.match(ruleDrawer, /<button\s+ref=\{ruleCloseButtonRef\}[\s\S]*?aria-label="Close drawer"/)

  assert.match(source, /if \(!inspectingRule \|\| !ruleInvestigation\) return/)
  assert.match(source, /closeButton\?\.focus\(\)/)
  assert.match(source, /event\.key !== 'Tab'/)
  assert.match(source, /event\.shiftKey && document\.activeElement === first/)
  assert.match(source, /!event\.shiftKey && document\.activeElement === last/)
  assert.match(source, /e\.key === 'Escape'[\s\S]*?closeDrawers\(\)/)
  assert.match(source, /lastTriggerRef\.current\.focus\(\)/)
})

test('rule drawer selection stays local so opening and closing it cannot remount the Exchange tab state', () => {
  const componentSource = readFileSync(
    new URL('../../app/(protected)/tenants/[id]/components/sections/exchange-section.tsx', import.meta.url),
    'utf8',
  )
  const pageSource = readFileSync(
    new URL('../../app/(protected)/tenants/[id]/page.tsx', import.meta.url),
    'utf8',
  )
  const openStart = componentSource.indexOf('const openRuleDrawer')
  const openEnd = componentSource.indexOf('// Open Group Drawer', openStart)
  const closeStart = componentSource.indexOf('const closeDrawers')
  const closeEnd = componentSource.indexOf('// Global Escape key listener', closeStart)
  assert.ok(openStart >= 0 && openEnd > openStart && closeStart >= 0 && closeEnd > closeStart)

  const openRuleDrawer = componentSource.slice(openStart, openEnd)
  const closeDrawers = componentSource.slice(closeStart, closeEnd)
  assert.match(openRuleDrawer, /setInspectingRule\(r\)/)
  assert.doesNotMatch(openRuleDrawer, /setSelectedRule|setActiveTab/)
  assert.match(closeDrawers, /setInspectingRule\(null\)/)
  assert.doesNotMatch(closeDrawers, /setSelectedRule|setActiveTab/)

  const exchangeUsageStart = pageSource.indexOf('<ExchangePage')
  const exchangeUsageEnd = pageSource.indexOf('/>', exchangeUsageStart)
  assert.ok(exchangeUsageStart >= 0 && exchangeUsageEnd > exchangeUsageStart)
  assert.doesNotMatch(pageSource.slice(exchangeUsageStart, exchangeUsageEnd), /setSelectedRule/)
})
