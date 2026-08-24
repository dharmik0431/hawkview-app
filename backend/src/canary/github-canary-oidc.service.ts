import { Injectable, UnauthorizedException } from '@nestjs/common'
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose'

export const HAWKVIEW_CANARY_AUDIENCE =
  'https://hawkview-api-dev.onrender.com/api/internal/canary/sessions'
export const HAWKVIEW_GITHUB_REPOSITORY = 'dharmik0431/hawkview-app'
export const HAWKVIEW_GITHUB_REPOSITORY_ID = '1227480788'
export const HAWKVIEW_CANARY_WORKFLOW_REF =
  'dharmik0431/hawkview-app/.github/workflows/authenticated-canary.yml@refs/heads/main'

const FULL_GIT_REVISION = /^[0-9a-f]{40}$/i
const ALLOWED_EVENTS = new Set(['deployment_status', 'workflow_dispatch'])

interface GitHubCanaryPayload extends JWTPayload {
  repository?: string
  repository_id?: string
  ref?: string
  sha?: string
  workflow_ref?: string
  event_name?: string
}

export function assertGitHubCanaryClaims(
  payload: GitHubCanaryPayload,
  expectedRevision: string,
  nowSeconds = Math.floor(Date.now() / 1000),
) {
  const revision = expectedRevision.trim().toLowerCase()
  const issuedAt = payload.iat
  if (
    !FULL_GIT_REVISION.test(revision) ||
    payload.repository !== HAWKVIEW_GITHUB_REPOSITORY ||
    payload.repository_id !== HAWKVIEW_GITHUB_REPOSITORY_ID ||
    payload.ref !== 'refs/heads/main' ||
    payload.sha?.toLowerCase() !== revision ||
    payload.workflow_ref !== HAWKVIEW_CANARY_WORKFLOW_REF ||
    !ALLOWED_EVENTS.has(payload.event_name ?? '') ||
    typeof issuedAt !== 'number' ||
    issuedAt > nowSeconds + 30 ||
    nowSeconds - issuedAt > 300
  ) {
    throw new UnauthorizedException('The canary workflow identity is not authorized.')
  }
}

@Injectable()
export class GitHubCanaryOidcService {
  private readonly jwks = createRemoteJWKSet(
    new URL('https://token.actions.githubusercontent.com/.well-known/jwks'),
  )

  async verify(token: string, expectedRevision: string) {
    try {
      const { payload } = await jwtVerify<GitHubCanaryPayload>(token, this.jwks, {
        audience: HAWKVIEW_CANARY_AUDIENCE,
        issuer: 'https://token.actions.githubusercontent.com',
      })
      assertGitHubCanaryClaims(payload, expectedRevision)
    } catch (error) {
      if (error instanceof UnauthorizedException) throw error
      throw new UnauthorizedException('The canary workflow identity is invalid or expired.')
    }
  }
}
