import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import {
  classifyExchangeRule,
  compareExchangeRulePriority,
  exchangeRuleEnabledState,
  exchangeRulePriority,
  normalizeExchangeRuleDrawer,
} from './exchange-rule-drawer.ts'

test('normalizes internal and external forwarding plus multiple conditions and destinations', () => {
  const rule = normalizeExchangeRuleDrawer({
    name: 'Forward invoices', mailboxUpn: 'user@contoso.com', enabled: true, priority: 2,
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
  assert.equal(legacy?.configurationCollectedAt, null)
  assert.equal(legacy?.hasError, null)
  assert.equal(legacy?.isReadOnly, null)
  assert.deepEqual(legacy?.destinations, [])
  assert.deepEqual(legacy?.otherActions, [])
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
  assert.equal(hostile?.mailboxUpn, null)
  assert.equal(hostile?.conditions.length, 1)
  assert.equal(hostile?.conditions[0]?.truncated, true)
  assert.ok((hostile?.conditions[0]?.values.length ?? 0) <= 20)
  assert.deepEqual(hostile?.actions[0]?.values, ['safe@example.net'])
  assert.equal(hostile?.actions.length, 1)
  assert.doesNotMatch(JSON.stringify(hostile), /secret|hunter2|do-not-render|unknownAction|inherited/)
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
  assert.match(source, /Microsoft object history/)
  assert.match(source, /Created<\/dt><dd[^>]*>Not provided by Microsoft Graph/)
  assert.match(source, /Last modified<\/dt><dd[^>]*>Not provided by Microsoft Graph/)
  assert.match(source, /Actor<\/dt><dd[^>]*>Not provided by Microsoft Graph/)
  assert.match(source, /Configuration collected by HawkView/)
  assert.match(source, /does not correlate those events to this object or use them as its creation time or actor/)
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
