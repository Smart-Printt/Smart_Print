import { pipeline } from 'node:stream';

import contentDisposition from 'content-disposition';
import { Response } from 'express';

import * as documentService from '../services/document.service';
import { DownloadableDocument } from '../services/document.service';
import { AuthenticatedRequest } from '../types/auth.types';
import { asyncHandler } from '../utils/asyncHandler';
import { UnauthorizedError, ValidationError } from '../utils/errors';

interface UploadRequest extends AuthenticatedRequest {
  file?: Express.Multer.File;
}

function requireUserId(req: AuthenticatedRequest): string {
  if (!req.user) {
    throw new UnauthorizedError();
  }
  return req.user.userId;
}

function requireUser(req: AuthenticatedRequest): NonNullable<AuthenticatedRequest['user']> {
  if (!req.user) {
    throw new UnauthorizedError();
  }
  return req.user;
}

// Ownership always comes from the JWT (req.user.userId) - the request body,
// query string, and route params are never trusted for it.
export const upload = asyncHandler(async (req: UploadRequest, res: Response) => {
  const userId = requireUserId(req);
  if (!req.file) {
    throw new ValidationError('No file provided');
  }

  const document = await documentService.uploadDocument(userId, {
    buffer: req.file.buffer,
    originalName: req.file.originalname,
    declaredMimeType: req.file.mimetype,
    size: req.file.size,
  });

  res.status(201).json({ success: true, data: { document } });
});

export const list = asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const userId = requireUserId(req);
  const documents = await documentService.listDocumentsForUser(userId);
  res.status(200).json({ success: true, data: { documents } });
});

export const getOne = asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const userId = requireUserId(req);
  const document = await documentService.getDocumentForUser(userId, req.params.id);
  res.status(200).json({ success: true, data: { document } });
});

// The file was already opened by the service, so everything that can fail
// BEFORE this point (not found, no permission, cannot open) has been thrown
// as an ordinary error and answered as JSON by the error handler. From here
// the response is committed, and pipeline() owns both streams:
//   - the file fails mid-way        -> the response is destroyed, so the client
//                                      sees an aborted/incomplete body (the
//                                      Content-Length it was promised never
//                                      arrives) instead of a truncated file that
//                                      looks complete, and nothing is left
//                                      unhandled that could crash the process;
//   - the client disconnects        -> the file stream is destroyed, releasing
//                                      its file descriptor.
function sendDocument(
  res: Response,
  { fileName, mimeType, fileSize, stream }: DownloadableDocument,
  disposition: 'attachment' | 'inline',
): void {
  res.setHeader('Content-Type', mimeType);
  res.setHeader('Content-Length', String(fileSize));
  res.setHeader('Content-Disposition', contentDisposition(fileName, { type: disposition }));

  pipeline(stream, res, (err) => {
    // A client that simply went away is routine, not an error.
    if (err && (err as NodeJS.ErrnoException).code !== 'ERR_STREAM_PREMATURE_CLOSE') {
      // eslint-disable-next-line no-console
      console.error('Document stream failed mid-response:', err);
    }
  });
}

export const download = asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const user = requireUser(req);
  const document = await documentService.getDocumentForDownload(user.userId, user.role, req.params.id);
  sendDocument(res, document, 'attachment');
});

// Same authorization as download, but `inline` so a browser renders a
// supported type (e.g. PDF) directly instead of forcing a save dialog.
export const view = asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const user = requireUser(req);
  const document = await documentService.getDocumentForView(user.userId, user.role, req.params.id);
  sendDocument(res, document, 'inline');
});

export const remove = asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const userId = requireUserId(req);
  await documentService.deleteDocument(userId, req.params.id);
  res.status(200).json({ success: true, message: 'Document deleted successfully' });
});
