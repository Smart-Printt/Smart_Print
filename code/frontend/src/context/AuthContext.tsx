import { createContext, useCallback, useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'

import { authApi } from '@/services/authApi'
import { clearToken, getToken, onUnauthorized, setToken } from '@/services/apiClient'
import type { SafeUser } from '@/types'

interface AuthContextValue {
  user: SafeUser | null
  isLoading: boolean
  login: (email: string, password: string) => Promise<SafeUser>
  register: (input: { name: string; email: string; phone?: string; password: string }) => Promise<SafeUser>
  logout: () => void
  updateProfile: (input: { name?: string; phone?: string }) => Promise<SafeUser>
  changePassword: (input: { currentPassword: string; newPassword: string; confirmPassword: string }) => Promise<void>
}

// eslint-disable-next-line react-refresh/only-export-components
export const AuthContext = createContext<AuthContextValue | null>(null)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<SafeUser | null>(null)
  const [isLoading, setIsLoading] = useState(true)

  useEffect(() => {
    let cancelled = false

    async function restoreSession() {
      const token = getToken()
      if (!token) {
        setIsLoading(false)
        return
      }
      try {
        const restoredUser = await authApi.me()
        if (!cancelled) {
          setUser(restoredUser)
        }
      } catch {
        clearToken()
      } finally {
        if (!cancelled) {
          setIsLoading(false)
        }
      }
    }

    void restoreSession()
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    onUnauthorized(() => {
      setUser(null)
    })
  }, [])

  const login = useCallback(async (email: string, password: string) => {
    const result = await authApi.login({ email, password })
    setToken(result.token)
    setUser(result.user)
    return result.user
  }, [])

  const register = useCallback(
    async (input: { name: string; email: string; phone?: string; password: string }) => {
      const result = await authApi.register(input)
      setToken(result.token)
      setUser(result.user)
      return result.user
    },
    [],
  )

  const logout = useCallback(() => {
    clearToken()
    setUser(null)
    void authApi.logout().catch(() => {})
  }, [])

  const updateProfile = useCallback(async (input: { name?: string; phone?: string }) => {
    const updated = await authApi.updateProfile(input)
    setUser(updated)
    return updated
  }, [])

  const changePassword = useCallback(
    async (input: { currentPassword: string; newPassword: string; confirmPassword: string }) => {
      const result = await authApi.changePassword(input)
      setToken(result.token)
      setUser(result.user)
    },
    [],
  )

  const value = useMemo(
    () => ({ user, isLoading, login, register, logout, updateProfile, changePassword }),
    [user, isLoading, login, register, logout, updateProfile, changePassword],
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}
