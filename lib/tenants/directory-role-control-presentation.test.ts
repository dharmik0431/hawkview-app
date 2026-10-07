/** Pure coverage of the decision layer: failure classification, whether a failed write proves no
 * apply, and the phase matrix. No React and no clock, so every lifecycle combination is exercised
 * directly rather than through a render that can only reach some of them. */
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, resolve as resolvePath } from 'node:path'
import test from 'node:test'

const nodeRequire = createRequire(import.meta.url)
const ts = nodeRequire('typescript')
const repoRoot = resolvePath(dirname(new URL(import.meta.url).pathname), '..', '..')

class ApiError extends Error {
  status: number
  constructor(status: number, message: string) { super(message); this.name = 'ApiError'; this.status = status }
}

/** Loads the shipped hook module for its PURE exports. React and react-query are stubbed because
 * nothing under test here touches them; the functions exercised are plain data in, data out. */
function compile(basePath: string): any {
  const file = [basePath, `${basePath}.ts`, `${basePath}.tsx`].find((c) => existsSync(c)) as string
  const { outputText } = ts.transpileModule(readFileSync(file, 'utf8'), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true,
    },
    fileName: file,
  })
  const moduleObject = { exports: {} as Record<string, any> }
  new Function('require', 'exports', 'module', outputText)(
    (s: string) => (s.startsWith('.') ? compile(resolvePath(dirname(file), s)) : nodeRequire(s)),
    moduleObject.exports, moduleObject)
  return moduleObject.exports
}

function loadPure() {
  const file = resolvePath(repoRoot, 'lib/api/directory-role-control-hooks.ts')
  const { outputText } = ts.transpileModule(readFileSync(file, 'utf8'), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true,
    },
    fileName: file,
  })
  const moduleObject = { exports: {} as Record<string, any> }
  const shim = (specifier: string) => {
    if (specifier === 'react') return { useState: () => [], useRef: () => ({}), useCallback: (f: any) => f }
    if (specifier === '@tanstack/react-query') {
      return { useQuery: () => ({}), useMutation: () => ({}), useQueryClient: () => ({}) }
    }
    if (specifier === './client') return { ApiError, apiClient: {} }
    // A React context provider: stubbed, because nothing under test here reads it.
    if (specifier === '@/components/providers/auth-provider') return { useAuth: () => ({}) }
    if (specifier === './pim-schedule-summary-hooks') return { isReadyDataScope: () => true }
    // The view module is real TypeScript the hook genuinely depends on, so compile it too rather
    // than stubbing the affordance rule this matrix is partly testing.
    if (specifier.startsWith('@/')) return compile(resolvePath(repoRoot, specifier.slice(2)))
    return nodeRequire(specifier)
  }
  new Function('require', 'exports', 'module', outputText)(shim, moduleObject.exports, moduleObject)
  return moduleObject.exports
}

const { classifyControlFailure, writeOutcomeOf, controlPresentation } = loadPure()

const EXPECTED = {
  configurationRevision: 'G', connectionIncarnation: 'C', scopeIncarnation: 'S',
  scopeVersion: 'directory-role-assignments/v1',
}
const CONTROL_OFF = { enabled: false, expected: { ...EXPECTED } }
const CONTROL_ON = { enabled: true, expected: { ...EXPECTED } }

const lifecycle = (o: Record<string, unknown> = {}) => ({
  control: CONTROL_OFF, isPending: false, isFetching: false, isReadError: false, readError: undefined,
  writeFailure: null, settledAt: null, dataUpdatedAt: 1_000, offered: true, ...o,
})

test('status mapping distinguishes read and write, and leaves the unknown unknown', () => {
  assert.equal(classifyControlFailure(new ApiError(403, 'x'), 'read'), 'forbidden')
  assert.equal(classifyControlFailure(new ApiError(403, 'x'), 'write'), 'forbidden')
  assert.equal(classifyControlFailure(new ApiError(409, 'x'), 'read'), 'unavailable')
  assert.equal(classifyControlFailure(new ApiError(409, 'x'), 'write'), 'conflict')
  assert.equal(classifyControlFailure(new ApiError(400, 'x'), 'write'), 'rejected')
  assert.equal(classifyControlFailure(new ApiError(400, 'x'), 'read'), 'error')
  assert.equal(classifyControlFailure(new ApiError(500, 'x'), 'write'), 'error')
  assert.equal(classifyControlFailure(new TypeError('socket closed'), 'write'), 'error')
  assert.equal(classifyControlFailure(undefined, 'write'), 'error')
})

