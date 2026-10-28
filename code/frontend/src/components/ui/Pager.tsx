import { Button } from './Button'
import { Icon } from './Icon'

interface PagerProps {
  page: number
  totalPages: number
  total: number
  onPageChange: (page: number) => void
  disabled?: boolean
}

// Previous / Next controls under a paginated list. Renders nothing when
// everything fits on one page.
export function Pager({ page, totalPages, total, onPageChange, disabled }: PagerProps) {
  if (totalPages <= 1) return null

  return (
    <nav
      aria-label="Pagination"
      style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginTop: 18 }}
    >
      <Button variant="secondary" size="sm" disabled={disabled || page <= 1} onClick={() => onPageChange(page - 1)}>
        <Icon name="chevronLeft" size={14} />
        Previous
      </Button>
      <span className="text-secondary" style={{ fontSize: 13 }} aria-live="polite">
        Page {page} of {totalPages} · {total} orders
      </span>
      <Button variant="secondary" size="sm" disabled={disabled || page >= totalPages} onClick={() => onPageChange(page + 1)}>
        Next
        <Icon name="chevronRight" size={14} />
      </Button>
    </nav>
  )
}
