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

@Injectable()
export class IpGeolocationService {
  private readonly logger = new Logger(IpGeolocationService.name)
  private readerPromise: Promise<Reader<CityResponse> | null> | null = null
  private warned = false
  private readonly cache = new Map<string, SignInLocation | null>()

  async lookup(ipAddress: string): Promise<SignInLocation | null> {
    const ip = ipAddress.trim()
    if (!isIP(ip)) return null
    if (this.cache.has(ip)) return this.cache.get(ip) ?? null

    const reader = await this.getReader()
    if (!reader) return null

    const result = reader.get(ip)
    if (!result) {
      this.cache.set(ip, null)
      return null
    }

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
      this.cache.set(ip, null)
      return null
    }

    this.cache.set(ip, location)
    return location
  }

  private getReader() {
    if (!this.readerPromise) {
      this.readerPromise = this.openReader()
    }
    return this.readerPromise
  }

  private async openReader(): Promise<Reader<CityResponse> | null> {
    const databasePath = process.env.GEOIP_CITY_DATABASE_PATH?.trim()
    if (!databasePath) {
      this.warnOnce(
        'GEOIP_CITY_DATABASE_PATH is not configured; limited-license sign-in locations will remain unavailable.'
      )
      return null
    }

    try {
      return await open<CityResponse>(databasePath)
    } catch (error) {
      this.warnOnce(
        `Could not open the GeoLite2 City database at ${databasePath}: ${error instanceof Error ? error.message : String(error)}`
      )
      return null
    }
  }

  private warnOnce(message: string) {
    if (this.warned) return
    this.warned = true
    this.logger.warn(JSON.stringify({ event: 'ip_geolocation_database', phase: 'OPEN', outcome: 'FAILED', reasonCode: 'DATABASE_UNAVAILABLE' }))
  }
}
