import { imageSize } from 'image-size';
import { PDFArray, PDFDocument, PDFPage, PDFRawStream, decodePDFRawStream } from 'pdf-lib';

// Heuristic, static print-issue detection. Everything here is an ESTIMATE
// from the file's structure - it never renders the document. Each issue is
// a warning the student can ignore, never a blocker.

export type PaperSizeName = 'A4' | 'A3' | 'A5' | 'LETTER' | 'LEGAL';

// Portrait dimensions in PDF points (1/72 inch).
const PAPER_POINTS: Record<PaperSizeName, { w: number; h: number }> = {
  A4: { w: 595.28, h: 841.89 },
  A3: { w: 841.89, h: 1190.55 },
  A5: { w: 419.53, h: 595.28 },
  LETTER: { w: 612, h: 792 },
  LEGAL: { w: 612, h: 1008 },
};

export type PrintIssueCode =
  | 'BLANK_LAST_PAGE'
  | 'MIXED_ORIENTATION'
  | 'LANDSCAPE_ON_PORTRAIT'
  | 'PAGE_SIZE_MISMATCH'
  | 'TINY_TEXT'
  | 'LOW_RESOLUTION';

export interface PrintIssue {
  code: PrintIssueCode;
  severity: 'warning' | 'info';
  message: string;
  pages?: number[];
}

export interface PrintIssueReport {
  analyzed: boolean;
  // Why nothing was checked (e.g. Office formats cannot be inspected
  // without a layout engine). Never silently "no issues".
  note?: string;
  issues: PrintIssue[];
}

export const MIN_READABLE_FONT_PT = 7;
export const LOW_DPI = 150;
export const VERY_LOW_DPI = 100;
const SIZE_TOLERANCE = 0.05;
const MAX_PAGES_SCANNED_FOR_TEXT = 200;

function orientationOf(w: number, h: number): 'portrait' | 'landscape' {
  return w > h ? 'landscape' : 'portrait';
}

// Returns the decoded content stream, '' for a page with no content, or
// null when it cannot be decoded (unknown - never treated as "blank").
function decodedContent(page: PDFPage): string | null {
  const contents = page.node.Contents();
  if (!contents) return '';
  const context = page.doc.context;
  const parts =
    contents instanceof PDFArray ? contents.asArray().map((o) => context.lookup(o)) : [contents];
  const chunks: string[] = [];
  for (const part of parts) {
    if (!(part instanceof PDFRawStream)) return null;
    try {
      chunks.push(Buffer.from(decodePDFRawStream(part).decode()).toString('latin1'));
    } catch {
      return null;
    }
  }
  return chunks.join('\n');
}

// A page is blank when its content stream paints nothing: no visible
// text-show, no XObject/image/shading, no inline image, no fill/stroke.
export function isContentBlank(content: string): boolean {
  // Literal "(..) Tj", hex "<..> Tj" (what embedded fonts produce) and
  // "[..] TJ" arrays whose strings may be either form.
  const textShown = /(\((?:\\.|[^\\)])*\)|<[0-9a-fA-F\s]*>)\s*Tj|\[([\s\S]*?)\]\s*TJ/g;
  let m: RegExpExecArray | null;
  while ((m = textShown.exec(content)) !== null) {
    const shown = m[1] ?? m[2] ?? '';
    // Any non-empty hex string counts as content (glyph ids can't be
    // decoded here); literal strings must hold a non-space character.
    if (/<[0-9a-fA-F]{2,}>/.test(shown) || /\(\s*[^\s)]/.test(shown)) return false;
  }
  if (/(^|\s)(Do|sh|BI)(\s|$)/.test(content)) return false;
  if (/(^|\s)(f\*?|F|S|s|B\*?|b\*?)(\s|$)/.test(content)) return false;
  return true;
}

export interface FontStats {
  total: number;
  small: number;
  smallestPt: number;
}

// Tracks the `Tf` font size, scaled by the latest text matrix `Tm`, at each
// text-show operator. Ignores the CTM (`cm`), so a page scaled via `cm` can
// be mis-estimated - hence "estimate" in the user-facing message.
export function measureFontSizes(content: string): FontStats {
  const stats: FontStats = { total: 0, small: 0, smallestPt: Infinity };
  let size = 0;
  let scale = 1;
  const num = '(-?\\d*\\.?\\d+)';
  const tm = `${num}\\s+${num}\\s+${num}\\s+${num}\\s+${num}\\s+${num}\\s+Tm`;
  const tf = `/[^\\s/\\[\\]()<>]+\\s+${num}\\s+Tf`;
  const tokenizer = new RegExp(`${tm}|${tf}|(Tj|TJ)\\b|(BT)\\b`, 'g');

  for (const t of content.matchAll(tokenizer)) {
    if (t[9] === 'BT') {
      scale = 1;
    } else if (t[1] !== undefined) {
      scale = Math.hypot(Number(t[1]), Number(t[2])) || 1;
    } else if (t[7] !== undefined) {
      size = Math.abs(Number(t[7]));
    } else if (t[8] !== undefined && size > 0) {
      const effective = size * scale;
      stats.total += 1;
      stats.smallestPt = Math.min(stats.smallestPt, effective);
      if (effective < MIN_READABLE_FONT_PT) stats.small += 1;
    }
  }
  return stats;
}

