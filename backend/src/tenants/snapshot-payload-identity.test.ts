import assert from 'node:assert/strict'
import test from 'node:test'
import { identicalSnapshotDocument, SNAPSHOT_IDENTITY_LIMITS } from './snapshot-payload-identity.js'

const limits = SNAPSHOT_IDENTITY_LIMITS

/** Recursively freeze, so any write during comparison throws instead of
 *  silently mutating a caller's document. */
function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child)
    Object.freeze(value)
  }
  return value
}

test('identical supported documents compare equal', () => {
  const stored = [{ id: 'group-1', displayName: 'Group One', securityEnabled: true, visibility: null }]
  const candidate = [{ id: 'group-1', displayName: 'Group One', securityEnabled: true, visibility: null }]
  assert.equal(identicalSnapshotDocument(deepFreeze(stored), deepFreeze(candidate)), true)
})

test('object key order is ignored because jsonb normalises it', () => {
  const stored = [{ a: 'one', b: 'two', nested: { x: 'x', y: 'y' } }]
  const candidate = [{ nested: { y: 'y', x: 'x' }, b: 'two', a: 'one' }]
  assert.equal(identicalSnapshotDocument(deepFreeze(stored), deepFreeze(candidate)), true)
})

test('empty and nested-empty containers compare equal', () => {
  assert.equal(identicalSnapshotDocument([], []), true)
  assert.equal(identicalSnapshotDocument([{ a: [], b: {} }], [{ b: {}, a: [] }]), true)
})

test('array order and length are significant', () => {
  assert.equal(identicalSnapshotDocument(['a', 'b'], ['b', 'a']), false)
  assert.equal(identicalSnapshotDocument(['a', 'b'], ['a', 'b', 'c']), false)
  assert.equal(identicalSnapshotDocument([['a', 'b']], [['b', 'a']]), false)
})

test('a changed value anywhere compares unequal', () => {
  assert.equal(identicalSnapshotDocument([{ a: 'one' }], [{ a: 'two' }]), false)
  assert.equal(identicalSnapshotDocument([{ a: { b: 'one' } }], [{ a: { b: 'two' } }]), false)
  assert.equal(identicalSnapshotDocument([{ a: true }], [{ a: false }]), false)
})

test('exact own-key sets are required', () => {
  assert.equal(identicalSnapshotDocument([{ a: 'one' }], [{ a: 'one', b: 'two' }]), false)
  assert.equal(identicalSnapshotDocument([{ a: 'one', b: 'two' }], [{ a: 'one' }]), false)
})

test('null, missing and undefined are three different things, none of them equal', () => {
  assert.equal(identicalSnapshotDocument([{ a: null }], [{}]), false)
  assert.equal(identicalSnapshotDocument([{}], [{ a: null }]), false)
  assert.equal(identicalSnapshotDocument([{ a: null }], [{ a: undefined }]), false)
  assert.equal(identicalSnapshotDocument([{ a: undefined }], [{ a: undefined }]), false)
  assert.equal(identicalSnapshotDocument([{ a: undefined }], [{}]), false)
  assert.equal(identicalSnapshotDocument([null], [null]), true)
})

test('every number refuses comparison in this slice, however safe it looks', () => {
  for (const value of [0, -0, 1, 42, -7, 0.5, 1e21, Number.MAX_SAFE_INTEGER, 9007199254740992, Infinity, -Infinity, NaN]) {
    assert.equal(identicalSnapshotDocument([value], [value]), false, `top level ${String(value)}`)
    assert.equal(identicalSnapshotDocument([{ a: value }], [{ a: value }]), false, `in object ${String(value)}`)
    assert.equal(identicalSnapshotDocument([[value]], [[value]]), false, `in array ${String(value)}`)
    assert.equal(identicalSnapshotDocument([{ a: { b: [value] } }], [{ a: { b: [value] } }]), false, `nested ${String(value)}`)
  }
  // A number on one side only is likewise refused, never coerced.
  assert.equal(identicalSnapshotDocument([1], ['1']), false)
  assert.equal(identicalSnapshotDocument(['1'], [1]), false)
  assert.equal(identicalSnapshotDocument([0], [false]), false)
  assert.equal(identicalSnapshotDocument([0], [null]), false)
})

test('no same-reference shortcut: one document compared with itself still refuses a number', () => {
  const withNumber = deepFreeze([{ id: 'a', count: 3 }])
  assert.equal(identicalSnapshotDocument(withNumber, withNumber), false)
  const supported = deepFreeze([{ id: 'a', name: 'n' }])
  assert.equal(identicalSnapshotDocument(supported, supported), true)
})

