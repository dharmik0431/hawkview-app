import 'dotenv/config'
import 'reflect-metadata'
import { NestFactory } from '@nestjs/core'
import helmet from 'helmet'
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
  app.use(
    helmet({
      // NO CONTENT-SECURITY-POLICY, deliberately. This service returns JSON and
      // exactly one 303 redirect; it renders no markup at all, so CSP directives
      // here would constrain nothing that exists. Shipping a policy that
      // describes no resources is a security claim nobody can check, and it is
      // the kind of thing a later reader trusts.
      contentSecurityPolicy: false,
      // THE ONE THAT MATTERS ON A CUSTOM DOMAIN. Two years, and applied to
      // subdomains because the API is itself a subdomain — this instructs
      // browsers never to attempt api.hawkviewapp.com over plaintext, which is
      // what stops a downgrade before the request carries a bearer token.
      // Not preloaded: submitting to the preload list is effectively permanent
      // and is an owner's decision, not a deploy's.
      hsts: { maxAge: 63_072_000, includeSubDomains: true, preload: false },
    })
  )
  app.enableCors({
    origin: (
      origin: string | undefined,
      callback: (error: Error | null, allow?: boolean) => void
    ) => callback(null, isAllowedOrigin(origin)),
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Authorization', 'Content-Type'],
    exposedHeaders: ['X-Request-ID'],
    credentials: true,
  })
  await app.listen(port, '0.0.0.0')
}

bootstrap().catch((error) => {
  console.error('HawkView API failed to start.', error)
  process.exitCode = 1
})
