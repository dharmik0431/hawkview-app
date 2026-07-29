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

  app.enableShutdownHooks()
  app.enableCors({
    origin: allowedOrigins,
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
