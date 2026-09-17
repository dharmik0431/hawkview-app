import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { createScanner } from 'typescript/unstable/ast/scanner'
import { LanguageVariant, SyntaxKind } from 'typescript/unstable/ast'

const root = fileURLToPath(new URL('../', import.meta.url))
const expected = [
  "alerts/alert-dispositions.database-integration.test.ts",
  "alerts/email-incident-context.database-integration.test.ts",
  "alerts/email-regular-release.database-integration.test.ts",
  "alerts/finding-pipeline.database-integration.test.ts",
  "alerts/in-app-visibility.database-integration.test.ts",
  "alerts/send-job-withdrawal.database-integration.test.ts",
  "alerts/send-store.database-integration.test.ts",
  "alerts/suppressed-evidence-reader.database-integration.test.ts",
  "alerts/suppression-store.database-integration.test.ts",
  "identity-risk/identity-risk-key.database-integration.test.ts",
  "identity-risk/native-alert-retention.database-integration.test.ts",
  "identity-risk/qa-security-events-never-zero.database-integration.test.ts",
  "identity-risk/risk-assessment-connected.database-integration.test.ts",
  "identity-risk/risk-attempt-causality.database-integration.test.ts",
  "identity-risk/risk-global-lifecycle.database-integration.test.ts",
  "identity-risk/risk-history-retention.database-integration.test.ts",
  "identity-risk/risk-key-operator.database-integration.test.ts",
  "identity-risk/risk-utc-session.database-integration.test.ts",
  "identity-risk/wrapped-risk-key.database-integration.test.ts",
  "prisma/alert-table-rls.database-integration.test.ts",
  "prisma/public-schema-lockdown.database-integration.test.ts",
  "risky-users-wiring/native-risk-summary.database-integration.test.ts",
  "risky-users-wiring/expired-native-finding-alert.database-integration.test.ts",
  "risky-users-wiring/native-alert-publication-lifecycle.database-integration.test.ts",
  "risky-users-wiring/native-finding-to-alert.database-integration.test.ts",
  "secrets/secret-store.database-integration.test.ts",
  "tenants/tenant-directory.database-integration.test.ts",
  "workspace/workspace-audit.database-integration.test.ts"
] as const

function integrationFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    if (entry.name === 'generated' || entry.name === 'node_modules') return []
    const path = join(directory, entry.name)
    return entry.isDirectory() ? integrationFiles(path)
      : entry.name.endsWith('.database-integration.test.ts') ? [path] : []
  })
}

type Token = { kind: SyntaxKind; value: string }

function tokens(text: string): Token[] {
  const scanner = createScanner(true, LanguageVariant.Standard, text)
  const result: Token[] = []
  const templates: number[] = []
  let canStartRegex = true
  for (;;) {
    let kind = scanner.scan()
    if (kind === SyntaxKind.EndOfFile) break
    if (kind === SyntaxKind.SlashToken && canStartRegex) kind = scanner.reScanSlashToken()
    if (kind === SyntaxKind.TemplateHead) templates.push(0)
    else if (templates.length && kind === SyntaxKind.OpenBraceToken) templates[templates.length - 1]! += 1
    else if (templates.length && kind === SyntaxKind.CloseBraceToken) {
      if (templates.at(-1) === 0) {
        kind = scanner.reScanTemplateToken(false)
        if (kind === SyntaxKind.TemplateTail) templates.pop()
      } else templates[templates.length - 1]! -= 1
    }
    result.push({ kind, value: [SyntaxKind.Identifier, SyntaxKind.StringLiteral].includes(kind)
      ? scanner.getTokenValue() : scanner.getTokenText() })
    canStartRegex = ![
      SyntaxKind.Identifier, SyntaxKind.StringLiteral, SyntaxKind.RegularExpressionLiteral,
      SyntaxKind.NoSubstitutionTemplateLiteral, SyntaxKind.TemplateTail, SyntaxKind.NumericLiteral,
      SyntaxKind.CloseParenToken, SyntaxKind.CloseBracketToken, SyntaxKind.CloseBraceToken,
    ].includes(kind)
  }
  return result
}

/**
 * Token-based structural inventory, not a complete parser or control-flow proof.
 * Fail closed on aliases used as values/declarations, rather than guessing binding scope.
 */
