import { Module } from '@nestjs/common'
import { AuthModule } from './auth/auth.module.js'
import { HealthModule } from './health/health.module.js'
import { PrismaModule } from './prisma/prisma.module.js'
import { TenantsModule } from './tenants/tenants.module.js'

@Module({
  imports: [PrismaModule, AuthModule, HealthModule, TenantsModule],
})
export class AppModule {}
