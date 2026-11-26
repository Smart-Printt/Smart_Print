import { prisma } from '../../config/prisma';
import { NotFoundError, ValidationError } from '../../utils/errors';
import { storageService } from '../storage';
import {
  PaperSizeName,
  PrintIssueReport,
  analyzeImage,
  analyzePdf,
  unsupportedFormatReport,
} from './printIssues.analyzer';

const PAPER_SIZES: PaperSizeName[] = ['A4', 'A3', 'A5', 'LETTER', 'LEGAL'];

async function readAll(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
  }
  return Buffer.concat(chunks);
}

export function parsePaperSize(value: unknown): PaperSizeName {
  if (value === undefined || value === '') return 'A4';
  if (typeof value !== 'string' || !PAPER_SIZES.includes(value as PaperSizeName)) {
    throw new ValidationError(`paperSize must be one of: ${PAPER_SIZES.join(', ')}`);
  }
  return value as PaperSizeName;
}

// Owner-only, like getDocumentForUser: someone else's document is a 404.
export async function getPrintIssuesForUser(
  userId: string,
  documentId: string,
  paperSize: PaperSizeName,
): Promise<PrintIssueReport> {
  const document = await prisma.document.findUnique({ where: { documentId } });
  if (!document || document.userId !== userId) {
    throw new NotFoundError('Document not found');
  }
  if (!(await storageService.exists(document.storageKey))) {
    throw new NotFoundError('Document file is not available');
  }

  if (document.fileType !== 'PDF' && document.fileType !== 'JPG' && document.fileType !== 'PNG') {
    return unsupportedFormatReport();
  }

  const buffer = await readAll(await storageService.openReadStream(document.storageKey));
  return document.fileType === 'PDF'
    ? analyzePdf(buffer, paperSize)
    : analyzeImage(buffer, paperSize);
}