test('sparse arrays and arrays carrying extra own properties are refused', () => {
  const sparse: unknown[] = ['a']
  sparse.length = 2
  assert.equal(identicalSnapshotDocument(sparse, ['a', undefined]), false)
  assert.equal(identicalSnapshotDocument(sparse, sparse), false)
  const decorated: unknown[] = ['a']
  ;(decorated as unknown as Record<string, unknown>).extra = 'x'
  assert.equal(identicalSnapshotDocument(decorated, ['a']), false)
  assert.equal(identicalSnapshotDocument(['a'], decorated), false)
})

test('unsupported value types are refused rather than coerced', () => {
  const sameDate = new Date('2026-01-01T00:00:00.000Z')
  assert.equal(identicalSnapshotDocument([sameDate], [sameDate]), false)
  assert.equal(identicalSnapshotDocument([new Map()], [new Map()]), false)
  assert.equal(identicalSnapshotDocument([() => 'x'], [() => 'x']), false)
  assert.equal(identicalSnapshotDocument([Symbol.for('s')], [Symbol.for('s')]), false)
  assert.equal(identicalSnapshotDocument([10n], [10n]), false)
  class Row { constructor(readonly id: string) {} }
  assert.equal(identicalSnapshotDocument([new Row('a')], [new Row('a')]), false)
  assert.equal(identicalSnapshotDocument([{ id: 'a' }], [new Row('a')]), false)
  // A custom serialiser must not be trusted to agree with this traversal.
  const withToJson = { id: 'a', toJSON: () => ({ id: 'a' }) }
  assert.equal(identicalSnapshotDocument([withToJson], [{ id: 'a' }]), false)
  // A null-prototype object is ordinary JSON and is accepted.
  const bare = Object.assign(Object.create(null) as Record<string, unknown>, { id: 'a' })
  assert.equal(identicalSnapshotDocument([bare], [{ id: 'a' }]), true)
})

test('accessors are refused even when they would read equal', () => {
  const stored = [{ id: 'a' }]
  const candidate: Record<string, unknown>[] = [{}]
  Object.defineProperty(candidate[0]!, 'id', { get: () => 'a', enumerable: true, configurable: true })
  assert.equal(identicalSnapshotDocument(stored, candidate), false)
  assert.equal(identicalSnapshotDocument(candidate, stored), false)
  // A non-enumerable own property is refused by the same key-set rule.
  const hidden: Record<string, unknown> = { id: 'a' }
  Object.defineProperty(hidden, 'shadow', { value: 'x', enumerable: false })
  assert.equal(identicalSnapshotDocument([hidden], [{ id: 'a' }]), true)
})

test('a cycle terminates at the depth bound and is refused', () => {
  const cyclic: Record<string, unknown> = { id: 'a' }
  cyclic.self = cyclic
  assert.equal(identicalSnapshotDocument([cyclic], [cyclic]), false)
})

test('a throwing accessor is caught and refused, never raised to the caller', () => {
  const hostile: Record<string, unknown> = {}
  Object.defineProperty(hostile, 'id', {
    get() { throw new Error('hostile getter') }, enumerable: true, configurable: true,
  })
  assert.equal(identicalSnapshotDocument([hostile], [{ id: 'a' }]), false)
  const trapped = new Proxy({ id: 'a' }, { ownKeys() { throw new Error('hostile trap') } })
  assert.equal(identicalSnapshotDocument([trapped], [{ id: 'a' }]), false)
})

test('only array-rooted documents are considered', () => {
  assert.equal(identicalSnapshotDocument({ a: 'one' }, { a: 'one' }), false)
  assert.equal(identicalSnapshotDocument('a', 'a'), false)
  assert.equal(identicalSnapshotDocument(null, null), false)
  assert.equal(identicalSnapshotDocument(undefined, undefined), false)
  assert.equal(identicalSnapshotDocument([], {}), false)
})

test('the depth bound is exact', () => {
  const nest = (levels: number): unknown => {
    let value: unknown = 'leaf'
    for (let index = 0; index < levels; index += 1) value = { down: value }
    return value
  }
  // The root document is depth 0, so the deepest value inspected sits at
  // depth `maxDepth`. `nest(n)` puts its object levels at depths 1..n and its
  // leaf string at depth n+1, so n = maxDepth - 1 is the last accepted shape.
  assert.equal(identicalSnapshotDocument([nest(limits.maxDepth - 1)], [nest(limits.maxDepth - 1)]), true)
  assert.equal(identicalSnapshotDocument([nest(limits.maxDepth)], [nest(limits.maxDepth)]), false)
  assert.equal(identicalSnapshotDocument([nest(limits.maxDepth + 5)], [nest(limits.maxDepth + 5)]), false)
})

test('the object key bound is exact', () => {
  const object = (count: number) => {
    const row: Record<string, unknown> = {}
    for (let index = 0; index < count; index += 1) row[`k${index}`] = 'v'
    return row
  }
  assert.equal(identicalSnapshotDocument([object(limits.maxObjectKeys)], [object(limits.maxObjectKeys)]), true)
  assert.equal(identicalSnapshotDocument([object(limits.maxObjectKeys + 1)], [object(limits.maxObjectKeys + 1)]), false)
})

