import { MiddlewareConsumer, Module, type NestModule } from '@nestjs/common'
import { AuthModule } from './auth/auth.module.js'
import { HealthModule } from './health/health.module.js'
import { PrismaModule } from './prisma/prisma.module.js'
import { TenantsModule } from './tenants/tenants.module.js'
import { SecretsModule } from './secrets/secrets.module.js'
import { NotificationsModule } from './notifications/notifications.module.js'
import { AlertsModule } from './alerts/alerts.module.js'
import { ChangesModule } from './changes/changes.module.js'
import { WorkspaceModule } from './workspace/workspace.module.js'
import { AuthenticatedCanaryModule } from './canary/authenticated-canary.module.js'
import { RequestCorrelationMiddleware } from './request-correlation.middleware.js'
import { IdentityRiskModule } from './identity-risk/identity-risk.module.js'
import { RateLimitingModule } from './rate-limiting/rate-limiting.module.js'
import { UnauthenticatedRateLimitMiddleware } from './rate-limiting/unauthenticated-rate-limit.middleware.js'

@Module({
  imports: [
    PrismaModule,
    SecretsModule,
    AuthModule,
    HealthModule,
    TenantsModule,
    NotificationsModule,
    AlertsModule,
    ChangesModule,
    WorkspaceModule,
    AuthenticatedCanaryModule,
    IdentityRiskModule,
    RateLimitingModule,
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    // Correlation FIRST: a refused request must still carry the X-Request-ID
    // that an operator will quote when asking why it was refused.
    consumer
      .apply(RequestCorrelationMiddleware, UnauthenticatedRateLimitMiddleware)
      .forRoutes('*')
  }
}
