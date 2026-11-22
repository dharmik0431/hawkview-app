import { defineConfig } from 'prisma/config'
import { assembleHaw70UpgradeStageConfig } from '../scripts/haw70-upgrade-config.js'

/**
 * HAW-70 dedicated staged-migration configuration. UNUSED and inactive.
 *
 * It is NOT the application's configuration and is never discovered: it does
 * not use a default config name, so it is reachable only by passing this exact
 * path to the installed loader. `backend/prisma.config.ts` is untouched and is
 * never read here. There is no dotenv import, no seed hook, no schema-only
 * override, no downloaded executable and no caller-supplied path or URL.
 *
 * ONE immutable environment snapshot is taken on the line below, at module
 * evaluation, and every validated value — including the datasource URL — comes
 * from that same snapshot. Ambient environment is never re-read afterwards.
 *
 * Loading performs validation only. Returning these paths is not hosting, not
 * an empty database, not a completed stage and not permission to run anything.
 */
const assembled = assembleHaw70UpgradeStageConfig({ environment: { ...process.env } })

export default defineConfig({
  schema: assembled.schemaPath,
  migrations: { path: assembled.migrationsPath },
  datasource: { url: assembled.datasourceUrl },
})
