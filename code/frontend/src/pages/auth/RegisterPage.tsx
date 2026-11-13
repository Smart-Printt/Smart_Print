import { useState } from 'react'
import type { FormEvent } from 'react'
import { Link, useNavigate } from 'react-router-dom'

import { PasswordRules } from '@/components/PasswordRules'
import { Button } from '@/components/ui/Button'
import { Icon } from '@/components/ui/Icon'
import { Input } from '@/components/ui/Input'
import { useAuth } from '@/hooks/useAuth'
import { AuthLayout } from '@/layouts/AuthLayout'
import { homeRouteForRole } from '@/routes/guards'
import { ApiError } from '@/types/api'
import { isPasswordValid } from '@/utils/passwordPolicy'

function registerErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 409) return 'An account with this email already exists.'
    if (error.status === 400) return error.message || 'Please check your details and try again.'
    if (error.status === 0) return 'Connection lost. Please check your network and try again.'
  }
  return 'Something went wrong. Please try again.'
}

export function RegisterPage() {
  const { register } = useAuth()
  const navigate = useNavigate()
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [phone, setPhone] = useState('')
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [isSubmitting, setIsSubmitting] = useState(false)

  const passwordValid = isPasswordValid(password)

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    if (isSubmitting) return
    setError(null)

    if (name.trim().length < 2) {
      setError('Please enter your full name.')
      return
    }
    if (!email.trim()) {
      setError('Please enter your college email.')
      return
    }
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
      const user = await register({
        name: name.trim(),
        email: email.trim(),
        phone: phone.trim() || undefined,
        password,
      })
      navigate(homeRouteForRole(user.role), { replace: true })
    } catch (err) {
      setError(registerErrorMessage(err))
    } finally {
      setIsSubmitting(false)
    }
  }

  return (
    <AuthLayout
      heading="Create your account"
      subheading="Use your Thapar college email to create a student account."
      footer={
        <>
          Already have an account? <Link to="/login">Sign in</Link>
        </>
      }
    >
      <form onSubmit={handleSubmit} noValidate>
        {error && (
          <div className="auth-error-banner" role="alert">
            <Icon name="alert" size={17} />
            <span>{error}</span>
          </div>
        )}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <Input
            label="Full name"
            required
            placeholder="Jane Doe"
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoFocus
          />
          <Input
            label="Thapar email"
            required
            type="email"
            hint="Use your Thapar college email address."
            placeholder="you@thapar.edu"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
          <Input
            label="Phone"
            hint="Optional"
            type="tel"
            placeholder="9876543210"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
          />
          <Input
            label="Password"
            required
            type="password"
            placeholder="Create a password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          <div style={{ marginTop: -8 }}>
            <PasswordRules password={password} />
          </div>
          <Input
            label="Confirm password"
            required
            type="password"
            placeholder="Re-enter your password"
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
          />
          <Button type="submit" block size="lg" isLoading={isSubmitting} disabled={isSubmitting}>
            {isSubmitting ? 'Creating account...' : 'Create account'}
          </Button>
          <p className="auth-required-note">* Required field</p>
        </div>
      </form>
    </AuthLayout>
  )
}
