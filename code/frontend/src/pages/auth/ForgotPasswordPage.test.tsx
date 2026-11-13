import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { ApiError } from '@/types/api'
import { ForgotPasswordPage } from './ForgotPasswordPage'

const mockForgotPassword = vi.fn()
vi.mock('@/services/authApi', () => ({
  authApi: { forgotPassword: (email: string) => mockForgotPassword(email) },
}))

function renderForgotPasswordPage() {
  return render(
    <MemoryRouter initialEntries={['/forgot-password']}>
      <Routes>
        <Route path="/forgot-password" element={<ForgotPasswordPage />} />
        <Route path="/login" element={<div>Login Page</div>} />
      </Routes>
    </MemoryRouter>,
  )
}

describe('ForgotPasswordPage', () => {
  it('renders a required email field, auto-focused, with a back-to-login link', () => {
    renderForgotPasswordPage()
    const emailInput = screen.getByLabelText(/email/i)
    expect(emailInput).toBeRequired()
    expect(emailInput).toHaveFocus()
    expect(screen.getByRole('link', { name: /back to login/i })).toHaveAttribute('href', '/login')
  })

  it('shows a validation message and does not call the API for an empty email', async () => {
    const user = userEvent.setup()
    renderForgotPasswordPage()

    await user.click(screen.getByRole('button', { name: /send reset link/i }))

    expect(await screen.findByRole('alert')).toHaveTextContent(/enter your email/i)
    expect(mockForgotPassword).not.toHaveBeenCalled()
  })

  it('shows a loading state, calls the real API, and shows a generic success message (never confirming account existence)', async () => {
    let resolveRequest: (value: string) => void = () => {}
    mockForgotPassword.mockReturnValue(
      new Promise((resolve) => {
        resolveRequest = resolve
      }),
    )

    const user = userEvent.setup()
    renderForgotPasswordPage()

    await user.type(screen.getByLabelText(/email/i), 'student@thapar.edu')
    await user.click(screen.getByRole('button', { name: /send reset link/i }))

    expect(mockForgotPassword).toHaveBeenCalledWith('student@thapar.edu')
    expect(await screen.findByRole('button', { name: /sending/i })).toBeDisabled()

    resolveRequest('If an account exists for this email, you will receive password reset instructions.')

    expect(await screen.findByText(/if an account exists/i)).toBeInTheDocument()
    expect(screen.queryByText(/does not exist/i)).not.toBeInTheDocument()
  })

  it('shows the same generic success message even for an email that does not exist', async () => {
    mockForgotPassword.mockResolvedValue('If an account exists for this email, you will receive password reset instructions.')
    const user = userEvent.setup()
    renderForgotPasswordPage()

    await user.type(screen.getByLabelText(/email/i), 'random@example.com')
    await user.click(screen.getByRole('button', { name: /send reset link/i }))

    expect(await screen.findByText(/if an account exists/i)).toBeInTheDocument()
  })

  it('shows a validation error message returned by the backend', async () => {
    mockForgotPassword.mockRejectedValue(new ApiError(400, 'A valid email address is required'))
    const user = userEvent.setup()
    renderForgotPasswordPage()

    await user.type(screen.getByLabelText(/email/i), 'not-an-email')
    await user.click(screen.getByRole('button', { name: /send reset link/i }))

    expect(await screen.findByRole('alert')).toHaveTextContent('A valid email address is required')
  })

  it('shows a network failure message', async () => {
    mockForgotPassword.mockRejectedValue(new ApiError(0, 'Connection lost.'))
    const user = userEvent.setup()
    renderForgotPasswordPage()

    await user.type(screen.getByLabelText(/email/i), 'student@thapar.edu')
    await user.click(screen.getByRole('button', { name: /send reset link/i }))

    expect(await screen.findByRole('alert')).toHaveTextContent(/connection lost/i)
  })

  it('back to login link works after a successful submission', async () => {
    mockForgotPassword.mockResolvedValue('ok')
    const user = userEvent.setup()
    renderForgotPasswordPage()

    await user.type(screen.getByLabelText(/email/i), 'student@thapar.edu')
    await user.click(screen.getByRole('button', { name: /send reset link/i }))

    await waitFor(() => expect(screen.getByText(/check your email/i)).toBeInTheDocument())
    expect(screen.getByRole('link', { name: /back to login/i })).toHaveAttribute('href', '/login')
  })
})

describe('ForgotPasswordPage - rate limiting and server errors', () => {
  beforeEach(() => {
    mockForgotPassword.mockReset()
  })

  async function submit() {
    const user = userEvent.setup()
    renderForgotPasswordPage()
    await user.type(screen.getByLabelText(/email/i), 'student@thapar.edu')
    await user.click(screen.getByRole('button', { name: /send reset link/i }))
  }

  it('when rate limited (429), shows the server message, not "Something went wrong", and stays on the form', async () => {
    mockForgotPassword.mockRejectedValue(new ApiError(429, 'Too many password reset requests. Please try again later.'))
    await submit()

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('Too many password reset requests. Please try again later.')
    expect(alert).not.toHaveTextContent(/something went wrong/i)
    expect(screen.queryByText(/check your email/i)).not.toBeInTheDocument() // never claims an email was sent
    expect(screen.getByRole('button', { name: /send reset link/i })).toBeEnabled()
  })

  it('a 429 without a message still gets a clear "wait and try again" message', async () => {
    mockForgotPassword.mockRejectedValue(new ApiError(429, ''))
    await submit()
    expect(await screen.findByRole('alert')).toHaveTextContent(/too many (requests|attempts)/i)
  })

  it('an unexpected server error keeps the generic message (no internals shown)', async () => {
    mockForgotPassword.mockRejectedValue(new ApiError(500, 'stack trace: db password=hunter2'))
    await submit()
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('Something went wrong. Please try again.')
    expect(alert).not.toHaveTextContent(/hunter2|stack trace/i)
  })
})
