import { NestFactory } from '@nestjs/core'
import type { INestApplication } from '@nestjs/common'
import helmet from 'helmet'
import { AppModule } from './app.module.js'
import { HAWKVIEW_NEST_OPTIONS } from './bootstrap-options.js'

/**
 * **THE ONLY `NestFactory.create` CALL IN THE CODEBASE, and that is the point of this file.**
 *
 * The options lived in a shared constant and `main.ts` passed it — which guarded removing
 * `rawBody` from the constant and guarded nothing about `main.ts` continuing to pass it.
 * Measured: reverting `main.ts` to the bare `NestFactory.create(AppModule)` typechecked clean
 * (the import simply became unused) and all three bootstrap tests still passed. The fix was real
 * and the thing that carried it to production was unguarded — the same seam shape this feature
 * has now produced five times, in the commit that closed the fourth.
 *
 * So the create call moved here, the test calls THIS, and there is no second place for the
 * options to be chosen. Reverting the options now breaks the tests, because the tests boot
 * through the same function `main.ts` does.
 *
 * `module` is a parameter so a test can boot a small module instead of the whole application
 * without opening a second code path: the factory call, the options, the middleware and their
 * order are identical either way.
 */
export async function createHawkviewApp(module: unknown = AppModule): Promise<INestApplication> {
  const app = await NestFactory.create(module as Parameters<typeof NestFactory.create>[0], HAWKVIEW_NEST_OPTIONS)
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
  return app
}

/** Start it. `main.ts` is the entry point and does nothing but call this. */
export async function bootstrap(): Promise<void> {
  const app = await createHawkviewApp()
  await app.listen(Number(process.env.PORT ?? 8080), '0.0.0.0')
}
