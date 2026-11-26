import { DocumentFileType } from '../config/documentTypes';

// Document fields safe to return in API responses - never a filesystem
// path or the internal storageKey.
export interface SafeDocument {
  documentId: string;
  fileName: string;
  fileUrl: string;
  fileType: DocumentFileType;
  mimeType: string;
  fileSize: number;
  fileHash: string;
  pageCount: number | null;
  uploadedAt: Date;
  // Set on the list endpoint only: true once any order references this
  // document, which is exactly when deletion is refused.
  isUsedInOrder?: boolean;
}

export interface UploadedFileInput {
  buffer: Buffer;
  originalName: string;
  declaredMimeType: string;
  size: number;
}
