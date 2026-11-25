import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { PrintIssuesNotice } from './PrintIssuesNotice'

const mockPrintIssues = vi.fn()
vi.mock('@/services/documentApi', () => ({
  documentApi: { printIssues: (id: string, paper: string) => mockPrintIssues(id, paper) },
}))

describe('PrintIssuesNotice', () => {
  it('lists the issues the backend found', async () => {
    mockPrintIssues.mockResolvedValue({
      analyzed: true,
      issues: [{ code: 'BLANK_LAST_PAGE', severity: 'warning', message: 'Page 3 looks blank.' }],
    })
    render(<PrintIssuesNotice documentId="d1" paperSize="A4" />)
    expect(await screen.findByText('Page 3 looks blank.')).toBeInTheDocument()
    expect(mockPrintIssues).toHaveBeenCalledWith('d1', 'A4')
  })

  it('renders nothing when there are no issues or the check fails', async () => {
    mockPrintIssues.mockResolvedValue({ analyzed: true, issues: [] })
    const { container, rerender } = render(<PrintIssuesNotice documentId="d2" paperSize="A4" />)
    await Promise.resolve()
    expect(container).toBeEmptyDOMElement()

    mockPrintIssues.mockRejectedValue(new Error('boom'))
    rerender(<PrintIssuesNotice documentId="d3" paperSize="A4" />)
    await Promise.resolve()
    expect(container).toBeEmptyDOMElement()
  })
})
