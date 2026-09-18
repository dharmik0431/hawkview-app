import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

function source(relativePath: string): string {
  return readFileSync(new URL(`../${relativePath}`, import.meta.url), 'utf8')
}

test('What Changed source exposes four summary categories with no sign-in filter path', () => {
  const summary = source('app/(protected)/what-changed/components/summary-strip.tsx')
  const table = source('app/(protected)/what-changed/components/table.tsx')
  const categoryKeys = Array.from(summary.matchAll(/key:\s*'([^']+)'/g), (match) => match[1])

  assert.deepEqual(categoryKeys, ['all', 'changes', 'highRisk', 'apps'])
  assert.match(summary, /SummaryCategoryKey = 'all' \| 'changes' \| 'highRisk' \| 'apps'/)
  assert.match(summary, /sm:grid-cols-4/)
  assert.doesNotMatch(summary, /Related sign-ins|LogIn|summary\.signIns|key:\s*'signIns'/)
  assert.doesNotMatch(table, /case 'signIns'|selectedCategory === 'signIns'|let signIns|isSignIn/)
  assert.match(table, /if \(e\.eventType === 'change'\)\s*\{\s*changes\+\+/)
  assert.match(table, /return \{ total, changes, highRisk, apps \}/)
})

test('summary removal preserves backend and dedicated sign-in contracts', () => {
  const changeTypes = source('app/(protected)/what-changed/data/change-types.ts')
  const activity = source('app/(protected)/activity/page.tsx')
  const changesService = source('backend/src/changes/changes.service.ts')
  const detailTests = source('backend/src/changes/change-evidence.service.test.ts')

  assert.match(changeTypes, /summary\?: \{ total: number; changes: number; signIns: number;/)
  assert.match(changeTypes, /signIns: summaryRecord\.signIns as number/)
  assert.match(changesService, /signIns:\s*0/)
  assert.match(changesService, /relatedSignIns/)
  assert.match(detailTests, /result\.relatedSignIns\.length, 1/)
  assert.match(activity, /useState<ActivityTab>\('signins'\)/)
  assert.match(activity, /id="activity-tab-signins"/)
})
