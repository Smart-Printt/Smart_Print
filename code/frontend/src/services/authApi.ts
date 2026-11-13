import { api } from './apiClient'
import type { ApiMessage, ApiSuccess, AuthResult, SafeUser } from '@/types'

export const authApi = {
  async register(input: { name: string; email: string; phone?: string; password: string }) {
    const res = await api.post<ApiSuccess<AuthResult>>('/auth/register', input)
    return res.data
  },

  async login(input: { email: string; password: string }) {
    const res = await api.post<ApiSuccess<AuthResult>>('/auth/login', input)
    return res.data
  },

  async logout() {
    await api.post('/auth/logout')
  },

  async me() {
    const res = await api.get<ApiSuccess<{ user: SafeUser }>>('/auth/me')
    return res.data.user
  },

  async updateProfile(input: { name?: string; phone?: string }) {
    const res = await api.patch<ApiSuccess<{ user: SafeUser }>>('/auth/me', input)
    return res.data.user
  },

  // Signs out every other device. The response carries a fresh token for
  // this one, which the caller must store.
  async changePassword(input: { currentPassword: string; newPassword: string; confirmPassword: string }) {
    const res = await api.post<ApiSuccess<AuthResult>>('/auth/change-password', input)
    return res.data
  },

  async createFaculty(input: { name: string; email: string; phone?: string; password: string }) {
    const res = await api.post<ApiSuccess<{ user: SafeUser }>>('/auth/faculty', input)
    return res.data.user
  },

  // Always resolves with the same generic message whether or not the email
  // belongs to an account - see backend/src/services/auth.service.ts. There
  // is deliberately nothing here for a caller to branch on.
  async forgotPassword(email: string): Promise<string> {
    const res = await api.post<ApiMessage>('/auth/forgot-password', { email })
    return res.message
  },

  async resetPassword(input: { token: string; password: string; confirmPassword: string }): Promise<string> {
    const res = await api.post<ApiMessage>('/auth/reset-password', input)
    return res.message
  },
}
