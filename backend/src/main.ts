import 'dotenv/config'
import 'reflect-metadata'
import { NestFactory } from '@nestjs/core'
import { AppModule } from './app.module.js'

async function bootstrap() {
  const app = await NestFactory.create(AppModule)
  const port = Number(process.env.PORT ?? 8080)
  const allowedOrigins = (
    process.env.FRONTEND_ORIGINS ??
    'http://localhost:3000,http://127.0.0.1:3000'
  )
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean)
  const gasPreviewProjectNumber =
    process.env.GAS_PREVIEW_PROJECT_NUMBER?.trim() ?? ''

  const isAllowedOrigin = (origin?: string) => {
    if (!origin || allowedOrigins.includes(origin)) return true
    if (!gasPreviewProjectNumber) return false

    try {
      const url = new URL(origin)
      const expectedSuffix = `-${gasPreviewProjectNumber}.us-east1.run.app`

      return (
        url.protocol === 'https:' &&
        url.port === '' &&
        url.pathname === '/' &&
        url.hostname.startsWith('ais-dev-') &&
        url.hostname.endsWith(expectedSuffix)
      )
    } catch {
      return false
    }
  }

  app.enableShutdownHooks()
  app.enableCors({
    origin: (
      origin: string | undefined,
      callback: (error: Error | null, allow?: boolean) => void
    ) => callback(null, isAllowedOrigin(origin)),
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Authorization', 'Content-Type'],
    credentials: true,
  })
  await app.listen(port, '0.0.0.0')
}

bootstrap().catch((error) => {
  console.error('HawkView API failed to start.', error)
  process.exitCode = 1
})
