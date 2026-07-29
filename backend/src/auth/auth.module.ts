import { Module } from '@nestjs/common'
import { APP_GUARD } from '@nestjs/core'
import { AuthController } from './auth.controller.js'
import { IdentityAuthGuard } from './identity-auth.guard.js'
import { IdentityTokenVerifier } from './identity-token-verifier.service.js'
import { AuthService } from './auth.service.js'

@Module({
  controllers: [AuthController],
  providers: [
    AuthService,
    IdentityTokenVerifier,
    {
      provide: APP_GUARD,
      useClass: IdentityAuthGuard,
    },
  ],
})
export class AuthModule {}
