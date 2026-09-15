import { defineConfig } from 'prisma/config'
import { configurationForStage } from './scripts/e2-migration-upgrade.js'

// Never load dotenv or accept application DATABASE_URL. The runner verifies
// exact committed bytes and the reserved disposable target before this config.
export default defineConfig(configurationForStage(process.env))
