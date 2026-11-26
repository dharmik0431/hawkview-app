import { types } from 'node:util'

/**
 * Conservative structural identity for stored Entra snapshot documents.
 *
 * `identicalSnapshotDocument(stored, candidate)` answers one narrow question:
 * would re-storing `candidate` leave the stored `jsonb` value unchanged? Only a
 * proven `true` lets a writer omit the document from its request. Every other
 * input returns `false`, which keeps the existing full write, and no input makes
 * this throw: a collection must never fail because an optimisation could not
 * decide.
 *
 * Why the round trip is the whole argument. The stored side arrives as
 * `decode(stored)` and the write would store `encode(candidate)`, so omitting
 * the document is sound only where `encode(decode(x))` is `x`. On strings,
 * booleans, null, arrays and plain objects it is: `jsonb` normalises object key
 * order and collapses duplicate keys, which is exactly why object key order is
 * ignored here while array order and array density are not.
 *
 * Why every number returns false in this first slice. `jsonb` numbers are
 * arbitrary-precision `numeric`, and JavaScript decodes them into doubles, so
 * for numbers that round trip is NOT the identity. A stored 9007199254740993
 * decodes to 9007199254740992, and a stored 1e400 or a long fraction cannot be
 * recovered at all. Equality of the decoded doubles therefore does not
 * establish database equality, and a safe-integer test cannot restore precision
 * that decoding has already discarded -- including the case where a stored
 * fractional value rounds to an integer that then looks safe. Accepting numbers
 * needs a separate proven exact-representation design; until then a document
 * containing any number anywhere keeps today's behaviour. This deliberately
 * limits how often the omission applies, in exchange for an argument that holds
 * without trusting the decoder.
 *
 * The serialization contract this enforces. Comparing the values a traversal
 * reads is only equivalent to comparing what would be written if serialization
 * reads the same things. `JSON.stringify` consults exactly one hook, `toJSON`,
 * and it does not care whether that property is enumerable or inherited, so a
 * container carrying one is refused outright -- never invoked -- as is an array
 * that is not an ordinary array and an object whose prototype is neither
 * `Object.prototype` nor null. A Proxy is refused before anything is read
 * through it, because nothing a trap reports during this comparison is bound to
 * what a trap will report during serialization. An ordinary hidden property is
 * a deliberate exception: a non-enumerable data property other than `toJSON`
 * cannot reach the serialized document, so it does not make two otherwise equal
 * documents unequal.
 */

/** Deepest nesting inspected, counting the root document as depth 0: the
 *  deepest value compared therefore sits at depth `MAX_DEPTH`. A cycle is
 *  refused by reaching this bound, so no visited set has to be allocated in
 *  order to terminate. */
const MAX_DEPTH = 12
/** Values inspected across the whole pair. */
const MAX_NODES = 1_000_000
/** Own keys and property descriptors inspected across the whole pair. */
const MAX_INSPECTED_KEYS = 1_000_000
/** Characters compared across the whole pair, counting both string values and
 *  the key names inspected on either side. */
const MAX_INSPECTED_CHARACTERS = 16 * 1024 * 1024
/** Own keys allowed on one object. */
const MAX_OBJECT_KEYS = 100
/** Elements allowed in one array. */
const MAX_ARRAY_LENGTH = 50_000

/**
 * What the counters do and do not bound.
 *
 * These are internal limits on this comparison alone. They are not a
 * collection, provider or quota limit, nothing upstream is required to have
 * satisfied them, and exhausting any of them returns `false` -- keeping the
 * existing full write -- rather than failing a collection. Their values are
 * chosen to match the bounds `mailbox-source-attestation.ts` already applies to
 * documents of this kind; that is a precedent for the sizes, not a claim that
 * every snapshot document has already passed through those checks, because only
 * the two Exchange resources reach that function.
 *
 * An array's `length` is read before its keys are enumerated, so
 * `MAX_ARRAY_LENGTH` does bound that enumeration. An object's key count cannot
 * be known without enumerating it, so `Object.keys` allocates first and
 * `MAX_OBJECT_KEYS` is enforced immediately afterwards: it bounds every
 * subsequent step for that object rather than the one allocation that revealed
 * its size, and the node budget bounds how many objects are enumerated at all.
 * Auxiliary allocation is therefore bounded per container and across the
 * traversal, but it is not zero.
 */
export const SNAPSHOT_IDENTITY_LIMITS = Object.freeze({
  maxDepth: MAX_DEPTH,
  maxNodes: MAX_NODES,
  maxInspectedKeys: MAX_INSPECTED_KEYS,
  maxInspectedCharacters: MAX_INSPECTED_CHARACTERS,
  maxObjectKeys: MAX_OBJECT_KEYS,
  maxArrayLength: MAX_ARRAY_LENGTH,
})

/** The single mutable allocation of a comparison: three descending counters. */
type InspectionBudget = { nodes: number; keys: number; characters: number }

/**
 * A value refused before anything at all is read from it.
 *
 * `types.isProxy` answers without invoking a single trap and answers for a
 * revoked Proxy too, which is why it has to come before every other test: even
 * `Array.isArray` throws on a revoked Proxy.
 */
function refusedObject(value: unknown): boolean {
  return value !== null && typeof value === 'object' && types.isProxy(value)
}

