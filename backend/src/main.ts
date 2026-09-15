import 'dotenv/config'
import 'reflect-metadata'
import { bootstrap } from './bootstrap.js'

// NOTHING BUT THE ENTRY POINT. Everything that decides how the application is constructed lives
// in `bootstrap.ts`, so there is one `NestFactory.create` call and the tests exercise it.
bootstrap().catch((error) => {
  console.error('HawkView API failed to start.', error)
  process.exitCode = 1
})
