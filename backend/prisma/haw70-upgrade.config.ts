import { defineConfig } from 'prisma/config'
import { assembleHaw70UpgradeStageConfig } from '../scripts/haw70-upgrade-config.js'

/**
 * HAW-70 dedicated staged-migration configuration. UNUSED and inactive.
 *
 * It is NOT the application's configuration and is never discovered: it does
 * not use a default config name, so it is reachable only by passing this exact
 * path to the installed loader. There is no dotenv import, no seed hook, no
 * schema-only override, no downloaded executable and no caller-supplied path
 * or URL.
 *
 * `backend/prisma.config.ts` is left exactly as it is and is NEVER evaluated
 * or imported as application configuration. It IS read -- its raw bytes are
 * hashed as one of the pinned compatibility inputs by the source validation
 * this module depends on. Reading it is required; evaluating it is forbidden,
 * and those are different operations.
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
