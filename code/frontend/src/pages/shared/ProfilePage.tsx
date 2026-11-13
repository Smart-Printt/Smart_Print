import { useState } from 'react'
import type { FormEvent } from 'react'

import { PasswordRules } from '@/components/PasswordRules'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { Icon } from '@/components/ui/Icon'
import { Input } from '@/components/ui/Input'
import { PageHeader } from '@/layouts/AppShell'
import { useAuth } from '@/hooks/useAuth'
import { useToast } from '@/hooks/useToast'
import { ApiError } from '@/types/api'
import type { UserRole } from '@/types'
import { isPasswordValid } from '@/utils/passwordPolicy'

const ROLE_LABEL: Record<UserRole, string> = {
  STUDENT: 'Student',
  FACULTY: 'Faculty',
  SHOP_STAFF: 'Shop Staff',
  ADMIN: 'Administrator',
}

const PHONE_PATTERN = /^\+?[0-9]{7,15}$/

function Row({ icon, label, value }: { icon: 'profile' | 'documents' | 'shop' | 'checkCircle'; label: string; value: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '14px 0', borderBottom: '1px solid var(--color-border)' }}>
      <span style={{ width: 38, height: 38, borderRadius: 12, background: 'var(--color-surface-sunken)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--color-text-secondary)', flexShrink: 0 }}>
        <Icon name={icon} size={18} />
      </span>
      <div>
        <div style={{ fontSize: 12.5, color: 'var(--color-text-muted)', fontWeight: 600, marginBottom: 2 }}>{label}</div>
        <div style={{ fontSize: 15, fontWeight: 600 }}>{value}</div>
      </div>
    </div>
  )
}

// 400 (bad input), 429 (rate limited) and network failures carry a message
// written for the user; anything else gets a generic one.
function errorText(err: unknown): string {
  if (err instanceof ApiError && [0, 400, 429].includes(err.status)) {
    return err.message
  }
  return 'Something went wrong. Please try again.'
}

function FormError({ message }: { message: string | null }) {
  if (!message) return null
  return (
    <div className="auth-error-banner" role="alert">
      <Icon name="alert" size={17} />
      <span>{message}</span>
    </div>
  )
}

function EditProfileCard() {
  const { user, updateProfile } = useAuth()
  const { showToast } = useToast()
  const [name, setName] = useState(user?.name ?? '')
  const [phone, setPhone] = useState(user?.phone ?? '')
  const [error, setError] = useState<string | null>(null)
  const [isSaving, setIsSaving] = useState(false)

  if (!user) return null

  const unchanged = name.trim() === user.name && phone.trim() === (user.phone ?? '')

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    if (isSaving) return
    setError(null)

    const trimmedName = name.trim()
    if (trimmedName.length < 2 || trimmedName.length > 100) {
      setError('Name must be between 2 and 100 characters.')
      return
    }
    const trimmedPhone = phone.trim()
    if (trimmedPhone && !PHONE_PATTERN.test(trimmedPhone)) {
      setError('Phone number must be 7-15 digits, optionally starting with +.')
      return
    }

    setIsSaving(true)
    try {
      const updated = await updateProfile({ name: trimmedName, phone: trimmedPhone })
      setName(updated.name)
      setPhone(updated.phone ?? '')
      showToast('Profile updated.', 'success')
    } catch (err) {
      setError(errorText(err))
    } finally {
      setIsSaving(false)
    }
  }

  return (
    <Card style={{ maxWidth: 480, marginTop: 20 }}>
      <h2 style={{ fontSize: 17, marginBottom: 14 }}>Edit profile</h2>
      <form onSubmit={handleSubmit} noValidate>
        <FormError message={error} />
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <Input label="Full name" required autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} />
          <Input
            label="Phone"
            type="tel"
            autoComplete="tel"
            hint="Optional. Leave empty to remove it."
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
          />
          <Button type="submit" isLoading={isSaving} disabled={isSaving || unchanged}>
            {isSaving ? 'Saving...' : 'Save changes'}
          </Button>
        </div>
      </form>
    </Card>
  )
}

function ChangePasswordCard() {
  const { changePassword } = useAuth()
  const { showToast } = useToast()
  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [isSaving, setIsSaving] = useState(false)

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    if (isSaving) return
    setError(null)

    if (!currentPassword) {
      setError('Enter your current password.')
      return
    }
    if (!isPasswordValid(newPassword)) {
      setError('Please meet all the password requirements below.')
      return
    }
    if (newPassword === currentPassword) {
      setError('New password must be different from your current password.')
      return
    }
    if (newPassword !== confirmPassword) {
      setError('Passwords do not match.')
      return
    }

    setIsSaving(true)
    try {
      await changePassword({ currentPassword, newPassword, confirmPassword })
      setCurrentPassword('')
      setNewPassword('')
      setConfirmPassword('')
      showToast('Password changed. Your other devices have been signed out.', 'success')
    } catch (err) {
      setError(errorText(err))
    } finally {
      setIsSaving(false)
    }
  }

  return (
    <Card style={{ maxWidth: 480, marginTop: 20 }}>
      <h2 style={{ fontSize: 17, marginBottom: 14 }}>Change password</h2>
      <form onSubmit={handleSubmit} noValidate>
        <FormError message={error} />
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <Input
            label="Current password"
            required
            type="password"
            autoComplete="current-password"
            value={currentPassword}
            onChange={(e) => setCurrentPassword(e.target.value)}
          />
          <Input
            label="New password"
            required
            type="password"
            autoComplete="new-password"
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
          />
          <div style={{ marginTop: -8 }}>
            <PasswordRules password={newPassword} />
          </div>
          <Input
            label="Confirm new password"
            required
            type="password"
            autoComplete="new-password"
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
          />
          <Button type="submit" isLoading={isSaving} disabled={isSaving}>
            {isSaving ? 'Changing...' : 'Change password'}
          </Button>
        </div>
      </form>
    </Card>
  )
}

export function ProfilePage() {
  const { user, logout } = useAuth()
  if (!user) return null

  return (
    <div>
      <PageHeader title="Profile" subtitle="Your account details." />
      <Card style={{ maxWidth: 480 }}>
        <Row icon="profile" label="Full name" value={user.name} />
        <Row icon="documents" label="College email" value={user.email} />
        <Row icon="shop" label="Phone" value={user.phone ?? 'Not provided'} />
        <Row icon="checkCircle" label="Account type" value={ROLE_LABEL[user.role]} />
        <div style={{ paddingTop: 20 }}>
          <Button variant="danger" onClick={logout}>
            <Icon name="logout" size={16} />
            Sign out
          </Button>
        </div>
      </Card>
      <EditProfileCard />
      <ChangePasswordCard />
    </div>
  )
}
