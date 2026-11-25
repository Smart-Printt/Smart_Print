export type DocumentFileType = 'PDF' | 'DOC' | 'DOCX' | 'XLS' | 'XLSX' | 'PPT' | 'PPTX' | 'JPG' | 'PNG'

export interface SafeDocument {
  documentId: string
  fileName: string
  fileUrl: string
  fileType: DocumentFileType
  mimeType: string
  fileSize: number
  fileHash: string
  pageCount: number | null
  uploadedAt: string
  /** True once an order references this document - it can then no longer be deleted. */
  isUsedInOrder?: boolean
}

export type PrintIssueCode =
  | 'BLANK_LAST_PAGE'
  | 'MIXED_ORIENTATION'
  | 'LANDSCAPE_ON_PORTRAIT'
  | 'PAGE_SIZE_MISMATCH'
  | 'TINY_TEXT'
  | 'LOW_RESOLUTION'

export interface PrintIssue {
  code: PrintIssueCode
  severity: 'warning' | 'info'
  message: string
  pages?: number[]
}

export interface PrintIssueReport {
  analyzed: boolean
  note?: string
  issues: PrintIssue[]
}
