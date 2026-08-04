// This is a public HTTPS endpoint, not a credential. Keep the development API
// URL in source so hosted preview environments cannot replace it with a stale
// build-time value. Production can move this to an environment-specific build
// when a separate production API exists.
const API_BASE_URL =
  'https://hawkview-api-dev-670803700763.northamerica-northeast2.run.app'
const API_TIMEOUT_MS = 15_000

async function getIdentityToken() {
  if (typeof window === 'undefined') return null

  const { supabase } = await import('@/lib/auth/supabase')
  const { data } = (await supabase?.auth.getSession()) ?? {
    data: { session: null },
  }
  return data.session?.access_token ?? null
}

interface FetchOptions extends RequestInit {
  params?: Record<string, string>
  timeoutMs?: number
}

class ApiError extends Error {
  constructor(
    public status: number,
    message: string
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

async function fetchApi<T>(
  endpoint: string,
  options: FetchOptions = {}
): Promise<T> {
  const { params, timeoutMs = API_TIMEOUT_MS, ...fetchOptions } = options

  if (!API_BASE_URL) {
    throw new ApiError(
      0,
      'HawkView API is not configured. Set NEXT_PUBLIC_API_URL.'
    )
  }

  if (!endpoint.startsWith('/')) {
    throw new ApiError(0, 'API endpoints must start with "/".')
  }

  let url = `${API_BASE_URL}${endpoint}`
  if (params) {
    const searchParams = new URLSearchParams(params)
    url += `?${searchParams.toString()}`
  }

  const timeoutController = new AbortController()
  const timeoutId = setTimeout(() => timeoutController.abort(), timeoutMs)
  const signal = fetchOptions.signal
    ? AbortSignal.any([fetchOptions.signal, timeoutController.signal])
    : timeoutController.signal

  let response: Response
  try {
    const identityToken = await getIdentityToken()
    response = await fetch(url, {
      ...fetchOptions,
      signal,
      credentials: 'include',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        ...(identityToken
          ? { Authorization: `Bearer ${identityToken}` }
          : {}),
        ...fetchOptions.headers,
      },
    })
  } catch (error) {
    if (timeoutController.signal.aborted) {
      throw new ApiError(0, 'HawkView API request timed out.')
    }
    throw error
  } finally {
    clearTimeout(timeoutId)
  }

  if (!response.ok) {
    const body = await response.json().catch(() => null)
    throw new ApiError(
      response.status,
      body?.error?.message ||
        body?.message ||
        `HawkView API returned ${response.status}.`
    )
  }

  const contentType = response.headers.get('content-type') || ''
  if (!contentType.toLowerCase().includes('application/json')) {
    throw new ApiError(
      response.status,
      'HawkView API returned a non-JSON response.'
    )
  }

  return response.json() as Promise<T>
}

export const apiClient = {
  get: <T>(endpoint: string, options?: FetchOptions) =>
    fetchApi<T>(endpoint, { ...options, method: 'GET' }),

  post: <T>(endpoint: string, data?: unknown, options?: FetchOptions) =>
    fetchApi<T>(endpoint, {
      ...options,
      method: 'POST',
      body: data ? JSON.stringify(data) : undefined,
    }),

  patch: <T>(endpoint: string, data?: unknown, options?: FetchOptions) =>
    fetchApi<T>(endpoint, {
      ...options,
      method: 'PATCH',
      body: data ? JSON.stringify(data) : undefined,
    }),

  put: <T>(endpoint: string, data?: unknown, options?: FetchOptions) =>
    fetchApi<T>(endpoint, {
      ...options,
      method: 'PUT',
      body: data ? JSON.stringify(data) : undefined,
    }),

  delete: <T>(
    endpoint: string,
    data?: unknown,
    options?: FetchOptions
  ) =>
    fetchApi<T>(endpoint, {
      ...options,
      method: 'DELETE',
      body: data ? JSON.stringify(data) : undefined,
    }),
}

export { ApiError }
