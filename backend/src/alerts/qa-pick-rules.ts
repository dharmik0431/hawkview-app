import { IDENTITY_RISK_RULE_CATALOG } from '../identity-risk/identity-risk.catalog.js'
import { alertTypeForRule } from './finding-pipeline.js'
import { ALERT_CATALOG } from './alert-catalog.js'
const out: Record<string, string[]> = {}
for (const id of Object.keys(IDENTITY_RISK_RULE_CATALOG)) {
  const t = alertTypeForRule(id) ?? 'UNMAPPED'
  ;(out[t] ??= []).push(id)
}
const sev = Object.fromEntries(ALERT_CATALOG.map((t) => [t.id, t.severity]))
console.log(JSON.stringify({ mappedTypes: Object.fromEntries(Object.entries(out).map(([k, v]) => [k, { count: v.length, example: v[0] }])), severityByType: sev }, null, 2))
