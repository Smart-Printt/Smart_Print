import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ApiError } from '@/types/api'
import { api, clearToken, getToken, onUnauthorized, setToken } from './apiClient'

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status })
}

function bearerOf(call: unknown[]): string | undefined {
  const init = call[1] as { headers: Record<string, string> }
  return init.headers.Authorization
}

describe('apiClient silent refresh', () => {
  const fetchMock = vi.fn()
  const unauthorized = vi.fn()

  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock)
    onUnauthorized(unauthorized)
    setToken('old-token')
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    fetchMock.mockReset()
    unauthorized.mockReset()
    clearToken()
  })

  it('refreshes an expired access token and retries the request once', async () => {
    fetchMock
      .mockResolvedValueOnce(json(401, { success: false, message: 'Token has expired' }))
      .mockResolvedValueOnce(json(200, { success: true, data: { token: 'new-token' } }))
      .mockResolvedValueOnce(json(200, { success: true, data: { ok: true } }))

    await expect(api.get('/orders')).resolves.toEqual({ success: true, data: { ok: true } })

    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(fetchMock.mock.calls[1][0]).toBe('/api/auth/refresh')
    expect(bearerOf(fetchMock.mock.calls[0])).toBe('Bearer old-token')
    expect(bearerOf(fetchMock.mock.calls[2])).toBe('Bearer new-token')
    expect(getToken()).toBe('new-token')
    expect(unauthorized).not.toHaveBeenCalled()
  })

  it('sends the client header and credentials with the refresh call', async () => {
    fetchMock
      .mockResolvedValueOnce(json(401, { success: false, message: 'expired' }))
      .mockResolvedValueOnce(json(200, { success: true, data: { token: 'new-token' } }))
      .mockResolvedValueOnce(json(200, { success: true }))

    await api.get('/orders')

    const init = fetchMock.mock.calls[1][1] as { headers: Record<string, string>; credentials: string }
    expect(init.headers['X-SmartPrint-Client']).toBe('web')
    expect(init.credentials).toBe('include')
  })

  it('logs the user out when the refresh itself fails', async () => {
    fetchMock
      .mockResolvedValueOnce(json(401, { success: false, message: 'Token has expired' }))
      .mockResolvedValueOnce(json(401, { success: false, message: 'Session expired' }))

    const err = await api.get('/orders').catch((e: unknown) => e)

    expect(err).toBeInstanceOf(ApiError)
    expect((err as ApiError).status).toBe(401)
    expect(getToken()).toBeNull()
    expect(unauthorized).toHaveBeenCalledTimes(1)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('does not try to refresh after a failed login', async () => {
    fetchMock.mockResolvedValueOnce(json(401, { success: false, message: 'Invalid email or password' }))

    await expect(api.post('/auth/login', { email: 'a', password: 'b' })).rejects.toMatchObject({ status: 401 })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('shares one refresh between simultaneous requests', async () => {
    let refreshCalls = 0
    fetchMock.mockImplementation((url: string, init: { headers: Record<string, string> }) => {
      if (url === '/api/auth/refresh') {
        refreshCalls += 1
        return Promise.resolve(json(200, { success: true, data: { token: 'new-token' } }))
      }
      if (init.headers.Authorization === 'Bearer new-token') {
        return Promise.resolve(json(200, { success: true }))
      }
      return Promise.resolve(json(401, { success: false, message: 'expired' }))
    })

    await Promise.all([api.get('/orders'), api.get('/documents'), api.get('/shops')])

    expect(refreshCalls).toBe(1)
  })

  it('does not retry a request that fails for another reason', async () => {
    fetchMock.mockResolvedValueOnce(json(403, { success: false, message: 'Forbidden' }))

    await expect(api.get('/orders')).rejects.toMatchObject({ status: 403 })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})
