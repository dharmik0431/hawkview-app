import assert from 'node:assert/strict'
import { test } from 'node:test'
import { exchangeMailboxRow, mergeExchangeMailboxRows } from './tenant-sync.service.js'

/**
 * A PARTIAL PAYLOAD MUST NOT OVERWRITE STORED VALUES — AND AN EXPLICIT NULL MUST STILL CLEAR.
 *
 * NOT A RESPONSE TO OBSERVED DATA LOSS, and the framing is binding. Microsoft documents that
 * default user delta responses RETAIN previously-set selected properties; omission is the opt-in
 * `Prefer: return=minimal` mode, and nothing in this codebase sends that header — searched for,
 * not assumed. So this is robustness against a partial payload arriving for some other reason —
 * a truncated response, an API change, a replayed fixture — and it must not be described as
 * confirmed customer data loss.
 *
 * The characterisation these replace (at `0f02ccf`) found that ABSENT and EXPLICITLY NULL
 * reached the same stored value, so "I am not telling you about this" and "this is empty" were
 * indistinguishable afterwards. **The improvement is worthless if the fix collapses them the
 * other way**, so the clearing direction is tested as hard as the preserving one.
 */

const STORED = {
  id: 'user-1',
  displayName: 'Ada Lovelace',
  userPrincipalName: 'ada@example.invalid',
  mail: 'ada@example.invalid',
  proxyAddresses: ['smtp:ada@example.invalid'],
  accountEnabled: false,
}
const round = (user: unknown, previous: readonly unknown[] = [STORED]) =>
  mergeExchangeMailboxRows(previous, [exchangeMailboxRow(user)])[0] as Record<string, unknown>

test('ABSENT properties inherit the stored values', async () => {
  // The defect, inverted. accountEnabled absent used to become TRUE -- the opposite of the
  // stored false -- and proxyAddresses absent became [], a claim that there are none.
  const { accountEnabled, proxyAddresses, displayName, ...partial } = STORED
  const merged = round(partial)

  assert.equal(merged.accountEnabled, false, 'an absent accountEnabled overwrote a stored false')
  assert.deepEqual(merged.proxyAddresses, ['smtp:ada@example.invalid'])
  assert.equal(merged.displayName, 'Ada Lovelace')
})

test('an EXPLICIT null still clears, which is the half a careless fix would lose', async () => {
  // The directory saying "this is empty" is a fact it is entitled to state, and preserving the
  // stored value here would be the same defect mirrored: a value nobody currently asserts.
  const merged = round({ ...STORED, displayName: null, proxyAddresses: null })

  assert.equal(merged.displayName, null, 'an explicit null was swallowed by the stored value')
  assert.equal(merged.proxyAddresses, null)
})

test('ABSENT and EXPLICITLY NULL are now distinguishable, which was the finding', async () => {
  const { displayName, ...omitted } = STORED
  const cleared = { ...STORED, displayName: null }

  assert.notEqual(
    round(omitted).displayName,
    round(cleared).displayName,
    'absent and null reach the same value again; the distinction has collapsed')
  assert.equal(round(omitted).displayName, 'Ada Lovelace')
  assert.equal(round(cleared).displayName, null)
})

test('an EXPLICIT value still wins over the stored one', async () => {
  // The control that stops "inherit when absent" becoming "never change anything".
  assert.equal(round({ ...STORED, accountEnabled: true }).accountEnabled, true)
  assert.equal(round({ ...STORED, displayName: 'Ada L' }).displayName, 'Ada L')
  assert.deepEqual(round({ ...STORED, proxyAddresses: [] }).proxyAddresses, [],
    'an explicitly EMPTY list must clear, and is not the same as an absent one')
})

test('a user the baseline has never seen is carried through whole', async () => {
  const fresh = { id: 'user-2', displayName: 'Grace', accountEnabled: true }
  const merged = mergeExchangeMailboxRows([STORED], [exchangeMailboxRow(fresh)])[0] as Record<string, unknown>
  assert.equal(merged.id, 'user-2')
  assert.equal(merged.displayName, 'Grace')
  assert.equal(merged.accountEnabled, true)
})

test('a user absent from the incoming snapshot is REMOVED, not resurrected', async () => {
  // saveSnapshot only accepts a collection attesting to complete pagination, so a legitimate
  // empty inventory is entitled to remove objects. Merging must not turn that into "keep
  // everything forever", which would be a different and worse defect than the one being fixed.
  const merged = mergeExchangeMailboxRows([STORED], [exchangeMailboxRow({ id: 'user-2' })])
  assert.equal(merged.length, 1)
  assert.equal((merged[0] as Record<string, unknown>).id, 'user-2')
})

test('the mapping OMITS absent properties rather than defaulting them', async () => {
  // The property the merge depends on. If the mapping ever defaults again, the merge sees a
  // present value and dutifully overwrites the stored one -- the guard would still pass its
  // own tests while the defect returned underneath it.
  const { accountEnabled, proxyAddresses, ...partial } = STORED
  const row = exchangeMailboxRow(partial)
  assert.equal('accountEnabled' in row, false, 'absent accountEnabled reappeared as a value')
  assert.equal('proxyAddresses' in row, false)
  assert.equal(row.id, 'user-1')
})
