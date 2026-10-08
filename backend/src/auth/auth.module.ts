import { Module } from '@nestjs/common'
import { APP_GUARD } from '@nestjs/core'
import { AuthController } from './auth.controller.js'
import { IdentityAuthGuard } from './identity-auth.guard.js'
import { IdentityTokenVerifier } from './identity-token-verifier.service.js'
import { AuthService } from './auth.service.js'
import { ConsoleSessionService } from './console-session.service.js'
import { ConsoleSessionController } from './console-session.controller.js'

@Module({
  controllers: [AuthController, ConsoleSessionController],
  providers: [
    AuthService,
    IdentityTokenVerifier,
    ConsoleSessionService,
    {
      provide: APP_GUARD,
      useClass: IdentityAuthGuard,
    },
  ],
})
export class AuthModule {}
