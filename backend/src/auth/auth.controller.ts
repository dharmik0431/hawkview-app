import { Body, Controller, Inject, Patch, Post, Req } from '@nestjs/common'
import type { AuthenticatedRequest } from './auth.types.js'
import { AuthService } from './auth.service.js'

@Controller('auth')
export class AuthController {
  constructor(
    @Inject(AuthService)
    private readonly authService: AuthService,
  ) {}

  @Post('bootstrap')
  bootstrap(@Req() request: AuthenticatedRequest) {
    return this.authService.bootstrap(request.auth)
  }

  @Patch('profile')
  updateProfile(
    @Req() request: AuthenticatedRequest,
    @Body() body: unknown,
  ) {
    return this.authService.updateProfile(request.auth, body)
  }
}