export async function analyzePdf(
  buffer: Buffer,
  paperSize: PaperSizeName,
): Promise<PrintIssueReport> {
  let doc: PDFDocument;
  try {
    doc = await PDFDocument.load(buffer, { updateMetadata: false });
  } catch {
    return { analyzed: false, note: 'This PDF could not be inspected.', issues: [] };
  }

  let pages: PDFPage[];
  try {
    // pdf-lib loads leniently; a broken page tree only fails here.
    pages = doc.getPages();
  } catch {
    return { analyzed: false, note: 'This PDF could not be inspected.', issues: [] };
  }
  const issues: PrintIssue[] = [];
  const paper = PAPER_POINTS[paperSize];

  const dims = pages.map((page) => {
    let { width, height } = page.getSize();
    if (Math.abs(page.getRotation().angle) % 180 === 90) [width, height] = [height, width];
    return { width, height, orientation: orientationOf(width, height) };
  });

  // Blank last page (only meaningful with more than one page).
  if (pages.length > 1) {
    const content = decodedContent(pages[pages.length - 1]);
    if (content !== null && isContentBlank(content)) {
      issues.push({
        code: 'BLANK_LAST_PAGE',
        severity: 'warning',
        message: `Page ${pages.length} looks blank. Use a custom page range (1-${pages.length - 1}) to avoid printing it.`,
        pages: [pages.length],
      });
    }
  }

  // Orientation.
  const landscape = dims.flatMap((d, i) => (d.orientation === 'landscape' ? [i + 1] : []));
  if (landscape.length > 0 && landscape.length < pages.length) {
    issues.push({
      code: 'MIXED_ORIENTATION',
      severity: 'warning',
      message: `${landscape.length} of ${pages.length} pages are landscape while the rest are portrait. Landscape pages may be shrunk or rotated when printed.`,
      pages: landscape.slice(0, 20),
    });
  } else if (landscape.length === pages.length) {
    issues.push({
      code: 'LANDSCAPE_ON_PORTRAIT',
      severity: 'info',
      message:
        'This document is landscape. Make sure the shop prints it landscape rather than shrinking it onto portrait paper.',
    });
  }

  // Page size vs. chosen paper size (orientation-insensitive).
  const mismatched = dims.flatMap((d, i) => {
    const long = Math.max(d.width, d.height);
    const short = Math.min(d.width, d.height);
    const off =
      Math.abs(long - paper.h) / paper.h > SIZE_TOLERANCE ||
      Math.abs(short - paper.w) / paper.w > SIZE_TOLERANCE;
    return off ? [i + 1] : [];
  });
  if (mismatched.length > 0) {
    const who = mismatched.length === pages.length ? 'All pages are' : `${mismatched.length} page(s) are`;
    issues.push({
      code: 'PAGE_SIZE_MISMATCH',
      severity: 'warning',
      message: `${who} not ${paperSize} sized, so they will be scaled to fit ${paperSize} paper.`,
      pages: mismatched.slice(0, 20),
    });
  }

  // Tiny text (estimate), bounded so huge PDFs stay cheap.
  const tinyPages: number[] = [];
  let smallest = Infinity;
  for (let i = 0; i < Math.min(pages.length, MAX_PAGES_SCANNED_FOR_TEXT); i += 1) {
    const content = decodedContent(pages[i]);
    if (!content) continue;
    const stats = measureFontSizes(content);
    if (stats.total >= 3 && stats.small / stats.total >= 0.3) {
      tinyPages.push(i + 1);
      smallest = Math.min(smallest, stats.smallestPt);
    }
  }
  if (tinyPages.length > 0) {
    const where = tinyPages.length === 1 ? `page ${tinyPages[0]}` : `${tinyPages.length} pages`;
    issues.push({
      code: 'TINY_TEXT',
      severity: 'warning',
      message: `Text on ${where} may be too small to read when printed (about ${smallest.toFixed(1)}pt; ${MIN_READABLE_FONT_PT}pt or larger is comfortable). This is an estimate.`,
      pages: tinyPages.slice(0, 20),
    });
  }

  return { analyzed: true, issues };
}

export function analyzeImage(buffer: Buffer, paperSize: PaperSizeName): PrintIssueReport {
  const unreadable: PrintIssueReport = {
    analyzed: false,
    note: 'This image could not be inspected.',
    issues: [],
  };
  let width: number | undefined;
  let height: number | undefined;
  try {
    ({ width, height } = imageSize(buffer));
  } catch {
    return unreadable;
  }
  if (!width || !height) return unreadable;

  const paper = PAPER_POINTS[paperSize];
  const imageOrientation = orientationOf(width, height);
  // The shop can rotate the sheet, so compare against the better-fitting one.
  const paperW = (imageOrientation === 'landscape' ? paper.h : paper.w) / 72;
  const paperH = (imageOrientation === 'landscape' ? paper.w : paper.h) / 72;
  const dpi = Math.min(width / paperW, height / paperH);

  const issues: PrintIssue[] = [];
  if (dpi < LOW_DPI) {
    issues.push({
      code: 'LOW_RESOLUTION',
      severity: 'warning',
      message: `This ${width}x${height}px image works out to about ${Math.round(dpi)} DPI on ${paperSize} paper (${dpi < VERY_LOW_DPI ? 'it will look blurry' : 'it may look soft'}; ${LOW_DPI}+ DPI prints well). Use a larger original or a smaller paper size.`,
    });
  }
  if (imageOrientation === 'landscape') {
    issues.push({
      code: 'LANDSCAPE_ON_PORTRAIT',
      severity: 'info',
      message: 'This image is landscape. Make sure it is printed landscape so it fills the page.',
    });
  }
  return { analyzed: true, issues };
}

export function unsupportedFormatReport(): PrintIssueReport {
  return {
    analyzed: false,
    note: 'Print checks are available for PDF and image files. Convert Office documents to PDF to check them.',
    issues: [],
  };
}