test('the array length bound is exact', () => {
  const dense = (count: number) => new Array<string>(count).fill('v')
  assert.equal(identicalSnapshotDocument(dense(limits.maxArrayLength), dense(limits.maxArrayLength)), true)
  assert.equal(identicalSnapshotDocument(dense(limits.maxArrayLength + 1), dense(limits.maxArrayLength + 1)), false)
})

test('the inspected-character bound is exact', () => {
  const fits = 'x'.repeat(limits.maxInspectedCharacters)
  assert.equal(identicalSnapshotDocument([fits], [fits]), true)
  const exceeds = `${fits}x`
  assert.equal(identicalSnapshotDocument([exceeds], [exceeds]), false)
})

test('an exhausted aggregate budget refuses instead of failing', () => {
  // Many small rows: equal in content, but beyond the aggregate inspection
  // budget, so the answer is "write" rather than an exception.
  const wide = () => new Array(limits.maxArrayLength).fill(0).map(() => ({ a: 'v', b: 'v' }))
  const stored = [wide(), wide(), wide(), wide(), wide(), wide()]
  const candidate = [wide(), wide(), wide(), wide(), wide(), wide()]
  assert.equal(identicalSnapshotDocument(stored, candidate), false)
})

test('comparison does not mutate either document', () => {
  const stored = [{ id: 'a', tags: ['x', 'y'], nested: { k: 'v' } }]
  const candidate = [{ nested: { k: 'v' }, tags: ['x', 'y'], id: 'a' }]
  const storedBefore = JSON.stringify(stored)
  const candidateBefore = JSON.stringify(candidate)
  assert.equal(identicalSnapshotDocument(deepFreeze(stored), deepFreeze(candidate)), true)
  assert.equal(JSON.stringify(stored), storedBefore)
  assert.equal(JSON.stringify(candidate), candidateBefore)
})

test('the published bounds are the ones the module enforces', () => {
  assert.deepEqual(limits, {
    maxDepth: 12, maxNodes: 1_000_000, maxInspectedKeys: 1_000_000,
    maxInspectedCharacters: 16 * 1024 * 1024, maxObjectKeys: 100, maxArrayLength: 50_000,
  })
  assert.equal(Object.isFrozen(limits), true)
})

// ---------------------------------------------------------------------------
// Serialization-boundary regressions. Each of these returned true before the
// correction while `JSON.stringify` would have produced a different document,
// so the omission branch would have skipped a real change.
// ---------------------------------------------------------------------------

test('a hidden own toJSON on a nested object is refused, and never invoked', () => {
  let invoked = 0
  const stored = [{ value: 'old' }]
  const candidate: Record<string, unknown>[] = [{ value: 'old' }]
  Object.defineProperty(candidate[0]!, 'toJSON', {
    value: () => { invoked += 1; return { value: 'new' } }, enumerable: false, configurable: true,
  })
  assert.equal(identicalSnapshotDocument(stored, candidate), false)
  assert.equal(identicalSnapshotDocument(candidate, stored), false)
  assert.equal(invoked, 0, 'the hook must be detected without being called')
  // The hook really would have changed the document, which is why this matters.
  assert.notEqual(JSON.stringify(candidate), JSON.stringify(stored))
})

test('a hidden own toJSON on the document array itself is refused', () => {
  let invoked = 0
  const stored = [{ value: 'old' }]
  const candidate: unknown[] = [{ value: 'old' }]
  Object.defineProperty(candidate, 'toJSON', {
    value: () => { invoked += 1; return [{ value: 'different' }] }, enumerable: false, configurable: true,
  })
  assert.equal(identicalSnapshotDocument(stored, candidate), false)
  assert.equal(invoked, 0)
  assert.notEqual(JSON.stringify(candidate), JSON.stringify(stored))
})

test('an array subclass with an inherited toJSON is refused despite Array.isArray', () => {
  let invoked = 0
  class Rows extends Array { toJSON() { invoked += 1; return [{ value: 'subclass' }] } }
  const candidate = new Rows()
  candidate.push({ value: 'old' })
  assert.equal(Array.isArray(candidate), true, 'the subclass really does pass Array.isArray')
  assert.equal(identicalSnapshotDocument([{ value: 'old' }], candidate), false)
  assert.equal(invoked, 0)
  assert.notEqual(JSON.stringify(candidate), JSON.stringify([{ value: 'old' }]))
})

