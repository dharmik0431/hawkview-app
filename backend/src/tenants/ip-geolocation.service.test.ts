import assert from 'node:assert/strict'
import test from 'node:test'
import { IP_GEOLOCATION_CACHE_MAX_ENTRIES, IP_GEOLOCATION_MAX_WAITERS, IP_GEOLOCATION_MAX_WAIT_MS, IP_GEOLOCATION_RETRY_MS, IpGeolocationService } from './ip-geolocation.service.js'

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

test('one pending open has bounded removable waits; repeated caller deadlines never reopen it', async () => {
  const service = new IpGeolocationService()
  let opens = 0; let release!: (reader: any) => void
  ;(service as any).openReader = () => { opens++; return new Promise(resolve => { release = resolve }) }
  const pending = Array.from({ length: IP_GEOLOCATION_MAX_WAITERS }, () => service.ensureReady(Date.now() + 20))
  assert.equal((service as any).readinessWaiters.size, IP_GEOLOCATION_MAX_WAITERS)
  assert.deepEqual(await service.ensureReady(Date.now() + 100), { ready: false, reason: 'GEOIP_WAIT_CAPACITY' })
  assert.ok((await Promise.all(pending)).every(result => !result.ready && result.reason === 'GEOIP_INITIALIZING'))
  assert.equal((service as any).readinessWaiters.size, 0)
  for (let i = 0; i < 20; i++) {
    assert.deepEqual(await service.ensureReady(Date.now() + 2), { ready: false, reason: 'GEOIP_INITIALIZING' })
    assert.equal((service as any).readinessWaiters.size, 0)
  }
  assert.equal(opens, 1)
  release({ get: () => null })
  await new Promise<void>(resolve => setImmediate(resolve))
  assert.deepEqual(await service.ensureReady(Date.now() + 100), { ready: true })
  assert.equal((service as any).readinessWaiters.size, 0)
  assert.equal(opens, 1)
})

test('expired and invalid readiness budgets never open or register a waiter', async () => {
  const service = new IpGeolocationService()
  ;(service as any).openReader = () => { throw new Error('Must not open') }
  for (const deadline of [Date.now() - 1, NaN, Infinity]) {
    assert.deepEqual(await service.ensureReady(deadline), { ready: false, reason: 'GEOIP_DEADLINE' })
    assert.equal((service as any).readinessWaiters.size, 0)
    assert.equal((service as any).readerState, 'IDLE')
  }
})

test('settlement clears waiter timers, caps distant deadlines, and cannot admit an expired caller', async (t) => {
  let now = Date.now()
  t.mock.method(Date, 'now', () => now)
  const originalSet = global.setTimeout
  const originalClear = global.clearTimeout
  const timers = new Set<ReturnType<typeof setTimeout>>()
  const delays: number[] = []
  t.mock.method(global, 'setTimeout', (callback: () => void, delay: number) => {
    delays.push(delay)
    const timer = originalSet(callback, delay)
    timers.add(timer)
    return timer
  })
  t.mock.method(global, 'clearTimeout', (timer: ReturnType<typeof setTimeout>) => {
    timers.delete(timer); originalClear(timer)
  })
  const service = new IpGeolocationService()
  let release!: (reader: any) => void
  ;(service as any).openReader = () => new Promise(resolve => { release = resolve })
  const expired = service.ensureReady(now + 100)
  const distant = service.ensureReady(now + 1_000_000)
  await new Promise<void>(resolve => setImmediate(resolve))
  assert.deepEqual(delays, [100, IP_GEOLOCATION_MAX_WAIT_MS])
  now += 101
  release({ get: () => null })
  assert.deepEqual(await expired, { ready: false, reason: 'GEOIP_DEADLINE' })
  assert.deepEqual(await distant, { ready: true })
  assert.equal(timers.size, 0)
  assert.equal((service as any).readinessWaiters.size, 0)
})

test('settled failure retries once after cooldown; concurrent retry callers share success', async (t) => {
  let now = Date.now()
  t.mock.method(Date, 'now', () => now)
  const service = new IpGeolocationService()
  ;(service as any).logger = { warn: () => {} }
  let opens = 0; let release!: (reader: any) => void
  ;(service as any).openReader = () => {
    opens++
    if (opens === 1) return Promise.reject(new Error('synthetic private detail'))
    return new Promise(resolve => { release = resolve })
  }
  assert.deepEqual(await service.ensureReady(now + 1000), { ready: false, reason: 'GEOIP_UNAVAILABLE' })
  assert.equal((service as any).readinessWaiters.size, 0)
  now += IP_GEOLOCATION_RETRY_MS - 1
  assert.deepEqual(await service.ensureReady(now + 1000), { ready: false, reason: 'GEOIP_UNAVAILABLE' })
  assert.equal(opens, 1)
  now++
  const pending = [service.ensureReady(now + 1000), service.ensureReady(now + 1000)]
  await new Promise<void>(resolve => setImmediate(resolve))
  assert.equal(opens, 2)
  release({ get: () => null })
  assert.deepEqual(await Promise.all(pending), [{ ready: true }, { ready: true }])
  assert.equal((service as any).readinessWaiters.size, 0)
})

test('ready lookups distinguish matches, true no-match and local failure from unavailable', async () => {
  const service = new IpGeolocationService()
  assert.deepEqual(service.lookupReady('192.0.2.1'), { kind: 'UNAVAILABLE' })
  ;(service as any).openReader = async () => ({ get: (ip: string) => {
    if (ip === '192.0.2.1') return null
    if (ip === '192.0.2.2') throw new Error('private database detail')
    return { country: { iso_code: 'ZZ' }, location: { latitude: 0, longitude: 0 } }
  } })
  await service.ensureReady(Date.now() + 1000)
  assert.deepEqual(service.lookupReady('192.0.2.1'), { kind: 'NO_MATCH' })
  assert.deepEqual(service.lookupReady('192.0.2.2'), { kind: 'FAILED' })
  const result = service.lookupReady('192.0.2.3')
  assert.equal(result.kind, 'FOUND')
  if (result.kind === 'FOUND') assert.deepEqual(result.location.geoCoordinates, { latitude: 0, longitude: 0 })
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
