import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import test from 'node:test'
const require = createRequire(import.meta.url)
const React = require('react'),
  { renderToStaticMarkup } = require('react-dom/server'),
  { JSDOM } = require('jsdom')
const {
  fixture,
  entry,
  deriveTenantWorkspaceDisplay,
  TenantOverview,
} = require('../scripts/overview-actions-fixtures.cjs')
const verified = { status: 'VERIFIED', items: [] }
function data(sync: any) {
  const { bundle } = fixture('mixed')
  bundle.sync = sync
  bundle.exchange = {}
  return bundle
}
function rendered(bundle: any, health: any = verified, context?: any) {
  const display = deriveTenantWorkspaceDisplay(
    bundle,
    false,
    null,
    health,
    context
  )
  const dom = new JSDOM(
    renderToStaticMarkup(
      React.createElement(TenantOverview, {
        bundle,
        display,
        onOpenModule: () => {},
      })
    )
  )
  return {
    display,
    document: dom.window.document,
    text: dom.window.document.body.textContent,
  }
}
test('silent verified health cannot hide explicit failed or partial collection, diagnostics retained for details', () => {
  for (const status of ['FAILED', 'PARTIAL']) {
    const bundle = data({ users: entry('USERS', status) })
    const { display, document, text } = rendered(bundle)
    assert.equal(display.issueCount, 1)
    assert.equal(display.issues[0].id, 'sync-users')
    assert.match(text, /1 actionable issue|Active issues \(1\)/)
    assert.match(text, /User collection needs review/)
    assert.doesNotMatch(
      text,
      /No actionable issues reported|0 actionable issues|Resolve issue|Retry sync/
    )
    assert.equal(
      document.querySelector('[aria-label="Recorded synchronization results"]'),
      null
    )
    assert.equal(document.querySelector('details'), null)
    assert.match(
      display.issues[0].technicalDetails,
      /Recorded|recorded|not verified/
    )
  }
})
test('source-key dedup preserves authoritative wording and adds recorded diagnostic once', () => {
  const bundle = data({
    users: entry('USERS', 'FAILED'),
    'exchange.inboxRules': entry('EXCHANGE_MAILBOX_RULES', 'FAILED'),
  })
  const health = {
    status: 'VERIFIED',
    items: [
      {
        key: 'sync-users',
        label: 'Authoritative users finding',
        why: 'Backend evidence',
        severity: 'high',
        actionLabel: 'Review evidence',
      },
      {
        key: 'sync-exchange_mailbox_rules',
        label: 'Authoritative inbox rule finding',
        why: 'Backend evidence',
        severity: 'high',
      },
    ],
  }
  const { display } = rendered(bundle, health)
  assert.equal(display.issueCount, 2)
  assert.equal(display.issues[0].title, 'Authoritative users finding')
  assert.equal(display.issues[0].action, 'Review evidence')
  assert.match(
    display.issues[0].technicalDetails,
    /Synthetic permission diagnostic/
  )
  assert.match(
    display.issues[1].technicalDetails,
    /Synthetic permission diagnostic/
  )
})
test('optional permission opt-outs and nonapplicable sources do not become fresh incidents', () => {
  const bundle = data({
    sharePointSettings: entry('SHAREPOINT_SETTINGS', 'FAILED'),
  })
  for (const row of [
    {
      resourceType: 'SHAREPOINT_SETTINGS',
      required: false,
      classification: 'PERMISSION_REQUIRED',
    },
    {
      resourceType: 'SHAREPOINT_SETTINGS',
      required: true,
      classification: 'UNSUPPORTED',
    },
    {
      resourceType: 'SHAREPOINT_SETTINGS',
      required: false,
      classification: 'NOT_LICENSED',
    },
  ]) {
    const { display, text } = rendered(bundle, verified, {
      resourceHealth: [row],
    })
    assert.equal(display.issueCount, 0)
    assert.notEqual(display.state, 'healthy')
    assert.notEqual(display.state, 'needs-attention')
    assert.doesNotMatch(
      text,
      /collection needs review|Resolve issue|No actionable issues reported/
    )
  }
  const context = {
    readiness: {
      workloads: [
        {
          datasets: [
            {
              resourceTypes: ['SHAREPOINT_SETTINGS'],
              tier: 'CAPABILITY_OPTIONAL',
              state: 'BLOCKED_PERMISSION',
              permissionStatus: 'MISSING',
            },
          ],
        },
      ],
    },
  }
  assert.equal(rendered(bundle, verified, context).display.issueCount, 0)
  assert.equal(
    rendered(bundle, verified, {
      resourceHealth: [
        {
          resourceType: 'SHAREPOINT_SETTINGS',
          required: false,
          classification: 'FAILED',
        },
      ],
    }).display.issueCount,
    1
  )
})
test('unknown, queued and limited capability evidence never become invented incidents or healthy reassurance', () => {
  for (const status of ['RUNNING', 'QUEUED', 'IDLE']) {
    const { display, text } = rendered(data({ users: entry('USERS', status) }))
    assert.equal(display.issueCount, 0)
    assert.notEqual(display.state, 'healthy')
    assert.doesNotMatch(
      text,
      /No actionable issues reported|Resolve issue|collection needs review|Recorded synchronization results/
    )
  }
  const bundle = data({ signIns: entry('SIGN_INS', 'FAILED') })
  const selected = {
    availability: 'CURRENT_LIMITED',
    coverage: 'LIMITED',
    selectedSource: 'OFFICE_365_ACTIVITY_FEED',
    observedAt: '2026-09-29T11:00:00Z',
    reasonCode: 'SIGN_IN_FALLBACK_ACTIVE',
    reason: 'Selected current evidence',
  }
  const view = deriveTenantWorkspaceDisplay(bundle, false, selected, verified)
  assert.equal(view.issueCount, 0)
  assert.equal(view.state, 'partially-synchronized')
  assert.equal(view.syncObservations[0].diagnostic, 'Selected current evidence')
  const success = data({
    users: {
      ...entry('USERS', 'SUCCEEDED'),
      lastError: 'Old retained diagnostic',
    },
  })
  assert.equal(rendered(success).display.issueCount, 0)
  assert.equal(rendered(success).display.state, 'healthy')
})
test('nineteen sources produce no overview collector inventory, pending and initial messages survive', () => {
  for (const mode of ['all-unknown', 'mixed', 'pending']) {
    const props = fixture(mode)
    const html = renderToStaticMarkup(
      React.createElement(TenantOverview, props)
    )
    const doc = new JSDOM(html).window.document
    assert.equal(
      doc.querySelector('[aria-label="Recorded synchronization results"]'),
      null
    )
    assert.doesNotMatch(
      doc.body.textContent,
      /View 19|source details|successful records|exchange\.mailboxSettings|recorded results above|shown separately/
    )
    if (mode === 'pending') {
      assert.match(doc.body.textContent, /Synchronization request pending/)
      assert.match(doc.body.textContent, /Initial collection is incomplete/)
    }
  }
})
