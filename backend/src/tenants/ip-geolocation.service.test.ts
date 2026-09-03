import assert from 'node:assert/strict'
import test from 'node:test'
import { IP_GEOLOCATION_CACHE_MAX_ENTRIES, IpGeolocationService } from './ip-geolocation.service.js'

test('GeoIP failure logs contain only the fixed operational catalog event', () => {
  const service = new IpGeolocationService()
  const messages: string[] = []
  ;(service as any).logger = { warn: (message: string) => messages.push(message) }

  ;(service as any).warnOnce()
  ;(service as any).warnOnce()

  assert.equal(messages.length, 1)
  assert.deepEqual(JSON.parse(messages[0]!), {
    event: 'ip_geolocation_database',
    phase: 'OPEN',
    outcome: 'FAILED',
    reasonCode: 'DATABASE_UNAVAILABLE',
  })
  for (const forbidden of [
    'C:\\private\\GeoLite.mmdb', 'private.example', 'user@example.test',
    'access_token', 'password', 'tenant-', 'provider-',
  ]) assert.equal(messages[0]!.includes(forbidden), false)
})

test('GeoIP cache evicts the oldest address at its fixed process-memory ceiling', () => {
  const service = new IpGeolocationService()
  for (let index = 0; index <= IP_GEOLOCATION_CACHE_MAX_ENTRIES; index += 1) {
    ;(service as any).remember(`192.0.${Math.floor(index / 256)}.${index % 256}`, null)
  }
  const cache = (service as any).cache as Map<string, null>
  assert.equal(cache.size, IP_GEOLOCATION_CACHE_MAX_ENTRIES)
  assert.equal(cache.has('192.0.0.0'), false)
  assert.equal(cache.has(`192.0.${Math.floor(IP_GEOLOCATION_CACHE_MAX_ENTRIES / 256)}.${IP_GEOLOCATION_CACHE_MAX_ENTRIES % 256}`), true)
})