function hasImportedGuardCall(source: string): boolean {
  const list = tokens(source)
  const bindings = new Set<string>()
  const importTokens = new Set<number>()
  for (let index = 0; index < list.length; index += 1) {
    if (list[index]!.kind !== SyntaxKind.ImportKeyword || list[index + 1]?.value !== '{') continue
    const close = list.findIndex((token, position) => position > index && token.value === '}')
    if (close < 0 || list[close + 1]?.value !== 'from'
      || list[close + 2]?.kind !== SyntaxKind.StringLiteral
      || !list[close + 2]!.value.endsWith('/native-alert-test-database.js')) continue
    for (let position = index; position <= close + 2; position += 1) importTokens.add(position)
    for (let position = index + 2; position < close; position += 1) {
      const original = list[position]!
      if (original.kind !== SyntaxKind.Identifier
        || !['assertDisposableTestDatabase', 'assertDisposableNativeAlertDatabase'].includes(original.value)) continue
      if (list[position - 1]?.value === 'type') return false
      if (list[position + 1]?.value === 'as') {
        const alias = list[position + 2]
        if (alias?.kind !== SyntaxKind.Identifier) return false
        bindings.add(alias.value)
        position += 2
      } else bindings.add(original.value)
    }
  }
  let calls = 0
  for (let index = 0; index < list.length; index += 1) {
    const token = list[index]!
    if (importTokens.has(index) || token.kind !== SyntaxKind.Identifier || !bindings.has(token.value)) continue
    if (list[index + 1]?.value !== '(' || ['.', '?.', 'function', 'new'].includes(list[index - 1]?.value ?? '')) return false
    let depth = 0
    let close = index + 1
    for (; close < list.length; close += 1) {
      if (list[close]!.value === '(') depth += 1
      if (list[close]!.value === ')' && --depth < 0) return false
      if (list[close]!.value === ')' && depth === 0) break
    }
    if (close === list.length || list[close + 1]?.value === '{') return false
    calls += 1
  }
  return bindings.size > 0 && calls > 0
}

test('all database integration suites structurally import and invoke the shared boundary', () => {
  const files = integrationFiles(root).sort()
  assert.deepEqual(files.map(path => relative(root, path).replaceAll('\\', '/')).sort(), [...expected].sort())
  for (const path of files) {
    assert.ok(hasImportedGuardCall(readFileSync(path, 'utf8')),
      relative(root, path) + ': executable imported guard call required')
  }
})

test('inventory ignores comments and strings, refuses unused or wrong bindings, and supports aliases', () => {
  const imported = "import { assertDisposableTestDatabase as guard } from './native-alert-test-database.js';"
  assert.ok(hasImportedGuardCall(imported + 'guard()'))
  for (const source of [
    imported,
    imported + '// guard()',
    imported + '/* guard() */',
    imported + 'const label = "guard()"',
    imported + 'const label = `guard()`',
    imported + 'const label = `prefix ${1} guard()`',
    imported + 'const expression = /guard\\(\\)/',
    imported + 'assertDisposableTestDatabase()',
    imported + 'function inner(guard) { guard() }',
    imported + 'const object = { guard() {} }',
    'function assertDisposableTestDatabase() {} assertDisposableTestDatabase()',
    "import { guard } from './wrong-module.js'; guard()",
    "const text = \"import { assertDisposableTestDatabase } from './native-alert-test-database.js'; assertDisposableTestDatabase()\"",
  ]) assert.equal(hasImportedGuardCall(source), false)
})

test('all three native retention registrations skip without exact opt-in', () => {
  const list = tokens(readFileSync(join(root, 'identity-risk/native-alert-retention.database-integration.test.ts'), 'utf8'))
  let cases = 0
  for (let index = 0; index < list.length; index += 1) {
    if (list[index]!.kind !== SyntaxKind.Identifier || list[index]!.value !== 'test'
      || list[index + 1]?.value !== '(' || list[index + 2]?.kind !== SyntaxKind.StringLiteral
      || !list[index + 2]!.value.startsWith('native retention:')) continue
    cases += 1
    assert.deepEqual(list.slice(index + 3, index + 16).map(token => token.value), [
      ',', '{', 'skip', ':', 'process', '.', 'env', '.',
      'HAWKVIEW_RUN_DATABASE_INTEGRATION_TESTS', '!==', '1', '}', ',',
    ])
  }
  assert.equal(cases, 3)
})
