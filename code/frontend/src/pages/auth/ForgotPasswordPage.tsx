import { useState } from 'react'
import type { FormEvent } from 'react'
import { Link } from 'react-router-dom'

import { Button } from '@/components/ui/Button'
import { Icon } from '@/components/ui/Icon'
import { Input } from '@/components/ui/Input'
import { AuthLayout } from '@/layouts/AuthLayout'
import { authApi } from '@/services/authApi'
import { ApiError } from '@/types/api'

function forgotPasswordErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 400) return error.message || 'Please enter a valid email address.'
    // Rate limited: retrying straight away hits the same limit, so say so
    // instead of the generic "something went wrong, try again".
    if (error.status === 429) return error.message || 'Too many requests. Please wait a few minutes and try again.'
    if (error.status === 0) return 'Connection lost. Please check your network and try again.'
  }
  return 'Something went wrong. Please try again.'
}

// Calls the real POST /api/auth/forgot-password endpoint. The backend
// always returns the same generic message whether or not the email belongs
// to an account (see auth.service.ts::requestPasswordReset) - this page has
// nothing to branch on and never claims/denies that an account exists.
export function ForgotPasswordPage() {
  const [email, setEmail] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [submitted, setSubmitted] = useState(false)

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    if (isSubmitting) return
    setError(null)

    if (!email.trim()) {
      setError('Please enter your email address.')
      return
    }

    setIsSubmitting(true)
    try {
      await authApi.forgotPassword(email.trim())
      setSubmitted(true)
    } catch (err) {
      setError(forgotPasswordErrorMessage(err))
    } finally {
      setIsSubmitting(false)
    }
  }

  return (
    <AuthLayout
      heading="Forgot password?"
      subheading="Enter your email and we'll send you instructions to reset your password."
      footer={
        <Link to="/login">
          <Icon name="chevronLeft" size={14} style={{ verticalAlign: -2, marginRight: 2 }} />
          Back to Login
        </Link>
      }
    >
      {submitted ? (
        <div className="auth-info-banner" role="status">
          <Icon name="checkCircle" size={18} />
          <div>
            <strong>Check your email</strong>
            <p>If an account exists for this email, you will receive password reset instructions.</p>
          </div>
        </div>
      ) : (
        <form onSubmit={handleSubmit} noValidate>
          {error && (
            <div className="auth-error-banner" role="alert">
              <Icon name="alert" size={17} />
              <span>{error}</span>
            </div>
          )}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            <Input
              label="Email"
              required
              type="email"
              autoComplete="email"
              placeholder="you@thapar.edu"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoFocus
            />
            <Button type="submit" block size="lg" isLoading={isSubmitting} disabled={isSubmitting}>
              {isSubmitting ? 'Sending...' : 'Send reset link'}
            </Button>
            <p className="auth-required-note">* Required field</p>
          </div>
        </form>
      )}
    </AuthLayout>
  )
}
