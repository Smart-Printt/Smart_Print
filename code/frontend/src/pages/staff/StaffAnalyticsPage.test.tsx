import '@testing-library/jest-dom/vitest'
import { render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { StaffAnalyticsPage } from './StaffAnalyticsPage'

let mockUser: { shopId: string | null } | null = null
vi.mock('@/hooks/useAuth', () => ({ useAuth: () => ({ user: mockUser }) }))

const mockAnalyticsPage = vi.fn()
vi.mock('@/pages/shared/AnalyticsPage', () => ({
  AnalyticsPage: (props: { shopId?: string }) => {
    mockAnalyticsPage(props)
    return <div>analytics for {props.shopId}</div>
  },
}))

beforeEach(() => {
  vi.clearAllMocks()
})

describe('StaffAnalyticsPage', () => {
  it("shows the signed-in staff member's own shop, taken from their account", () => {
    mockUser = { shopId: 'shop-cos' }
    render(<StaffAnalyticsPage />)
    expect(screen.getByText('analytics for shop-cos')).toBeInTheDocument()
    expect(mockAnalyticsPage).toHaveBeenCalledWith({ shopId: 'shop-cos' })
  })

  it('explains an unassigned staff account instead of showing all-shops data', () => {
    mockUser = { shopId: null }
    render(<StaffAnalyticsPage />)
    expect(screen.getByText('No print shop assigned')).toBeInTheDocument()
    expect(mockAnalyticsPage).not.toHaveBeenCalled()
  })
})
