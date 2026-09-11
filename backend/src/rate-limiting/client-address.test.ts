import assert from 'node:assert/strict'
import test from 'node:test'
import { clientAddress, trustedProxyHops } from './client-address.js'

/** The address, and above all the refusal to invent one. */

test('an unstated hop count yields no address at all', () => {
  // THE DEFAULT, AND THE WHOLE POINT. Behind a proxy the socket peer is the same
  // for every request, so an address-keyed limit built on it is a global limit.
  // Until the deployment states how much of X-Forwarded-For is trustworthy, the
  // honest answer is that we do not know who sent this.
  assert.equal(trustedProxyHops(undefined), null)
  assert.equal(trustedProxyHops(''), null)
  assert.equal(trustedProxyHops('   '), null)
  assert.equal(trustedProxyHops('one'), null)
  assert.equal(trustedProxyHops('-1'), null)
  assert.equal(clientAddress('203.0.113.7', '10.0.0.1', null), null)

  // POSITIVE CONTROL: a stated hop count does produce an address, so the nulls
  // above are about the missing configuration rather than a function that never
  // returns anything.
  assert.equal(trustedProxyHops('1'), 1)
  assert.equal(clientAddress('203.0.113.7', '10.0.0.1', 1), '203.0.113.7')
})

test('zero trusted proxies uses the socket peer and ignores the header', () => {
  // Direct exposure: the header is caller-supplied and carries no weight.
  assert.equal(clientAddress('1.2.3.4', '203.0.113.9', 0), '203.0.113.9')
  assert.equal(clientAddress(undefined, '203.0.113.9', 0), '203.0.113.9')
  assert.equal(clientAddress('1.2.3.4', undefined, 0), null)
})

test('a caller cannot choose its own bucket by sending a header', () => {
  // THE FORGERY THIS MODULE EXISTS TO REFUSE. The attacker prepends whatever it
  // likes; the trusted proxy appends what it actually saw. Counting from the
  // right reads the proxy's observation and discards the caller's claim, so a
  // flood cannot mint a fresh allowance per request by varying a header.
  const asReceived = '1.1.1.1, 2.2.2.2, 3.3.3.3, 198.51.100.23'
  assert.equal(clientAddress(asReceived, '10.0.0.1', 1), '198.51.100.23')

  // Varying the claim does not vary the key.
  assert.equal(clientAddress('9.9.9.9, 8.8.8.8, 198.51.100.23', '10.0.0.1', 1), '198.51.100.23')
})

test('two trusted proxies read one entry further left', () => {
  // With two in front of us the outermost appended the client and the inner one
  // appended the outermost.
  assert.equal(clientAddress('198.51.100.23, 10.0.0.7', '10.0.0.1', 2), '198.51.100.23')
})

test('a request that did not traverse the expected proxies is unknown, not guessed', () => {
  // Too few entries means the path was not what we were told to expect. Falling
  // back to the leftmost entry would be falling back to the caller's claim.
  assert.equal(clientAddress('198.51.100.23', '10.0.0.1', 2), null)
  assert.equal(clientAddress(undefined, '10.0.0.1', 1), null)
  assert.equal(clientAddress('', '10.0.0.1', 1), null)
})

test('something that is not an address is unknown rather than a shared key', () => {
  // An unparseable value must not become a bucket everyone lands in — that is
  // the global-limit failure arriving through a malformed header instead of
  // through configuration.
  assert.equal(clientAddress('not-an-address', '10.0.0.1', 1), null)
  assert.equal(clientAddress('unknown', '10.0.0.1', 1), null)

  // POSITIVE CONTROL: a well-formed value in the same position is read.
  assert.equal(clientAddress('198.51.100.23', '10.0.0.1', 1), '198.51.100.23')
})

test('the same caller is one bucket however its address is spelled', () => {
  // A port, brackets, an IPv4-mapped v6 form and a capitalised v6 literal are
  // all the same caller. Two buckets would halve the effective limit for them
  // and make the count unreadable.
  assert.equal(clientAddress('198.51.100.23:54321', '10.0.0.1', 1), '198.51.100.23')
  assert.equal(clientAddress('[2001:db8::1]:443', '10.0.0.1', 1), '2001:db8::1')
  assert.equal(clientAddress('::ffff:198.51.100.23', '10.0.0.1', 1), '198.51.100.23')
  assert.equal(clientAddress('2001:DB8::1', '10.0.0.1', 1), '2001:db8::1')
  // An unbracketed v6 literal must not be truncated at its first colon.
  assert.equal(clientAddress('2001:db8::1', '10.0.0.1', 1), '2001:db8::1')
})

test('a header arriving as repeated fields is read as one list', () => {
  // Express hands back an array when the header appears more than once.
  assert.equal(clientAddress(['1.1.1.1', '198.51.100.23'], '10.0.0.1', 1), '198.51.100.23')
})