test('only a pre-apply refusal proves the opt-in was not changed', () => {
  // These three are produced before the server commits, so they are evidence of no change.
  assert.equal(writeOutcomeOf('forbidden'), 'refused')
  assert.equal(writeOutcomeOf('conflict'), 'refused')
  assert.equal(writeOutcomeOf('rejected'), 'refused')
  // Everything else leaves the outcome genuinely unknown: this contract commits, THEN replies, so a
  // lost reply is indistinguishable from success. This is the v1 defect in one assertion.
  assert.equal(writeOutcomeOf('error'), 'unknown')
  assert.equal(writeOutcomeOf('unavailable'), 'unknown')
})

test('a confirmed current read is the only phase that may state the setting or offer an action', () => {
  const p = controlPresentation(lifecycle())
  assert.equal(p.phase, 'current')
  assert.equal(p.stateIsKnown, true)
  assert.equal(p.affordance.canEnable, true)
})

test('a first read in flight claims nothing', () => {
  const p = controlPresentation(lifecycle({ isPending: true, control: undefined }))
  assert.equal(p.phase, 'checking')
  assert.equal(p.stateIsKnown, false)
  assert.deepEqual(p.affordance, { canEnable: false, canDisable: false, eligibilityUnavailable: false })
})

test('cached data during a refetch is not current, and offers no action', () => {
  const p = controlPresentation(lifecycle({ isFetching: true }))
  assert.equal(p.phase, 'refreshing')
  assert.equal(p.stateIsKnown, false)
  assert.equal(p.affordance.canEnable, false)
  assert.equal(p.isRefreshing, true)
})

test('cached data retained across a FAILED refetch is not current either', () => {
  // The exact v1 defect: TanStack keeps `data` and reports isError with isPending false.
  const p = controlPresentation(lifecycle({ isReadError: true, readError: new ApiError(500, 'x') }))
  assert.equal(p.phase, 'read-failed')
  assert.equal(p.stateIsKnown, false)
  assert.equal(p.affordance.canDisable, false)
  assert.equal(p.readFailure, 'error')
})

test('an unresolved write outranks the cached answer that predates it', () => {
  const unknown = controlPresentation(lifecycle({ settledAt: 2_000, writeFailure: 'error' }))
  assert.equal(unknown.phase, 'unresolved')
  assert.equal(unknown.stateIsKnown, false)

  const refused = controlPresentation(lifecycle({ settledAt: 2_000, writeFailure: 'conflict' }))
  assert.equal(refused.phase, 'refused')
  assert.equal(refused.stateIsKnown, false)
  assert.equal(refused.affordance.canEnable, false, 'the refused context is gone; re-read first')
})

test('the outcome stays named while a refresh runs, instead of hiding behind a spinner', () => {
  const p = controlPresentation(lifecycle({ settledAt: 2_000, writeFailure: 'error', isFetching: true }))
  assert.equal(p.phase, 'unresolved', 'the reason must not be replaced by "refreshing"')
  assert.equal(p.isRefreshing, true, 'and the refresh is reported alongside it')
})

test('only a read accepted AFTER the write resolves it', () => {
  const stale = controlPresentation(lifecycle({ settledAt: 2_000, dataUpdatedAt: 1_999 }))
  assert.equal(stale.phase, 'unresolved', 'a read that predates the write cannot describe it')

  const fresh = controlPresentation(lifecycle({ settledAt: 2_000, dataUpdatedAt: 2_001 }))
  assert.equal(fresh.phase, 'current')
  assert.equal(fresh.stateIsKnown, true)

  const tie = controlPresentation(lifecycle({ settledAt: 2_000, dataUpdatedAt: 2_000 }))
  assert.equal(tie.phase, 'unresolved',
    'a same-millisecond tie is not proof the read came after; stay unresolved')
})

test('a read in flight after a write never resolves it, whatever its timestamp says', () => {
  const p = controlPresentation(lifecycle({ settledAt: 2_000, dataUpdatedAt: 3_000, isFetching: true }))
  assert.equal(p.stateIsKnown, false)
})

test('an unpermitted viewer is offered nothing and told no state', () => {
  const p = controlPresentation(lifecycle({ offered: false, control: CONTROL_ON }))
  assert.equal(p.stateIsKnown, false)
  assert.deepEqual(p.affordance, { canEnable: false, canDisable: false, eligibilityUnavailable: false })
})

test('a confirmed enabled read keeps disable available with no configuration or connection', () => {
  const p = controlPresentation(lifecycle({
    control: {
      enabled: true,
      expected: { configurationRevision: null, connectionIncarnation: null, scopeIncarnation: null, scopeVersion: null },
    },
  }))
  assert.equal(p.phase, 'current')
  assert.equal(p.affordance.canDisable, true)
  assert.equal(p.affordance.canEnable, false)
})
