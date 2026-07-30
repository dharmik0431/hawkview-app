import {
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common'

interface SecretAccessResponse {
  payload?: { data?: string }
}

@Injectable()
export class SecretStoreService {
  private cachedToken: { value: string; expiresAt: number } | null = null

  private get projectId() {
    const projectId =
      process.env.GOOGLE_CLOUD_PROJECT?.trim() ??
      process.env.GCP_PROJECT_ID?.trim()
    if (!projectId) {
      throw new ServiceUnavailableException(
        'Secure credential storage is not configured.'
      )
    }
    return projectId
  }

  private async getAccessToken() {
    const configuredToken = process.env.GOOGLE_OAUTH_ACCESS_TOKEN?.trim()
    if (configuredToken) return configuredToken
    if (this.cachedToken && this.cachedToken.expiresAt > Date.now() + 60_000) {
      return this.cachedToken.value
    }

    const response = await fetch(
      'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token',
      {
        headers: { 'Metadata-Flavor': 'Google' },
        signal: AbortSignal.timeout(5_000),
      }
    )
    if (!response.ok) {
      throw new ServiceUnavailableException(
        'HawkView could not authenticate to secure credential storage.'
      )
    }
    const body = (await response.json()) as {
      access_token?: string
      expires_in?: number
    }
    if (!body.access_token) {
      throw new ServiceUnavailableException(
        'Google Cloud did not return a service identity token.'
      )
    }
    this.cachedToken = {
      value: body.access_token,
      expiresAt: Date.now() + (body.expires_in ?? 300) * 1000,
    }
    return body.access_token
  }

  private async request(
    url: string,
    init: RequestInit = {},
    acceptedStatuses: number[] = [200]
  ) {
    const accessToken = await this.getAccessToken()
    const response = await fetch(url, {
      ...init,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        ...init.headers,
      },
      signal: init.signal ?? AbortSignal.timeout(10_000),
    })
    if (!acceptedStatuses.includes(response.status)) {
      const error = new Error(
        `Secret Manager request failed with status ${response.status}.`
      ) as Error & { status?: number }
      error.status = response.status
      throw error
    }
    return response
  }

  async store(secretId: string, value: string) {
    const encodedId = encodeURIComponent(secretId)
    const secretName = `projects/${this.projectId}/secrets/${secretId}`
    const secretUrl = `https://secretmanager.googleapis.com/v1/${secretName}`

    try {
      await this.request(secretUrl)
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !('status' in error) ||
        error.status !== 404
      ) {
        throw error
      }
      await this.request(
        `https://secretmanager.googleapis.com/v1/projects/${this.projectId}/secrets?secretId=${encodedId}`,
        {
          method: 'POST',
          body: JSON.stringify({ replication: { automatic: {} } }),
        }
      )
    }

    await this.request(`${secretUrl}:addVersion`, {
      method: 'POST',
      body: JSON.stringify({
        payload: { data: Buffer.from(value, 'utf8').toString('base64') },
      }),
    })
    return `${secretName}/versions/latest`
  }

  async access(reference: string) {
    const response = await this.request(
      `https://secretmanager.googleapis.com/v1/${reference}:access`
    )
    const body = (await response.json()) as SecretAccessResponse
    const value = body.payload?.data
      ? Buffer.from(body.payload.data, 'base64').toString('utf8').trim()
      : ''
    if (!value) {
      throw new ServiceUnavailableException(
        'The stored Microsoft credential is unavailable.'
      )
    }
    return value
  }

  async delete(reference: string) {
    const match = reference.match(
      /^projects\/([^/]+)\/secrets\/([^/]+)\/versions\/[^/]+$/
    )
    if (!match || match[1] !== this.projectId) {
      throw new ServiceUnavailableException(
        'The stored credential reference is invalid.'
      )
    }

    const secretName = `projects/${match[1]}/secrets/${match[2]}`
    await this.request(
      `https://secretmanager.googleapis.com/v1/${secretName}`,
      { method: 'DELETE' },
      [200, 404]
    )
  }

  async accessOrCreate(secretId: string, createValue: () => string) {
    const reference = `projects/${this.projectId}/secrets/${secretId}/versions/latest`
    try {
      return await this.access(reference)
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !('status' in error) ||
        error.status !== 404
      ) {
        throw error
      }
      const value = createValue()
      await this.store(secretId, value)
      return value
    }
  }
}
