import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { ToastViewport } from '@/components/ui/ToastViewport'
import { AuthContext } from '@/context/AuthContext'
import { ToastProvider } from '@/context/ToastContext'
import { ApiError } from '@/types/api'
import type { SafeUser } from '@/types'
import { ProfilePage } from './ProfilePage'

const USER: SafeUser = {
  userId: 'u1',
  name: 'Asha Verma',
  email: 'asha@thapar.edu',
  phone: '9876500000',
  role: 'STUDENT',
  status: 'ACTIVE',
  shopId: null,
}

const updateProfile = vi.fn()
const changePassword = vi.fn()

function renderPage() {
  return render(
    <MemoryRouter>
      <ToastProvider>
        <AuthContext.Provider
          value={{
            user: USER,
            isLoading: false,
            login: vi.fn(),
            register: vi.fn(),
            logout: vi.fn(),
            updateProfile,
            changePassword,
          }}
        >
          <ProfilePage />
          <ToastViewport />
        </AuthContext.Provider>
      </ToastProvider>
    </MemoryRouter>,
  )
}

beforeEach(() => {
  updateProfile.mockReset()
  changePassword.mockReset()
})

describe('ProfilePage - edit profile', () => {
  it('starts with the current values and a disabled save button', () => {
    renderPage()
    expect(screen.getByLabelText(/full name/i)).toHaveValue('Asha Verma')
    expect(screen.getByLabelText(/phone/i)).toHaveValue('9876500000')
    expect(screen.getByRole('button', { name: /save changes/i })).toBeDisabled()
  })

  it('saves a changed name and phone', async () => {
    updateProfile.mockResolvedValue({ ...USER, name: 'Asha V', phone: '' })
    const user = userEvent.setup()
    renderPage()

    await user.clear(screen.getByLabelText(/full name/i))
    await user.type(screen.getByLabelText(/full name/i), 'Asha V')
    await user.clear(screen.getByLabelText(/phone/i))
    await user.click(screen.getByRole('button', { name: /save changes/i }))

    expect(updateProfile).toHaveBeenCalledWith({ name: 'Asha V', phone: '' })
    expect(await screen.findByText('Profile updated.')).toBeInTheDocument()
  })

  it('rejects a too-short name and a bad phone number without calling the API', async () => {
    const user = userEvent.setup()
    renderPage()

    await user.clear(screen.getByLabelText(/full name/i))
    await user.type(screen.getByLabelText(/full name/i), 'A')
    await user.click(screen.getByRole('button', { name: /save changes/i }))
    expect(screen.getByRole('alert')).toHaveTextContent(/between 2 and 100/i)

    await user.clear(screen.getByLabelText(/full name/i))
    await user.type(screen.getByLabelText(/full name/i), 'Asha V')
    await user.clear(screen.getByLabelText(/phone/i))
    await user.type(screen.getByLabelText(/phone/i), 'abc')
    await user.click(screen.getByRole('button', { name: /save changes/i }))
    expect(screen.getByRole('alert')).toHaveTextContent(/7-15 digits/i)

    expect(updateProfile).not.toHaveBeenCalled()
  })

  it('shows the server message when saving fails', async () => {
    updateProfile.mockRejectedValue(new ApiError(400, 'Phone number must be a valid number (7-15 digits)'))
    const user = userEvent.setup()
    renderPage()

    await user.type(screen.getByLabelText(/full name/i), 'x')
    await user.click(screen.getByRole('button', { name: /save changes/i }))

    expect(await screen.findByRole('alert')).toHaveTextContent(/valid number/i)
  })
})

describe('ProfilePage - change password', () => {
  async function fill(current: string, next: string, confirm: string) {
    const user = userEvent.setup()
    await user.type(screen.getByLabelText(/current password/i), current)
    await user.type(screen.getByLabelText(/^new password/i), next)
    await user.type(screen.getByLabelText(/confirm new password/i), confirm)
    await user.click(screen.getByRole('button', { name: /^change password$/i }))
  }

  it('changes the password and clears the form', async () => {
    changePassword.mockResolvedValue(undefined)
    renderPage()

    await fill('OldPassword1', 'BrandNewPass456', 'BrandNewPass456')

    expect(changePassword).toHaveBeenCalledWith({
      currentPassword: 'OldPassword1',
      newPassword: 'BrandNewPass456',
      confirmPassword: 'BrandNewPass456',
    })
    expect(await screen.findByText(/other devices have been signed out/i)).toBeInTheDocument()
    await waitFor(() => expect(screen.getByLabelText(/current password/i)).toHaveValue(''))
  })

  it.each([
    ['a password that breaks the rules', 'OldPassword1', 'short', 'short', /meet all the password requirements/i],
    ['a password equal to the current one', 'OldPassword1', 'OldPassword1', 'OldPassword1', /different from your current/i],
    ['mismatched confirmation', 'OldPassword1', 'BrandNewPass456', 'Other12345', /do not match/i],
  ])('blocks %s without calling the API', async (_label, current, next, confirm, message) => {
    renderPage()
    await fill(current, next, confirm)
    expect(screen.getByRole('alert')).toHaveTextContent(message)
    expect(changePassword).not.toHaveBeenCalled()
  })

  it('shows "current password is incorrect" from the server and keeps the form', async () => {
    changePassword.mockRejectedValue(new ApiError(400, 'Current password is incorrect'))
    renderPage()

    await fill('WrongPassword1', 'BrandNewPass456', 'BrandNewPass456')

    expect(await screen.findByRole('alert')).toHaveTextContent('Current password is incorrect')
    expect(screen.getByLabelText(/current password/i)).toHaveValue('WrongPassword1')
  })

  it('shows a rate-limit message', async () => {
    changePassword.mockRejectedValue(new ApiError(429, 'Too many password change attempts. Please try again later.'))
    renderPage()

    await fill('OldPassword1', 'BrandNewPass456', 'BrandNewPass456')

    expect(await screen.findByRole('alert')).toHaveTextContent(/too many password change attempts/i)
  })
})
