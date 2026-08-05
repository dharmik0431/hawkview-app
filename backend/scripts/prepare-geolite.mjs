import {
  mkdir,
  mkdtemp,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { x as extractTar } from 'tar'

const licenseKey = process.env.MAXMIND_LICENSE_KEY?.trim()
const databasePath =
  process.env.GEOIP_CITY_DATABASE_PATH?.trim() || '/tmp/GeoLite2-City.mmdb'

if (!licenseKey) {
  console.log(
    'MAXMIND_LICENSE_KEY is not configured; GeoLite2 location enrichment is disabled.'
  )
  process.exit(0)
}

try {
  const existing = await stat(databasePath).catch(() => null)
  if (existing?.isFile() && existing.size > 0) {
    console.log(`GeoLite2 City database is ready at ${databasePath}.`)
    process.exit(0)
  }

  const workspace = await mkdtemp(join(tmpdir(), 'hawkview-geolite-'))
  const archivePath = join(workspace, 'GeoLite2-City.tar.gz')
  const downloadUrl = new URL('https://download.maxmind.com/app/geoip_download')
  downloadUrl.searchParams.set('edition_id', 'GeoLite2-City')
  downloadUrl.searchParams.set('license_key', licenseKey)
  downloadUrl.searchParams.set('suffix', 'tar.gz')

  try {
    const response = await fetch(downloadUrl, {
      headers: { 'user-agent': 'HawkView/1.0 GeoLite2 updater' },
      signal: AbortSignal.timeout(60_000),
    })
    if (!response.ok) {
      throw new Error(`MaxMind download returned HTTP ${response.status}`)
    }

    await writeFile(archivePath, new Uint8Array(await response.arrayBuffer()))
    await extractTar({ file: archivePath, cwd: workspace, strict: true })

    const extractedDatabase = await findFile(workspace, 'GeoLite2-City.mmdb')
    if (!extractedDatabase) {
      throw new Error('GeoLite2-City.mmdb was not found in the MaxMind archive')
    }

    await mkdir(dirname(databasePath), { recursive: true })
    await rename(extractedDatabase, databasePath)
    console.log(`GeoLite2 City database downloaded to ${databasePath}.`)
  } finally {
    await rm(workspace, { recursive: true, force: true })
  }
} catch (error) {
  console.error(
    `Failed to prepare the GeoLite2 City database: ${error instanceof Error ? error.message : String(error)}`
  )
  process.exit(1)
}

async function findFile(directory, name) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const candidate = join(directory, entry.name)
    if (entry.isFile() && entry.name === name) return candidate
    if (entry.isDirectory()) {
      const nested = await findFile(candidate, name)
      if (nested) return nested
    }
  }
  return null
}
