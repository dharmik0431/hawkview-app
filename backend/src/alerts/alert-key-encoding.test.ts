import assert from 'node:assert/strict'
import test from 'node:test'
import { joinUnambiguously } from './alert-key-encoding.js'

/** The encoding that stops one tuple forging another's key. */

test('a component containing the separator cannot move a boundary', () => {
  // The cross-tenant collision, stated as the pair that must not collide.
  assert.notEqual(joinUnambiguously(['x:y', 'z']), joinUnambiguously(['x', 'y:z']))
})

test('a component that looks like a length prefix cannot fake one', () => {
  assert.notEqual(joinUnambiguously(['2:ab', 'c']), joinUnambiguously(['2', 'abc']))
  assert.notEqual(joinUnambiguously(['10:x']), joinUnambiguously(['10', 'x']))
})

test('arity and order are part of the encoding', () => {
  // Splitting or merging components must change the key, or a two-field tuple
  // could impersonate a three-field one.
  assert.notEqual(joinUnambiguously(['ab']), joinUnambiguously(['a', 'b']))
  assert.notEqual(joinUnambiguously(['a', 'b']), joinUnambiguously(['b', 'a']))
  assert.notEqual(joinUnambiguously(['a', 'b']), joinUnambiguously(['a', 'b', '']))
})

test('an empty component is distinguishable from an absent one', () => {
  // A tenant id that arrives empty must not encode as though the field were not
  // there — that is a whole field silently dropping out of a key.
  assert.notEqual(joinUnambiguously(['a', '', 'b']), joinUnambiguously(['a', 'b']))
  assert.notEqual(joinUnambiguously(['', 'ab']), joinUnambiguously(['ab', '']))
})

test('non-ASCII components are delimited by the same measure they are written in', () => {
  // The length prefix and a decoder's slice must agree. They do, because both are
  // UTF-16 code units — but only if nothing counts characters instead.
  const emoji = '🔐'
  assert.equal(emoji.length, 2)
  assert.equal(joinUnambiguously([emoji]), `2:${emoji}`)
  // And it still discriminates: the surrogate pair is not interchangeable with
  // two unrelated characters, nor with a shorter tuple.
  assert.notEqual(joinUnambiguously([emoji, 'a']), joinUnambiguously(['ab', 'a']))
  assert.notEqual(joinUnambiguously(['Ärendehantering', 'x']), joinUnambiguously(['Ärendehantering', 'y']))
})

test('the encoding is a function: same input, same key', () => {
  // A key that varied run to run would deduplicate nothing at all.
  assert.equal(joinUnambiguously(['a', 'b', 'c']), joinUnambiguously(['a', 'b', 'c']))
  assert.equal(joinUnambiguously([]), '')
})

test('THE SEPARATOR IS LOAD-BEARING, not decoration', () => {
  // Dropping it leaves `${len}${part}`, which still looks unambiguous and is not:
  // the length digits and a component's leading digits become indistinguishable
  // once a length reaches two digits. Found by exhaustive search over digit
  // strings, which is the only way this pair was going to turn up — it is not
  // reachable by thinking of an example.
  const many = ['1', '1', '1', '1', '1', '11']
  const one = ['11111111211']
  const withoutSeparator = (parts: readonly string[]) =>
    parts.map((part) => `${part.length}${part}`).join('')

  assert.equal(withoutSeparator(many), withoutSeparator(one),
    'two distinct tuples collide once the separator is removed')
  assert.equal(withoutSeparator(one), '1111111111211')

  // The shipped encoding keeps them apart, which is the whole reason for the ':'.
  assert.notEqual(joinUnambiguously(many), joinUnambiguously(one))
})
