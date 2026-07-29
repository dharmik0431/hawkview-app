import 'dotenv/config'
import 'reflect-metadata'
import { NestFactory } from '@nestjs/core'
import { AppModule } from './app.module.js'

async function bootstrap() {
  const app = await NestFactory.create(AppModule)
  const port = Number(process.env.PORT ?? 8080)

  app.enableShutdownHooks()
  await app.listen(port, '0.0.0.0')
}

bootstrap().catch((error) => {
  console.error('HawkView API failed to start.', error)
  process.exitCode = 1
})
