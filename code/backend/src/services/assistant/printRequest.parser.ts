import { FinishingType, PaperSize, PrintType, Sides } from '@prisma/client';

// What the student asked for, before it is matched against real shops and
// prices. Every field is optional: only what was actually said is set.
export interface ParsedPrintRequest {
  printType?: PrintType;
  paperSize?: PaperSize;
  sides?: Sides;
  copies?: number;
  pageRange?: string;
  finishingType?: FinishingType;
  // "colour cover only": the form has one print type per document, so this
  // is passed to the shop as an instruction rather than modelled as settings.
  colourCoverOnly?: boolean;
  wantsCheapest?: boolean;
  shopName?: string;
}

const PAPER_SIZES: PaperSize[] = ['A4', 'A3', 'A5', 'LETTER', 'LEGAL'];
const PRINT_TYPES: PrintType[] = ['BW', 'COLOR'];
const SIDES: Sides[] = ['SINGLE', 'DOUBLE'];
const FINISHINGS: FinishingType[] = ['SPIRAL_BINDING', 'HARD_BINDING', 'STAPLING', 'LAMINATION'];

const NUMBER_WORDS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
};

export const MAX_COPIES = 100;

// Single choke point for anything that came from free text or an LLM:
// unknown or out-of-range values are dropped, never passed through.
export function sanitizeParsedRequest(raw: unknown): ParsedPrintRequest {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const out: ParsedPrintRequest = {};

  if (PRINT_TYPES.includes(r.printType as PrintType)) out.printType = r.printType as PrintType;
  if (PAPER_SIZES.includes(r.paperSize as PaperSize)) out.paperSize = r.paperSize as PaperSize;
  if (SIDES.includes(r.sides as Sides)) out.sides = r.sides as Sides;
  if (FINISHINGS.includes(r.finishingType as FinishingType)) {
    out.finishingType = r.finishingType as FinishingType;
  }
  if (typeof r.copies === 'number' && Number.isInteger(r.copies) && r.copies >= 1 && r.copies <= MAX_COPIES) {
    out.copies = r.copies;
  }
  if (typeof r.pageRange === 'string' && /^\d+(-\d+)?(,\s*\d+(-\d+)?)*$/.test(r.pageRange.trim())) {
    out.pageRange = r.pageRange.trim();
  }
  if (r.colourCoverOnly === true) out.colourCoverOnly = true;
  if (r.wantsCheapest === true) out.wantsCheapest = true;
  if (typeof r.shopName === 'string' && r.shopName.trim() && r.shopName.length <= 100) {
    out.shopName = r.shopName.trim();
  }
  return out;
}

// Deterministic fallback used when no LLM is configured (or it fails).
export function parsePrintRequestWithRules(message: string): ParsedPrintRequest {
  const text = message.toLowerCase();
  const out: Record<string, unknown> = {};

  const colourCover = /colou?r(ed)?\s+(front\s+)?(cover|title page|first page)/.test(text);
  if (colourCover) {
    out.colourCoverOnly = true;
    out.printType = 'BW';
  } else if (/black\s*(and|&|n)\s*white|\bb\s*&\s*w\b|\bbw\b|greyscale|grayscale|monochrome/.test(text)) {
    out.printType = 'BW';
  } else if (/colou?r/.test(text)) {
    out.printType = 'COLOR';
  }

  if (/double[\s-]*sided|both sides|two[\s-]*sided|duplex|back to back/.test(text)) out.sides = 'DOUBLE';
  else if (/single[\s-]*sided|one[\s-]*sided|one side\b/.test(text)) out.sides = 'SINGLE';

  const paper = text.match(/\b(a3|a4|a5|letter|legal)\b/);
  if (paper) out.paperSize = paper[1].toUpperCase();

  if (/spiral/.test(text)) out.finishingType = 'SPIRAL_BINDING';
  else if (/hard\s*(bind|cover|back)|hardbound/.test(text)) out.finishingType = 'HARD_BINDING';
  else if (/stapl/.test(text)) out.finishingType = 'STAPLING';
  else if (/laminat/.test(text)) out.finishingType = 'LAMINATION';

  const copies = text.match(/\b(\d{1,3}|one|two|three|four|five|six|seven|eight|nine|ten)\s*(?:copies|copy|sets?)\b/);
  if (copies) out.copies = NUMBER_WORDS[copies[1]] ?? Number(copies[1]);

  const range = text.match(/\bpages?\s+(\d+(?:\s*(?:-|to)\s*\d+)?(?:\s*,\s*\d+(?:\s*(?:-|to)\s*\d+)?)*)/);
  if (range) out.pageRange = range[1].replace(/\s*to\s*/g, '-').replace(/\s+/g, '');

  if (/cheap|lowest price|least expensive|budget/.test(text)) out.wantsCheapest = true;

  return sanitizeParsedRequest(out);
}

// Case-insensitive match of a shop the student named, by name or code.
export function findNamedShop<T extends { shopName: string; shopCode: string }>(
  message: string,
  shops: T[],
  llmShopName?: string,
): T | undefined {
  const text = message.toLowerCase();
  const wanted = llmShopName?.toLowerCase();
  return shops.find(
    (s) =>
      text.includes(s.shopName.toLowerCase()) ||
      text.includes(s.shopCode.toLowerCase()) ||
      (wanted !== undefined && (s.shopName.toLowerCase() === wanted || s.shopCode.toLowerCase() === wanted)),
  );
}