test('an inherited toJSON on Object.prototype is refused, and the fixture is restored', () => {
  const original = Object.getOwnPropertyDescriptor(Object.prototype, 'toJSON')
  assert.equal(original, undefined, 'the fixture only applies to an unpolluted prototype')
  let invoked = 0
  try {
    Object.defineProperty(Object.prototype, 'toJSON', {
      value: () => { invoked += 1; return { value: 'polluted' } },
      enumerable: false, configurable: true, writable: true,
    })
    assert.equal(identicalSnapshotDocument([{ value: 'old' }], [{ value: 'old' }]), false)
    assert.equal(invoked, 0)
  } finally {
    delete (Object.prototype as unknown as Record<string, unknown>).toJSON
  }
  assert.equal(Object.getOwnPropertyDescriptor(Object.prototype, 'toJSON'), undefined,
    'the prototype must be restored deterministically')
  // And the ordinary answer is back.
  assert.equal(identicalSnapshotDocument([{ value: 'old' }], [{ value: 'old' }]), true)
})

test('a revoked Proxy is refused without throwing, at the root and nested', () => {
  const rootRevocable = Proxy.revocable([{ value: 'old' }], {})
  rootRevocable.revoke()
  // Array.isArray alone throws on this value, which is why the guard has to
  // sit inside the boundary.
  assert.throws(() => Array.isArray(rootRevocable.proxy), TypeError)
  assert.equal(identicalSnapshotDocument(rootRevocable.proxy, [{ value: 'old' }]), false)
  assert.equal(identicalSnapshotDocument([{ value: 'old' }], rootRevocable.proxy), false)
  const nestedRevocable = Proxy.revocable({ value: 'old' }, {})
  nestedRevocable.revoke()
  assert.equal(identicalSnapshotDocument([{ value: 'old' }], [nestedRevocable.proxy]), false)
})

test('a live Proxy is refused before any trap runs, at the root and nested', () => {
  const traps: string[] = []
  const watcher: ProxyHandler<object> = {
    get(target, key, receiver) { traps.push(`get:${String(key)}`); return Reflect.get(target, key, receiver) },
    ownKeys(target) { traps.push('ownKeys'); return Reflect.ownKeys(target) },
    has(target, key) { traps.push(`has:${String(key)}`); return Reflect.has(target, key) },
    getOwnPropertyDescriptor(target, key) {
      traps.push(`descriptor:${String(key)}`); return Reflect.getOwnPropertyDescriptor(target, key)
    },
  }
  const rootProxy = new Proxy([{ value: 'old' }], watcher)
  assert.equal(identicalSnapshotDocument([{ value: 'old' }], rootProxy), false)
  const nestedProxy = new Proxy({ value: 'old' }, watcher)
  assert.equal(identicalSnapshotDocument([{ value: 'old' }], [nestedProxy]), false)
  assert.deepEqual(traps, [], 'no trap may be consulted for a value that is refused')
})

test('an ordinary hidden data property remains equal, which is the stated exception', () => {
  const hidden: Record<string, unknown> = { id: 'a' }
  Object.defineProperty(hidden, 'shadow', { value: 'x', enumerable: false })
  assert.equal(identicalSnapshotDocument([hidden], [{ id: 'a' }]), true)
  assert.equal(JSON.stringify([hidden]), JSON.stringify([{ id: 'a' }]),
    'because it cannot reach the serialized document')
})

test('key characters are charged against the same budget as string values', () => {
  // One key whose name alone exceeds the character budget.
  const oversizedKey = 'k'.repeat(limits.maxInspectedCharacters + 1)
  assert.equal(identicalSnapshotDocument([{ [oversizedKey]: 'v' }], [{ [oversizedKey]: 'v' }]), false)
  // Many ordinary rows whose key names together exceed it, where every value is
  // short: before the correction only values were counted, so this was true.
  const keyName = 'k'.repeat(8000)
  const wide = () => Array.from({ length: 60 }, () => {
    const row: Record<string, unknown> = {}
    for (let index = 0; index < limits.maxObjectKeys; index += 1) row[`${keyName}${index}`] = 'v'
    return row
  })
  assert.equal(identicalSnapshotDocument(wide(), wide()), false)
  // A document whose key characters stay inside the budget still compares.
  const modest = () => [{ [`${'k'.repeat(64)}a`]: 'v', [`${'k'.repeat(64)}b`]: 'v' }]
  assert.equal(identicalSnapshotDocument(modest(), modest()), true)
})

test('a throwing toJSON is refused by detection, not by catching its throw', () => {
  const hostile: Record<string, unknown> = { value: 'old' }
  Object.defineProperty(hostile, 'toJSON', {
    value: () => { throw new Error('hostile toJSON') }, enumerable: false, configurable: true,
  })
  assert.equal(identicalSnapshotDocument([{ value: 'old' }], [hostile]), false)
  // Proof the hook would have thrown had anything invoked it.
  assert.throws(() => JSON.stringify(hostile), /hostile toJSON/)
})
