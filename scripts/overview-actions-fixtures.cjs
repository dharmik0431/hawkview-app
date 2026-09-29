// Synthetic source matrix using the real serializer projection and workspace derivation.
const fs = require('node:fs'),
  path = require('node:path'),
  ts = require('typescript')
const base = path.resolve(__dirname, '..'),
  cache = new Map()
function load(file) {
  if (cache.has(file)) return cache.get(file)
  const exports = {}
  cache.set(file, exports)
  const js = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: {
      jsx: ts.JsxEmit.ReactJSX,
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
  }).outputText
  new Function('require', 'exports', js)((name) => {
    if (!name.startsWith('.') && !name.startsWith('@/')) return require(name)
    const target = name.startsWith('@/')
      ? path.join(base, name.slice(2))
      : path.resolve(path.dirname(file), name)
    return load([target, target + '.tsx', target + '.ts'].find(fs.existsSync))
  }, exports)
  return exports
}
const { deriveTenantWorkspaceDisplay } = load(
  path.join(base, 'lib/tenant-workspace-state.ts')
)
const { projectSyncOutcome } = load(
  path.join(base, 'backend/src/tenants/sync-outcome-projection.ts')
)
const { TenantOverview } = load(
  path.join(base, 'app/(protected)/tenants/[id]/components/tenant-overview.tsx')
)
const sources = {
  users: 'USERS',
  licenses: 'LICENSES',
  domains: 'DOMAINS',
  groups: 'GROUPS',
  signIns: 'SIGN_INS',
  auditLogs: 'AUDIT_LOGS',
  m365Audit: 'M365_AUDIT',
  sharePointSites: 'SHAREPOINT_SITES',
  sharePointSettings: 'SHAREPOINT_SETTINGS',
  sharePointUsage: 'SHAREPOINT_USAGE',
  applications: 'APPLICATIONS',
  servicePrincipals: 'SERVICE_PRINCIPALS',
  securityDefaults: 'SECURITY_DEFAULTS',
  'exchange.mailboxes': 'EXCHANGE_MAILBOXES',
  'exchange.mailboxSettings': 'EXCHANGE_MAILBOX_SETTINGS',
  'exchange.mailboxUsage': 'EXCHANGE_MAILBOX_USAGE',
  'exchange.acceptedDomains': 'EXCHANGE_ACCEPTED_DOMAINS',
  'exchange.inboxRules': 'EXCHANGE_MAILBOX_RULES',
  'exchange.configuration': 'EXCHANGE_MAILBOX_CONFIGURATION',
}
const now = new Date('2026-09-29T12:00:00Z'),
  stamp = '2026-09-29T11:00:00.000Z'
function entry(resource, status = 'RUNNING', code = null) {
  return {
    status: status.toLowerCase(),
    lastSuccessfulAt: status === 'SUCCEEDED' ? stamp : null,
    lastError:
      status === 'FAILED'
        ? 'Synthetic permission diagnostic: read access was denied.'
        : null,
    outcomeProjection: projectSyncOutcome(
      resource,
      {
        status,
        lastSuccessfulAt: status === 'SUCCEEDED' ? new Date(stamp) : null,
        lastAttemptAt: new Date(stamp),
        lastErrorCode: code,
      },
      now
    ),
  }
}
function fixture(mode = 'all-unknown') {
  const bundle = {
    tenant: {
      id: 'synthetic-' + mode,
      name: 'Synthetic customer',
      status: 'connected',
    },
    users: [],
    signIns: [],
    sync: {},
    exchange: { sync: {} },
    sharepoint: {},
    teams: {},
  }
  for (const [key, resource] of Object.entries(sources)) {
    let status = 'RUNNING',
      code = null
    if (mode === 'mixed') {
      status = ['users', 'exchange.inboxRules'].includes(key)
        ? 'FAILED'
        : key === 'groups'
          ? 'QUEUED'
          : key === 'securityDefaults'
            ? 'IDLE'
            : ['licenses', 'domains'].includes(key)
              ? 'SUCCEEDED'
              : 'RUNNING'
      code =
        key === 'signIns'
          ? 'sign-ins-non-premium-fallback-active'
          : key === 'm365Audit'
            ? 'm365-audit-backlog'
            : null
    }
    const record = entry(resource, status, code)
    if (key.startsWith('exchange.')) bundle.exchange.sync[key.slice(9)] = record
    else bundle.sync[key] = record
  }
  const health =
    mode === 'mixed'
      ? {
          status: 'VERIFIED',
          items: [
            {
              key: 'sync-users',
              label: 'Review user collection permissions',
              why: 'Synthetic required collector failure.',
              severity: 'high',
            },
          ],
        }
      : { status: 'UNAVAILABLE', items: [] }
  const display = deriveTenantWorkspaceDisplay(
    bundle,
    mode === 'pending',
    null,
    health
  )
  return {
    bundle,
    display,
    onOpenModule: () => {},
    onSync: () => {},
    isSyncing: mode === 'pending',
  }
}
module.exports = {
  load,
  base,
  fixture,
  entry,
  deriveTenantWorkspaceDisplay,
  TenantOverview,
}
