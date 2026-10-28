import { ApiError } from '@/types/api'

const BASE_URL = import.meta.env.VITE_API_BASE_URL ?? '/api'
const TOKEN_KEY = 'smartprint.token'

type UnauthorizedListener = () => void

let unauthorizedListener: UnauthorizedListener | null = null

export function onUnauthorized(listener: UnauthorizedListener): void {
  unauthorizedListener = listener
}

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY)
}

export function setToken(token: string): void {
  localStorage.setItem(TOKEN_KEY, token)
}

export function clearToken(): void {
  localStorage.removeItem(TOKEN_KEY)
}

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE' | 'PUT'
  body?: unknown
  isFormData?: boolean
  signal?: AbortSignal
  headers?: Record<string, string>
}

// Sent on every call; the backend requires it on the cookie-based auth
// endpoints (refresh, logout) so other websites cannot use the cookie.
const CLIENT_HEADERS = { 'X-SmartPrint-Client': 'web' }

// Auth endpoints answer 401 for reasons a refresh cannot fix (wrong password,
// no session), so they never trigger one.
const NO_REFRESH_PATHS = ['/auth/login', '/auth/register', '/auth/refresh', '/auth/logout']

let refreshInFlight: Promise<boolean> | null = null

// Trades the httpOnly refresh cookie for a new access token. One refresh runs
// at a time: a page that fires several requests as the token expires shares a
// single refresh instead of racing with its own rotation.
function refreshAccessToken(): Promise<boolean> {
  if (!refreshInFlight) {
    refreshInFlight = (async () => {
      try {
        const response = await fetch(`${BASE_URL}/auth/refresh`, {
          method: 'POST',
          headers: CLIENT_HEADERS,
          credentials: 'include',
        })
        if (!response.ok) {
          return false
        }
        const payload = (await response.json()) as { data?: { token?: string } }
        const token = payload.data?.token
        if (!token) {
          return false
        }
        setToken(token)
        return true
      } catch {
        return false
      }
    })().finally(() => {
      refreshInFlight = null
    })
  }
  return refreshInFlight
}

function sendRequest(path: string, options: RequestOptions): Promise<Response> {
  const { method = 'GET', body, isFormData, signal, headers: extraHeaders } = options

  const headers: Record<string, string> = { ...CLIENT_HEADERS, ...extraHeaders }
  const token = getToken()
  if (token) {
    headers.Authorization = `Bearer ${token}`
  }
  if (!isFormData && body !== undefined) {
    headers['Content-Type'] = 'application/json'
  }

  return fetch(`${BASE_URL}${path}`, {
    method,
    headers,
    credentials: 'include',
    body: isFormData ? (body as FormData) : body !== undefined ? JSON.stringify(body) : undefined,
    signal,
  })
}

// Sends the request; if the access token has expired, refreshes it once and
// retries. Returns the final response, or throws a network ApiError.
async function sendWithRefresh(path: string, options: RequestOptions): Promise<Response> {
  let response: Response
  try {
    response = await sendRequest(path, options)
  } catch {
    throw new ApiError(0, 'Connection lost. Please check your network and try again.')
  }

  if (response.status === 401 && !NO_REFRESH_PATHS.includes(path) && (await refreshAccessToken())) {
    try {
      response = await sendRequest(path, options)
    } catch {
      throw new ApiError(0, 'Connection lost. Please check your network and try again.')
    }
  }
  return response
}

async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const response = await sendWithRefresh(path, options)

  if (response.status === 204) {
    return undefined as T
  }

  let payload: unknown = null
  const text = await response.text()
  if (text) {
    try {
      payload = JSON.parse(text)
    } catch {
      payload = null
    }
  }

  if (!response.ok) {
    const message =
      payload && typeof payload === 'object' && 'message' in payload
        ? String((payload as { message: unknown }).message)
        : 'Something went wrong. Please try again.'

    if (response.status === 401) {
      clearToken()
      unauthorizedListener?.()
    }

    throw new ApiError(response.status, message)
  }

  return payload as T
}

export const api = {
  get: <T>(path: string, signal?: AbortSignal) => request<T>(path, { method: 'GET', signal }),
  post: <T>(path: string, body?: unknown, signal?: AbortSignal, headers?: Record<string, string>) =>
    request<T>(path, { method: 'POST', body, signal, headers }),
  patch: <T>(path: string, body?: unknown, signal?: AbortSignal) =>
    request<T>(path, { method: 'PATCH', body, signal }),
  delete: <T>(path: string, signal?: AbortSignal) => request<T>(path, { method: 'DELETE', signal }),
  postForm: <T>(path: string, formData: FormData, signal?: AbortSignal) =>
    request<T>(path, { method: 'POST', body: formData, isFormData: true, signal }),
}

export function downloadUrl(path: string): string {
  return `${BASE_URL}${path}`
}

export async function fetchAuthorizedBlob(path: string): Promise<Blob> {
  const response = await sendWithRefresh(path, {})
  if (!response.ok) {
    throw new ApiError(response.status, 'Could not download this file.')
  }
  return response.blob()
}
