import { Module } from '@nestjs/common'
import { AuthModule } from './auth/auth.module.js'
import { HealthModule } from './health/health.module.js'
import { PrismaModule } from './prisma/prisma.module.js'
import { TenantsModule } from './tenants/tenants.module.js'
import { SecretsModule } from './secrets/secrets.module.js'
import { NotificationsModule } from './notifications/notifications.module.js'
import { ChangesModule } from './changes/changes.module.js'
import { WorkspaceModule } from './workspace/workspace.module.js'
import { AuthenticatedCanaryModule } from './canary/authenticated-canary.module.js'

@Module({
  imports: [
    PrismaModule,
    SecretsModule,
    AuthModule,
    HealthModule,
    TenantsModule,
    NotificationsModule,
    ChangesModule,
    WorkspaceModule,
    AuthenticatedCanaryModule,
  ],
})
export class AppModule {}
