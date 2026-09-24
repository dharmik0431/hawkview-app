import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import test from 'node:test'
import { parseFrontendBuildIdentity } from './frontend-build-identity.ts'

const require = createRequire(import.meta.url)
const { frontendSourceHash, frontendSourceDependencies, createFrontendBuildIdentity, resolveFrontendBuildIdentity, BUILD_CONTEXT_KEY } = require('../../scripts/frontend-build-identity.cjs')
const phases = require('next/constants')
const at = new Date('2026-09-23T12:00:00.000Z')
const requiredFiles = ['package.json', 'package-lock.json', 'next.config.js', 'tsconfig.json',
  'tailwind.config.ts', 'postcss.config.js', 'scripts/frontend-build-identity.cjs']
function put(root: string, file: string, value = 'synthetic') {
  const full = join(root, file)
  mkdirSync(join(full, '..'), { recursive: true })
  writeFileSync(full, value)
}
function fixture(t: { after: (fn: () => void) => void }, reverse = false) {
  const root = mkdtempSync(join(tmpdir(), 'hawkview-build-identity-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const files = [...requiredFiles, 'app/page.tsx', 'components/example.tsx', 'lib/example.ts', 'types/example.ts', 'public/icon.svg']
  for (const file of reverse ? files.reverse() : files) put(root, file, `synthetic:${file}`)
  return root
}

test('Gitless fingerprint is independent of traversal order, location, mtime and build clock', (t) => {
  const a = fixture(t), b = fixture(t, true)
  utimesSync(join(b, 'app/page.tsx'), at, at)
  assert.match(frontendSourceHash(a), /^[a-f0-9]{64}$/)
  assert.equal(frontendSourceHash(a), frontendSourceHash(b))
  const first = createFrontendBuildIdentity(a, at)
  const later = createFrontendBuildIdentity(a, new Date(at.getTime() + 60_000))
  assert.equal(first.sourceHash, later.sourceHash)
  assert.notEqual(first.builtAt, later.builtAt)
  assert.ok(Object.isFrozen(first))
})

test('source, configuration, lockfile, assets and generator changes alter identity', (t) => {
  const root = fixture(t)
  for (const file of ['app/page.tsx', 'next.config.js', 'package-lock.json', 'public/icon.svg', 'scripts/frontend-build-identity.cjs']) {
    const previous = frontendSourceHash(root)
    put(root, file, `changed:${file}`)
    assert.notEqual(frontendSourceHash(root), previous, file)
  }
  for (const file of ['public/help.pdf', 'public/demo.mp4', 'public/robots.txt', 'public/future.asset']) {
    const previous = frontendSourceHash(root)
    put(root, file, `public:${file}`)
    assert.notEqual(frontendSourceHash(root), previous, file)
  }
})

test('nested environment/private files, outputs, Git, backend and unrelated personal files never enter fingerprint', (t) => {
  const root = fixture(t), expected = frontendSourceHash(root)
  for (const file of ['.env', '.git/HEAD', '.next/server.js', '.tools/report.json', 'node_modules/package/index.js',
    'backend/src/changed.ts', 'Personal Document.pdf', 'lib/nested/.env.local', 'public/private/key.json',
    'components/secrets/token.ts', 'lib/nested/credentials.json', 'public/.hidden/token.json', 'lib/photo.pdf']) put(root, file, 'must-not-be-hashed')
  assert.equal(frontendSourceHash(root), expected)
})

test('file/directory/build-script symlinks are refused without following escapes or cycles', (t) => {
  for (const target of ['lib/link.ts', 'public/link', 'scripts/frontend-build-identity.cjs']) {
    const root = fixture(t)
    if (target.startsWith('scripts/')) rmSync(join(root, target))
    symlinkSync(root, join(root, target))
    assert.throws(() => frontendSourceHash(root), /symlink/)
  }
})

test('missing required directories/files and invalid clock fail production generation', (t) => {
  const root = fixture(t)
  assert.throws(() => createFrontendBuildIdentity(root, new Date(NaN)), /clock/)
  rmSync(join(root, 'package-lock.json'))
  assert.throws(() => frontendSourceHash(root))
  const second = fixture(t)
  rmSync(join(second, 'public'), { recursive: true })
  assert.throws(() => frontendSourceHash(second))
})

test('Next config preserves production context and wires source-dependent timestamp-free dev compilation', (t) => {
  const root = fixture(t)
  const configModule = { exports: undefined as any }
  let calls = 0
  const environment = {}
  new Function('require', 'module', '__dirname', readFileSync(new URL('../../next.config.js', import.meta.url), 'utf8'))(
    (name: string) => {
      if (name === 'next/constants') return phases
      assert.equal(name, './scripts/frontend-build-identity.cjs')
      return { frontendSourceHash, frontendSourceDependencies, resolveFrontendBuildIdentity: (received: string) => {
        assert.equal(received, root); calls++; return resolveFrontendBuildIdentity(root, environment, at)
      } }
    }, configModule, root)
  const config = configModule.exports
  assert.equal(config(phases.PHASE_PRODUCTION_SERVER).env, undefined)
  assert.equal(calls, 0)
  const devConfig = config(phases.PHASE_DEVELOPMENT_SERVER)
  assert.equal(devConfig.env, undefined, 'no competing NEXT_PUBLIC declaration for source identity')
  class DefinePlugin {
    readonly definitions: Record<string, any>
    constructor(definitions: Record<string, any>) { this.definitions = definitions }
    static runtimeValue(fn: () => string, options: Record<string, any>) { return { fn, options } }
  }
  const compilation = devConfig.webpack({ plugins: [] }, { dev: true, webpack: { DefinePlugin } })
  const runtime = compilation.plugins[0].definitions.__HAWKVIEW_SOURCE_IDENTITY__
  const read = () => JSON.parse(JSON.parse(runtime.fn()))
  assert.deepEqual(read(), { kind: 'source', sourceHash: frontendSourceHash(root), builtAt: null })
  assert.ok(runtime.options.fileDependencies.includes(join(root, 'app/page.tsx')))
  assert.ok(runtime.options.contextDependencies.includes(join(root, 'public')))
  const before = read().sourceHash
  put(root, 'public/new/nested.asset', 'new public asset')
  assert.notEqual(read().sourceHash, before)
  assert.equal(runtime.options.version(), read().sourceHash)
  rmSync(join(root, 'public/new'), { recursive: true })
  assert.equal(read().sourceHash, before)
  put(root, 'app/.env.local', 'not a version input')
  assert.equal(read().sourceHash, before)
  assert.equal(devConfig.webpack({ plugins: [] }, { dev: false, webpack: { DefinePlugin } }).plugins.length, 0)
  assert.equal(calls, 0)
  const first = config(phases.PHASE_PRODUCTION_BUILD)
  assert.equal(first.output, 'standalone')
  assert.equal(first.reactStrictMode, true)
  assert.equal(config(phases.PHASE_PRODUCTION_BUILD).env.NEXT_PUBLIC_HAWKVIEW_BUILD_IDENTITY, first.env.NEXT_PUBLIC_HAWKVIEW_BUILD_IDENTITY)
  assert.equal(calls, 2)
  assert.equal(config(phases.PHASE_PRODUCTION_SERVER).env, undefined)
  assert.equal(calls, 2)
  assert.equal(parseFrontendBuildIdentity(first.env.NEXT_PUBLIC_HAWKVIEW_BUILD_IDENTITY).kind, 'build')
})

test('separate build workers inherit one timestamp; separate builds may have a new timestamp', (t) => {
  const root = fixture(t)
  const environment: Record<string, string> = {}
  const parent = resolveFrontendBuildIdentity(root, environment, at)
  const child = JSON.parse(execFileSync(process.execPath, ['-e',
    'const generator=require(process.argv[1]); console.log(JSON.stringify(generator.resolveFrontendBuildIdentity(process.argv[2])))',
    require.resolve('../../scripts/frontend-build-identity.cjs'), root], { env: { ...environment, NODE_ENV: 'test' }, encoding: 'utf8' }))
  assert.deepEqual(child, parent)
  assert.deepEqual(resolveFrontendBuildIdentity(root, { ...environment }, new Date(at.getTime() + 60_000)), parent)
  assert.notEqual(resolveFrontendBuildIdentity(root, {}, new Date(at.getTime() + 60_000)).builtAt, parent.builtAt)
})

test('inherited contexts cannot silently reuse a different root/source or malformed metadata', (t) => {
  const root = fixture(t), other = fixture(t)
  const environment: Record<string, string> = {}
  resolveFrontendBuildIdentity(root, environment, at)
  assert.throws(() => resolveFrontendBuildIdentity(other, environment), /context/)
  assert.throws(() => resolveFrontendBuildIdentity(root, { [BUILD_CONTEXT_KEY]: 'bad' }), /context/)
  put(root, 'app/page.tsx', 'changed while building')
  assert.throws(() => resolveFrontendBuildIdentity(root, environment), /stable source/)
})

test('public metadata parser rejects malformed, extra-field and misleading provenance without runtime fallback', () => {
  const valid = { kind: 'build', sourceHash: 'a'.repeat(64), builtAt: at.toISOString() }
  assert.deepEqual(parseFrontendBuildIdentity(JSON.stringify(valid)), valid)
  assert.deepEqual(parseFrontendBuildIdentity(JSON.stringify({ ...valid, kind: 'source', builtAt: null })), { ...valid, kind: 'source', builtAt: null })
  assert.equal(parseFrontendBuildIdentity(JSON.stringify({ kind: 'development', sourceHash: null, builtAt: null })).kind, 'development')
  for (const value of [undefined, '', 'null', '[]', '{}', 'x'.repeat(513),
    JSON.stringify({ ...valid, sourceHash: 'a'.repeat(12) }), JSON.stringify({ ...valid, builtAt: 'yesterday' }),
    JSON.stringify({ ...valid, builtAt: '2026-09-23T12:00:00Z' }), JSON.stringify({ ...valid, revision: 'claimed' }),
    JSON.stringify({ ...valid, kind: 'source' }),
    JSON.stringify({ kind: 'development', sourceHash: valid.sourceHash, builtAt: null }),
    '{"__proto__":{},"kind":"build","sourceHash":"fake","builtAt":null}']) {
    assert.deepEqual(parseFrontendBuildIdentity(value), { kind: 'unavailable', sourceHash: null, builtAt: null })
  }
})
