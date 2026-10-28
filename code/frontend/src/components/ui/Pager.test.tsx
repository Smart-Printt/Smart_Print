import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

import { Pager } from './Pager'

describe('Pager', () => {
  it('renders nothing when everything fits on one page', () => {
    const { container } = render(<Pager page={1} totalPages={1} total={4} onPageChange={vi.fn()} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('shows where you are', () => {
    render(<Pager page={2} totalPages={5} total={42} onPageChange={vi.fn()} />)
    expect(screen.getByText('Page 2 of 5 · 42 orders')).toBeInTheDocument()
  })

  it('moves to the previous and next page', async () => {
    const onPageChange = vi.fn()
    const user = userEvent.setup()
    render(<Pager page={2} totalPages={3} total={25} onPageChange={onPageChange} />)

    await user.click(screen.getByRole('button', { name: /next/i }))
    await user.click(screen.getByRole('button', { name: /previous/i }))

    expect(onPageChange).toHaveBeenNthCalledWith(1, 3)
    expect(onPageChange).toHaveBeenNthCalledWith(2, 1)
  })

  it('disables Previous on the first page and Next on the last', () => {
    const { rerender } = render(<Pager page={1} totalPages={3} total={25} onPageChange={vi.fn()} />)
    expect(screen.getByRole('button', { name: /previous/i })).toBeDisabled()
    expect(screen.getByRole('button', { name: /next/i })).toBeEnabled()

    rerender(<Pager page={3} totalPages={3} total={25} onPageChange={vi.fn()} />)
    expect(screen.getByRole('button', { name: /next/i })).toBeDisabled()
  })
})
