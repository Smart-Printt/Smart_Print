import { useEffect, useState } from 'react'

import { documentApi } from '@/services/documentApi'
import type { PaperSize, PrintIssueReport } from '@/types'

interface PrintIssuesNoticeProps {
  documentId: string
  paperSize: PaperSize
}

// Advisory only: shows what the backend's static checks found (blank last
// page, orientation, tiny text, low-resolution image) and never blocks the
// order. A failed check shows nothing rather than an error - the student can
// still print.
export function PrintIssuesNotice({ documentId, paperSize }: PrintIssuesNoticeProps) {
  const [report, setReport] = useState<PrintIssueReport | null>(null)

  useEffect(() => {
    let cancelled = false
    setReport(null)
    documentApi
      .printIssues(documentId, paperSize)
      .then((r) => {
        if (!cancelled) setReport(r)
      })
      .catch(() => {
        if (!cancelled) setReport(null)
      })
    return () => {
      cancelled = true
    }
  }, [documentId, paperSize])

  if (!report || report.issues.length === 0) return null

  return (
    <div
      role="status"
      aria-label="Print checks"
      style={{
        background: 'var(--color-warning-soft)',
        color: 'var(--color-warning)',
        borderRadius: 12,
        padding: '12px 14px',
        marginBottom: 16,
        fontSize: 13,
      }}
    >
      <div style={{ fontWeight: 800, marginBottom: 6 }}>Check before you print</div>
      <ul style={{ margin: 0, paddingLeft: 18, display: 'flex', flexDirection: 'column', gap: 4 }}>
        {report.issues.map((issue) => (
          <li key={issue.code}>{issue.message}</li>
        ))}
      </ul>
    </div>
  )
}