/** True when serialization would call a hook instead of reading the value as
 *  data. `in` covers an own property whether or not it is enumerable, and an
 *  inherited one, without invoking it. */
function serializationHook(value: object): boolean {
  return 'toJSON' in value
}

/** Exactly an ordinary array: not a subclass, and carrying no serialization
 *  hook of its own or inherited. `Array.isArray` is true for subclasses, so the
 *  prototype test is what excludes them. */
function ordinaryArray(value: readonly unknown[]): boolean {
  return Object.getPrototypeOf(value) === Array.prototype && !serializationHook(value)
}

/** Only an ordinary JSON object. A class instance, Date or Map serialises
 *  differently, and anything carrying `toJSON` is refused without calling it. */
function plainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype: unknown = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) return false
  return !serializationHook(value)
}

/** An own, enumerable, plain data property: what serialisation would read
 *  without invoking anything, and what a second read cannot change. An
 *  accessor, a non-enumerable property or an absent one all return false. */
function plainDataProperty(container: object, key: string | number): boolean {
  const descriptor = Object.getOwnPropertyDescriptor(container, key)
  return descriptor !== undefined && descriptor.enumerable === true && 'value' in descriptor
}

function sameArray(
  left: readonly unknown[], right: readonly unknown[], depth: number, budget: InspectionBudget,
): boolean {
  const length = left.length
  // Length is read before either enumeration, so the cap bounds both of them.
  if (length !== right.length || length > MAX_ARRAY_LENGTH) return false
  // Density and own-key exactness, deliberately stricter than serialisation
  // requires: a hole, or any extra own enumerable property, makes this a
  // JavaScript value that no `jsonb` decode produces, so refuse it rather than
  // rely on what `JSON.stringify` happens to drop.
  const leftKeys = Object.keys(left).length
  const rightKeys = Object.keys(right).length
  budget.keys -= leftKeys + rightKeys
  if (budget.keys < 0) return false
  if (leftKeys !== length || rightKeys !== length) return false
  for (let index = 0; index < length; index += 1) {
    budget.keys -= 2
    if (budget.keys < 0) return false
    if (!plainDataProperty(left, index) || !plainDataProperty(right, index)) return false
    if (!sameValue(left[index], right[index], depth + 1, budget)) return false
  }
  return true
}

function samePlainObject(
  left: Record<string, unknown>, right: Record<string, unknown>, depth: number, budget: InspectionBudget,
): boolean {
  const leftKeys = Object.keys(left)
  const rightKeys = Object.keys(right)
  budget.keys -= leftKeys.length + rightKeys.length
  if (budget.keys < 0) return false
  if (leftKeys.length !== rightKeys.length) return false
  if (leftKeys.length > MAX_OBJECT_KEYS) return false
  // Equal counts plus "every left key is an own enumerable data property of
  // right" gives set equality without sorting or copying either key list.
  for (const key of leftKeys) {
    // Key names are compared characters too, so they are charged like values.
    budget.characters -= key.length
    budget.keys -= 2
    if (budget.characters < 0 || budget.keys < 0) return false
    if (!plainDataProperty(left, key) || !plainDataProperty(right, key)) return false
    if (!sameValue(left[key], right[key], depth + 1, budget)) return false
  }
  return true
}

function sameValue(left: unknown, right: unknown, depth: number, budget: InspectionBudget): boolean {
  if (depth > MAX_DEPTH) return false
  budget.nodes -= 1
  if (budget.nodes < 0) return false
  // Refuse a Proxy before reading anything, including its shape.
  if (refusedObject(left) || refusedObject(right)) return false
  // No same-reference shortcut. `mergeWithPrevious` may hand back the very
  // array decoded from the stored row, and that still proves nothing about a
  // number inside it, so every value is inspected on its own terms.
  if (typeof left === 'number' || typeof right === 'number') return false
  if (typeof left === 'string') {
    budget.characters -= left.length
    if (budget.characters < 0) return false
    return left === right
  }
  if (typeof left === 'boolean' || left === null) return left === right
  if (Array.isArray(left)) {
    return Array.isArray(right) && ordinaryArray(left) && ordinaryArray(right) &&
      sameArray(left, right, depth, budget)
  }
  if (plainObject(left)) return plainObject(right) && samePlainObject(left, right, depth, budget)
  // undefined, symbol, bigint, function, and every exotic object.
  return false
}

/**
 * True only when `candidate` would store exactly the `jsonb` value that
 * `stored` already holds. Both sides must be ordinary array documents, which is
 * the only shape the snapshot writer stores. Never throws and never mutates
 * either input; a Proxy, a serialization hook, a throwing accessor, a stack
 * bound or an exhausted budget all answer false, which keeps the existing full
 * write.
 */
export function identicalSnapshotDocument(stored: unknown, candidate: unknown): boolean {
  try {
    // Every check sits inside this boundary. `Array.isArray` throws on a
    // revoked Proxy, so even the root shape test has to be guarded, and the
    // Proxy refusal has to precede it.
    if (refusedObject(stored) || refusedObject(candidate)) return false
    if (!Array.isArray(stored) || !Array.isArray(candidate)) return false
    return sameValue(stored, candidate, 0, {
      nodes: MAX_NODES, keys: MAX_INSPECTED_KEYS, characters: MAX_INSPECTED_CHARACTERS,
    })
  } catch {
    return false
  }
}
