import { buildHawkViewApiUrl } from '@/lib/config/public-runtime-config'

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

  let url: URL
  try {
    url = buildHawkViewApiUrl(endpoint)
  } catch {
    throw new ApiError(0, 'HawkView API request path is invalid.')
  }
  if (params) {
    Object.entries(params).forEach(([key, value]) => {
      url.searchParams.set(key, value)
    })
  }

  const timeoutController = new AbortController()
  const timeoutId = setTimeout(() => timeoutController.abort(), timeoutMs)
  const signal = fetchOptions.signal
    ? AbortSignal.any([fetchOptions.signal, timeoutController.signal])
    : timeoutController.signal

  let response: Response
  try {
    const identityToken = await getIdentityToken()
    response = await fetch(url.href, {
      ...fetchOptions,
      signal,
      // Authenticated tenant responses must never be reused by the browser's
      // HTTP cache after an account switch.
      cache: 'no-store',
      credentials: 'include',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        ...(identityToken ? { Authorization: `Bearer ${identityToken}` } : {}),
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

  delete: <T>(endpoint: string, data?: unknown, options?: FetchOptions) =>
    fetchApi<T>(endpoint, {
      ...options,
      method: 'DELETE',
      body: data ? JSON.stringify(data) : undefined,
    }),
}

export { ApiError }
