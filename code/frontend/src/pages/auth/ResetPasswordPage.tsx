import { useState } from 'react'
import type { FormEvent } from 'react'
import { Link, useSearchParams } from 'react-router-dom'

import { PasswordRules } from '@/components/PasswordRules'
import { Button } from '@/components/ui/Button'
import { Icon } from '@/components/ui/Icon'
import { Input } from '@/components/ui/Input'
import { AuthLayout } from '@/layouts/AuthLayout'
import { authApi } from '@/services/authApi'
import { ApiError } from '@/types/api'
import { isPasswordValid } from '@/utils/passwordPolicy'

const BackToLogin = (
  <Link to="/login">
    <Icon name="chevronLeft" size={14} style={{ verticalAlign: -2, marginRight: 2 }} />
    Back to Login
  </Link>
)

function InvalidLinkState() {
  return (
    <AuthLayout
      heading="Reset your password"
      subheading="Set a new password for your SmartPrint account."
      footer={BackToLogin}
    >
      <div className="auth-error-banner" role="alert">
        <Icon name="alert" size={17} />
        <span>This password reset link is invalid or has expired.</span>
      </div>
      <Link to="/forgot-password">
        <Button block size="lg" variant="secondary">
          Request a new reset link
        </Button>
      </Link>
    </AuthLayout>
  )
}

function resetPasswordErrorMessage(error: unknown): { message: string; isInvalidToken: boolean } {
  if (error instanceof ApiError) {
    if (error.status === 401) {
      return { message: 'This password reset link is invalid or has expired.', isInvalidToken: true }
    }
    if (error.status === 400) {
      return { message: error.message || 'Please check your details and try again.', isInvalidToken: false }
    }
    if (error.status === 429) {
      // Rate limited, NOT a bad link: the token is still valid, so keep the form.
      return {
        message: error.message || 'Too many attempts. Please wait a few minutes and try again.',
        isInvalidToken: false,
      }
    }
    if (error.status === 0) {
      return { message: 'Connection lost. Please check your network and try again.', isInvalidToken: false }
    }
  }
  return { message: 'Something went wrong. Please try again.', isInvalidToken: false }
}

// The reset token is read from the URL and used only for the one
// POST /api/auth/reset-password call below - it is never written to
// localStorage/sessionStorage and never sent to any other endpoint.
export function ResetPasswordPage() {
  const [searchParams] = useSearchParams()
  const token = searchParams.get('token')

  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [invalidToken, setInvalidToken] = useState(false)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [succeeded, setSucceeded] = useState(false)

  const passwordValid = isPasswordValid(password)

  if (!token) {
    return <InvalidLinkState />
  }

  if (invalidToken) {
    return <InvalidLinkState />
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    if (isSubmitting || !token) return
    setError(null)

    if (!passwordValid) {
      setError('Please meet all password requirements below.')
      return
    }
    if (password !== confirmPassword) {
      setError('Passwords do not match.')
      return
    }

    setIsSubmitting(true)
    try {
      await authApi.resetPassword({ token, password, confirmPassword })
      setSucceeded(true)
    } catch (err) {
      const { message, isInvalidToken } = resetPasswordErrorMessage(err)
      if (isInvalidToken) {
        setInvalidToken(true)
      } else {
        setError(message)
      }
    } finally {
      setIsSubmitting(false)
    }
  }

  if (succeeded) {
    return (
      <AuthLayout
        heading="Reset your password"
        subheading="Set a new password for your SmartPrint account."
        footer={BackToLogin}
      >
        <div className="auth-info-banner" role="status">
          <Icon name="checkCircle" size={18} />
          <div>
            <strong>Password reset</strong>
            <p>Your password has been reset successfully. You can now log in with your new password.</p>
          </div>
        </div>
        <Link to="/login">
          <Button block size="lg">
            Back to Login
          </Button>
        </Link>
      </AuthLayout>
    )
  }

  return (
    <AuthLayout heading="Reset your password" subheading="Choose a new password for your SmartPrint account." footer={BackToLogin}>
      <form onSubmit={handleSubmit} noValidate>
        {error && (
          <div className="auth-error-banner" role="alert">
            <Icon name="alert" size={17} />
            <span>{error}</span>
          </div>
        )}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <Input
            label="New password"
            required
            type="password"
            autoComplete="new-password"
            placeholder="Create a new password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoFocus
          />
          <div style={{ marginTop: -8 }}>
            <PasswordRules password={password} />
          </div>
          <Input
            label="Confirm password"
            required
            type="password"
            autoComplete="new-password"
            placeholder="Re-enter your new password"
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
          />
          <Button type="submit" block size="lg" isLoading={isSubmitting} disabled={isSubmitting}>
            {isSubmitting ? 'Resetting...' : 'Reset Password'}
          </Button>
          <p className="auth-required-note">* Required field</p>
        </div>
      </form>
    </AuthLayout>
  )
}
