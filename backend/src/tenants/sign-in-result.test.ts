import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
const ts = createRequire(new URL('../../../package.json', import.meta.url))('typescript')
import { canonicalSignInCode, signInResult, signInSource } from './sign-in-result.js'
import { reportedAuthenticationErrorCode } from './authentication-audit-projection.js'

const cases: Array<[unknown, string]> = [
  [null, 'Not reported'], [undefined, 'Not reported'], ['null', 'Not reported'],
  ['undefined', 'Not reported'], ['', 'Not reported'], ['  ', 'Not reported'],
  ['0', 'Success'], ['0 ', 'Not reported'], ['50126', 'Failure'],
  ['NaN', 'Not reported'], ['abc', 'Not reported'],
  [0, 'Success'], [50126, 'Failure'], ['00', 'Not reported'], [' 0 ', 'Not reported'],
  ['0.0', 'Not reported'], ['0\n', 'Not reported'], ['0\r\n', 'Not reported'],
  ['1e3', 'Not reported'], ['+0', 'Not reported'], ['-0', 'Not reported'],
  ['0x0', 'Not reported'], ['\t', 'Not reported'], ['1000000000', 'Failure'],
  ['2147483647', 'Failure'], [2147483647, 'Failure'], ['2147483648', 'Not reported'],
  [2147483648, 'Not reported'], [-1, 'Not reported'], [-2147483648, 'Not reported'], ['-2147483648', 'Not reported'], [-0, 'Not reported'], [0.5, 'Not reported'],
  [NaN, 'Not reported'], [Infinity, 'Not reported'], [false, 'Not reported'],
  [true, 'Not reported'], [[], 'Not reported'], [[0], 'Not reported'], [{}, 'Not reported'],
]
// Execute the actual checked-in writer/reader expressions, not copies. Full-service
// I/O is deliberately absent; tenant scope is separately asserted below.
function expression(file: string, property: string, contains: string) {
  const text = readFileSync(new URL(file, import.meta.url), 'utf8')
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true)
  const matches: string[] = []
  function visit(node: any) {
    if (ts.isPropertyAssignment(node) && node.name.getText(source) === property && node.initializer.getText(source).includes(contains)) matches.push(node.initializer.getText(source))
    ts.forEachChild(node, visit)
  }
  visit(source)
  assert.equal(matches.length, 1, `${file}:${property} must have one writer/reader`)
  return new Function('row', 'signIn', 'canonicalSignInCode', 'signInResult', `return (${matches[0]})`) as (...args: any[]) => any
}
const writer = expression('./tenant-sync.service.ts', 'statusErrorCode', 'row')
const bundle = expression('./tenant-sync.service.ts', 'result', 'signIn.statusErrorCode')
const changes = expression('../changes/changes.service.ts', 'result', 'signIn.statusErrorCode')
const write = (row: unknown) => writer(row, null, canonicalSignInCode, signInResult)
const read = (fn: typeof bundle, value: unknown) => fn(null, { statusErrorCode: value }, canonicalSignInCode, signInResult)

test('both wired serializers agree on eleven legacy classes and strict Int32 boundaries', () => {
  for (const [value, expected] of cases) {
    assert.equal(signInResult(value), expected)
    assert.equal(read(bundle, value), expected)
    assert.equal(read(changes, value), expected)
  }
})
test('actual writer validates raw types and composes with both readers without stringifying missing evidence', () => {
  for (const [value, expected] of cases) {
    const stored = write({ status: { errorCode: value } })
    assert.equal(stored, expected === 'Not reported' ? null : String(value))
    assert.equal(read(bundle, stored), expected)
    assert.equal(read(changes, stored), expected)
  }
  for (const row of [undefined, null, {}, { status: null }, { status: {} }]) assert.equal(write(row), null)
})
test('limited-audit ambiguity stays neutral through writer and both readers', () => {
  for (const record of [{}, { Operation: 'UserLoggedIn' }, { Operation: 'UserLoginFailed', LoginStatus: 0 },
    { Operation: 'UserLoggedIn', LoginStatus: 0, ErrorCode: 50126 }]) {
    const code = reportedAuthenticationErrorCode(record)
    assert.equal(code, null)
    for (const reader of [bundle, changes]) assert.equal(read(reader, write({ status: { errorCode: code } })), 'Not reported')
  }
  assert.equal(read(bundle, write({ status: { errorCode: reportedAuthenticationErrorCode({ Operation: 'UserLoggedIn', LoginStatus: 0 }) } })), 'Success')
})
test('source label follows recorded source, and serializers retain tenant-scoped queries', () => {
  assert.equal(signInSource({ hawkviewSource: 'MICROSOFT_365_MANAGEMENT_ACTIVITY' }), 'Microsoft 365 Management Activity')
  assert.equal(signInSource({}), 'Microsoft Graph auditLogs/signIns')
  // AST extraction would otherwise ignore these security-critical service guards.
  for (const [file, org] of [['./tenant-sync.service.ts', 'tenant.organizationId'], ['../changes/changes.service.ts', '{ in: organizationIds }']]) {
    const source = readFileSync(new URL(file, import.meta.url), 'utf8')
    const queries = [...source.matchAll(/this\.prisma\.signInLog\.findMany\(\{([\s\S]*?)orderBy/g)]
    assert.ok(queries.length)
    for (const query of queries) { assert.ok(query[1].includes(`organizationId: ${org}`)); assert.match(query[1], /customerTenantId:/) }
  }
})
