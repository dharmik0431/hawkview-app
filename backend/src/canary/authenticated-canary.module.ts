import { Module } from '@nestjs/common'
import { AuthenticatedCanaryController } from './authenticated-canary.controller.js'
import { AuthenticatedCanaryService } from './authenticated-canary.service.js'
import { GitHubCanaryOidcService } from './github-canary-oidc.service.js'

@Module({
  controllers: [AuthenticatedCanaryController],
  providers: [AuthenticatedCanaryService, GitHubCanaryOidcService],
})
export class AuthenticatedCanaryModule {}
