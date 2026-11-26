import { api, fetchAuthorizedBlob } from './apiClient'
import type { ApiSuccess, PaperSize, PrintIssueReport, SafeDocument } from '@/types'

export const documentApi = {
  async upload(file: File): Promise<SafeDocument> {
    const formData = new FormData()
    formData.append('file', file)
    const res = await api.postForm<ApiSuccess<{ document: SafeDocument }>>('/documents', formData)
    return res.data.document
  },

  async list(): Promise<SafeDocument[]> {
    const res = await api.get<ApiSuccess<{ documents: SafeDocument[] }>>('/documents')
    return res.data.documents
  },

  async getOne(id: string): Promise<SafeDocument> {
    const res = await api.get<ApiSuccess<{ document: SafeDocument }>>(`/documents/${id}`)
    return res.data.document
  },

  async printIssues(id: string, paperSize: PaperSize): Promise<PrintIssueReport> {
    const res = await api.get<ApiSuccess<PrintIssueReport>>(`/documents/${id}/print-issues?paperSize=${paperSize}`)
    return res.data
  },

  async remove(id: string): Promise<void> {
    await api.delete(`/documents/${id}`)
  },

  async download(id: string, fileName: string): Promise<void> {
    const blob = await fetchAuthorizedBlob(`/documents/${id}/download`)
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = fileName
    document.body.appendChild(link)
    link.click()
    link.remove()
    URL.revokeObjectURL(url)
  },

  // Same authorization as download, served with an inline Content-Disposition
  // so a supported type (PDF) can be rendered directly rather than downloaded.
  async view(id: string): Promise<Blob> {
    return fetchAuthorizedBlob(`/documents/${id}/view`)
  },
}
