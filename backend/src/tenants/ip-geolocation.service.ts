import { Injectable, Logger } from '@nestjs/common'
import { isIP } from 'node:net'
import { open, type CityResponse, type Reader } from 'maxmind'

export type SignInLocation = {
  city: string | null
  state: string | null
  countryOrRegion: string | null
  geoCoordinates: {
    latitude: number
    longitude: number
  } | null
  source: 'MAXMIND_GEOLITE2'
}

export const IP_GEOLOCATION_CACHE_MAX_ENTRIES = 5_000
export const IP_GEOLOCATION_MAX_WAITERS = 16
export const IP_GEOLOCATION_MAX_WAIT_MS = 20_000
export const IP_GEOLOCATION_RETRY_MS = 60_000

export type GeoIpReadinessReason = 'GEOIP_INITIALIZING' | 'GEOIP_UNAVAILABLE' | 'GEOIP_WAIT_CAPACITY' | 'GEOIP_DEADLINE'
export type GeoIpReadiness = { ready: true } | { ready: false; reason: GeoIpReadinessReason }
export type GeoIpLookup =
  | { kind: 'FOUND'; location: SignInLocation }
  | { kind: 'NO_MATCH' | 'UNAVAILABLE' | 'FAILED' }

@Injectable()
export class IpGeolocationService {
  private readonly logger = new Logger(IpGeolocationService.name)
  private reader: Reader<CityResponse> | null = null
  private readerState: 'IDLE' | 'INITIALIZING' | 'READY' | 'UNAVAILABLE' = 'IDLE'
  private retryAfter = 0
  private readonly readinessWaiters = new Set<(result: GeoIpReadiness) => void>()
  private warned = false
  private readonly cache = new Map<string, SignInLocation | null>()

  /** One physical open, with bounded, removable caller waits. A caller timeout
   * never restarts the open or retains a callback on its pending promise. */
  async ensureReady(deadlineAt: number): Promise<GeoIpReadiness> {
    const now = Date.now()
    if (!Number.isFinite(deadlineAt) || deadlineAt <= now) return { ready: false, reason: 'GEOIP_DEADLINE' }
    if (this.readerState === 'READY') return { ready: true }
    if (this.readerState === 'UNAVAILABLE' && now < this.retryAfter) return { ready: false, reason: 'GEOIP_UNAVAILABLE' }
    if (this.readerState !== 'INITIALIZING') this.startReader()
    if (this.readinessWaiters.size >= IP_GEOLOCATION_MAX_WAITERS) return { ready: false, reason: 'GEOIP_WAIT_CAPACITY' }
    const expiresAt = Math.min(deadlineAt, now + IP_GEOLOCATION_MAX_WAIT_MS)
    return new Promise((resolve) => {
      const finish = (result: GeoIpReadiness) => {
        this.readinessWaiters.delete(finish)
        clearTimeout(timer)
        resolve(result.ready && Date.now() >= expiresAt ? { ready: false, reason: 'GEOIP_DEADLINE' } : result)
      }
      const timer = setTimeout(() => finish({ ready: false, reason: 'GEOIP_INITIALIZING' }), Math.max(1, expiresAt - Date.now()))
      this.readinessWaiters.add(finish)
    })
  }

  /** Reader access is synchronous after readiness; no per-IP work can outlive
   * its sync or retain a place in another tenant's enrichment budget. */
  lookupReady(ipAddress: string): GeoIpLookup {
    if (!this.reader || this.readerState !== 'READY') return { kind: 'UNAVAILABLE' }
    const ip = ipAddress.trim()
    if (!isIP(ip)) return { kind: 'NO_MATCH' }
    if (this.cache.has(ip)) {
      const location = this.cache.get(ip)
      return location ? { kind: 'FOUND', location } : { kind: 'NO_MATCH' }
    }
    let result: CityResponse | null
    try { result = this.reader.get(ip) } catch { return { kind: 'FAILED' } }
    if (!result) { this.remember(ip, null); return { kind: 'NO_MATCH' } }

    const latitude = result.location?.latitude
    const longitude = result.location?.longitude
    const location: SignInLocation = {
      city: result.city?.names?.en ?? null,
      state: result.subdivisions?.[0]?.names?.en ?? null,
      countryOrRegion: result.country?.iso_code ?? null,
      geoCoordinates:
        typeof latitude === 'number' && typeof longitude === 'number'
          ? { latitude, longitude }
          : null,
      source: 'MAXMIND_GEOLITE2',
    }

    if (
      !location.city &&
      !location.state &&
      !location.countryOrRegion &&
      !location.geoCoordinates
    ) {
      this.remember(ip, null)
      return { kind: 'NO_MATCH' }
    }

    this.remember(ip, location)
    return { kind: 'FOUND', location }
  }

  private remember(ip: string, location: SignInLocation | null) {
    if (!this.cache.has(ip) && this.cache.size >= IP_GEOLOCATION_CACHE_MAX_ENTRIES) {
      const oldest = this.cache.keys().next().value
      if (typeof oldest === 'string') this.cache.delete(oldest)
    }
    this.cache.set(ip, location)
  }

  private startReader() {
    this.readerState = 'INITIALIZING'
    const settle = (reader: Reader<CityResponse> | null) => {
      this.reader = reader
      this.readerState = reader ? 'READY' : 'UNAVAILABLE'
      // Only a settled failed open is retryable. Missing configuration or a
      // repaired local file can recover later, without overlapping opens.
      this.retryAfter = reader ? 0 : Date.now() + IP_GEOLOCATION_RETRY_MS
      const result: GeoIpReadiness = reader ? { ready: true } : { ready: false, reason: 'GEOIP_UNAVAILABLE' }
      for (const finish of this.readinessWaiters) finish(result)
    }
    void Promise.resolve().then(() => this.openReader()).then(settle, () => { this.warnOnce(); settle(null) })
  }

  private async openReader(): Promise<Reader<CityResponse> | null> {
    const databasePath = process.env.GEOIP_CITY_DATABASE_PATH?.trim()
    if (!databasePath) {
      this.warnOnce()
      return null
    }

    try {
      return await open<CityResponse>(databasePath)
    } catch {
      this.warnOnce()
      return null
    }
  }

  private warnOnce() {
    if (this.warned) return
    this.warned = true
    this.logger.warn(JSON.stringify({ event: 'ip_geolocation_database', phase: 'OPEN', outcome: 'FAILED', reasonCode: 'DATABASE_UNAVAILABLE' }))
  }
}
