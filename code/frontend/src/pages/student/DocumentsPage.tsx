import { useCallback, useEffect, useRef, useState } from 'react'
import type { DragEvent } from 'react'
import { useNavigate } from 'react-router-dom'

import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { ConfirmModal } from '@/components/ui/Modal'
import { Icon } from '@/components/ui/Icon'
import { SkeletonCardList } from '@/components/ui/Skeleton'
import { ErrorState, StateBlock } from '@/components/ui/StateBlock'
import { PageHeader } from '@/layouts/AppShell'
import { documentApi } from '@/services/documentApi'
import { useToast } from '@/hooks/useToast'
import type { SafeDocument } from '@/types'
import { ApiError } from '@/types/api'
import { formatDateTime } from '@/utils/date'

const ACCEPTED_EXTENSIONS = ['.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.jpg', '.jpeg', '.png']
const ACCEPT_ATTR = ACCEPTED_EXTENSIONS.join(',')

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function uploadErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 413) return 'This file is too large to upload.'
    if (error.status === 400) return error.message || 'This file type is not supported.'
  }
  return 'Upload failed. Please try again.'
}

export function DocumentsPage() {
  const navigate = useNavigate()
  const { showToast } = useToast()
  const [documents, setDocuments] = useState<SafeDocument[] | null>(null)
  const [error, setError] = useState<unknown>(null)
  const [isUploading, setIsUploading] = useState(false)
  const [uploadError, setUploadError] = useState<string | null>(null)
  const [isDragOver, setIsDragOver] = useState(false)
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null)
  const [isDeleting, setIsDeleting] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const load = useCallback(async () => {
    setError(null)
    try {
      const docs = await documentApi.list()
      setDocuments(docs)
    } catch (err) {
      setError(err)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  async function handleFiles(files: FileList | null) {
    const file = files?.[0]
    if (!file) return
    setUploadError(null)
    setIsUploading(true)
    try {
      const doc = await documentApi.upload(file)
      setDocuments((current) => (current ? [doc, ...current] : [doc]))
      showToast('Document uploaded successfully.', 'success')
    } catch (err) {
      setUploadError(uploadErrorMessage(err))
    } finally {
      setIsUploading(false)
    }
  }

  function onDrop(e: DragEvent<HTMLDivElement>) {
    e.preventDefault()
    setIsDragOver(false)
    void handleFiles(e.dataTransfer.files)
  }

  async function confirmDelete() {
    if (!pendingDeleteId) return
    setIsDeleting(true)
    try {
      await documentApi.remove(pendingDeleteId)
      setDocuments((current) => current?.filter((d) => d.documentId !== pendingDeleteId) ?? null)
      showToast('Document deleted.', 'success')
      setPendingDeleteId(null)
    } catch (err) {
      const message = err instanceof ApiError && err.status === 409
        ? 'This document is used in an order and cannot be deleted.'
        : 'Could not delete this document.'
      showToast(message, 'error')
    } finally {
      setIsDeleting(false)
    }
  }

  async function handleDownload(doc: SafeDocument) {
    try {
      await documentApi.download(doc.documentId, doc.fileName)
    } catch {
      showToast('Could not download this file.', 'error')
    }
  }

  return (
    <div>
      <PageHeader title="My Documents" subtitle="Upload once, print anywhere on campus." />

      <Card padded className="upload-dropzone">
        <div
          onDragOver={(e) => {
            e.preventDefault()
            setIsDragOver(true)
          }}
          onDragLeave={() => setIsDragOver(false)}
          onDrop={onDrop}
          style={{
            border: `2px dashed ${isDragOver ? 'var(--color-primary)' : 'var(--color-border-strong)'}`,
            borderRadius: 14,
            padding: '36px 20px',
            textAlign: 'center',
            background: isDragOver ? 'var(--color-primary-soft)' : 'transparent',
            transition: 'all 150ms ease',
          }}
        >
          <input
            ref={fileInputRef}
            type="file"
            accept={ACCEPT_ATTR}
            hidden
            onChange={(e) => void handleFiles(e.target.files)}
          />
          <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 10, color: 'var(--color-primary)' }}>
            <Icon name="upload" size={30} />
          </div>
          <p style={{ fontWeight: 700, marginBottom: 4 }}>
            {isDragOver ? 'Drop your document here' : 'Drop your document here'}
          </p>
          <p className="text-secondary" style={{ fontSize: 13.5, marginBottom: 16 }}>
            PDF, Word, Excel, PowerPoint, JPG, or PNG
          </p>
          <Button onClick={() => fileInputRef.current?.click()} isLoading={isUploading} variant="secondary">
            Choose a file
          </Button>
          {uploadError && (
            <p className="text-danger" style={{ fontSize: 13, marginTop: 12, fontWeight: 500 }}>
              {uploadError}
            </p>
          )}
        </div>
      </Card>

      <div style={{ height: 28 }} />

      {error ? (
        <ErrorState error={error} onRetry={load} />
      ) : documents === null ? (
        <SkeletonCardList count={3} height={78} />
      ) : documents.length === 0 ? (
        <StateBlock icon="documents" title="No documents yet" description="Upload your first document and start printing." />
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {documents.map((doc) => (
            <Card key={doc.documentId} padded className="doc-row">
              <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
                <span style={{ width: 42, height: 42, borderRadius: 12, background: 'var(--color-primary-soft)', color: 'var(--color-primary)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                  <Icon name="documents" size={19} />
                </span>
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div style={{ fontWeight: 700, fontSize: 14.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {doc.fileName}
                  </div>
                  <div className="text-muted" style={{ fontSize: 12.5, marginTop: 2 }}>
                    {doc.pageCount ? `${doc.pageCount} pages · ` : ''}
                    {formatSize(doc.fileSize)} · Uploaded {formatDateTime(doc.uploadedAt)}
                  </div>
                </div>
                <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
                  <Button size="sm" onClick={() => navigate(`/print?documentId=${doc.documentId}`)}>
                    Print
                  </Button>
                  <Button size="icon" variant="ghost" aria-label="Download" onClick={() => void handleDownload(doc)}>
                    <Icon name="download" size={17} />
                  </Button>
                  {/* Documents used in an order are kept for order records and re-printing, so no delete option is offered for them. */}
                  {!doc.isUsedInOrder && (
                    <Button size="icon" variant="ghost" aria-label="Delete" onClick={() => setPendingDeleteId(doc.documentId)}>
                      <Icon name="trash" size={17} />
                    </Button>
                  )}
                </div>
              </div>
            </Card>
          ))}
        </div>
      )}

      <ConfirmModal
        isOpen={!!pendingDeleteId}
        title="Delete this document?"
        description="This can't be undone."
        confirmLabel="Delete"
        danger
        isLoading={isDeleting}
        onConfirm={confirmDelete}
        onCancel={() => setPendingDeleteId(null)}
      />
    </div>
  )
}
