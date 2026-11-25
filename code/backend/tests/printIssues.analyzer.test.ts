import { PDFDocument, StandardFonts } from 'pdf-lib';

import { analyzeImage, analyzePdf, isContentBlank } from '../src/services/documents/printIssues.analyzer';

const A4: [number, number] = [595.28, 841.89];

async function makePdf(
  pages: Array<{ size?: [number, number]; text?: string; fontSize?: number; lines?: number }>,
): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (const p of pages) {
    const page = doc.addPage(p.size ?? A4);
    if (p.text) {
      for (let i = 0; i < (p.lines ?? 5); i += 1) {
        page.drawText(p.text, { x: 40, y: 700 - i * 20, size: p.fontSize ?? 12, font });
      }
    }
  }
  return Buffer.from(await doc.save());
}

// Minimal valid PNG header with given dimensions (image-size only reads IHDR).
function pngWithSize(width: number, height: number): Buffer {
  const buf = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buf, 0);
  buf.writeUInt32BE(13, 8);
  buf.write('IHDR', 12, 'ascii');
  buf.writeUInt32BE(width, 16);
  buf.writeUInt32BE(height, 20);
  return buf;
}

const codes = (r: { issues: Array<{ code: string }> }) => r.issues.map((i) => i.code);

describe('analyzePdf', () => {
  it('reports nothing for a normal A4 document', async () => {
    const report = await analyzePdf(await makePdf([{ text: 'Hello world' }, { text: 'Page two' }]), 'A4');
    expect(report.analyzed).toBe(true);
    expect(report.issues).toEqual([]);
  });

  it('flags a blank last page', async () => {
    const report = await analyzePdf(await makePdf([{ text: 'Content' }, {}]), 'A4');
    expect(codes(report)).toContain('BLANK_LAST_PAGE');
    expect(report.issues.find((i) => i.code === 'BLANK_LAST_PAGE')?.pages).toEqual([2]);
  });

  it('does not call a single blank page a blank last page', async () => {
    const report = await analyzePdf(await makePdf([{}]), 'A4');
    expect(codes(report)).not.toContain('BLANK_LAST_PAGE');
  });

  it('flags mixed orientation', async () => {
    const report = await analyzePdf(
      await makePdf([{ text: 'a' }, { text: 'b', size: [A4[1], A4[0]] }]),
      'A4',
    );
    expect(codes(report)).toContain('MIXED_ORIENTATION');
  });

  it('flags a page size that does not match the chosen paper', async () => {
    const report = await analyzePdf(await makePdf([{ text: 'a' }]), 'A3');
    expect(codes(report)).toContain('PAGE_SIZE_MISMATCH');
  });

  it('flags tiny text but not normal text', async () => {
    const tiny = await analyzePdf(await makePdf([{ text: 'small print', fontSize: 4 }]), 'A4');
    expect(codes(tiny)).toContain('TINY_TEXT');
    const normal = await analyzePdf(await makePdf([{ text: 'normal print', fontSize: 11 }]), 'A4');
    expect(codes(normal)).not.toContain('TINY_TEXT');
  });

  it('reports not analyzed for a corrupt PDF', async () => {
    const report = await analyzePdf(Buffer.from('%PDF-1.4 garbage'), 'A4');
    expect(report.analyzed).toBe(false);
  });
});

describe('isContentBlank', () => {
  it('treats empty and whitespace-only text as blank, real text as content', () => {
    expect(isContentBlank('')).toBe(true);
    expect(isContentBlank('BT /F1 12 Tf ( ) Tj ET')).toBe(true);
    expect(isContentBlank('BT /F1 12 Tf (Hi) Tj ET')).toBe(false);
    expect(isContentBlank('q 100 0 0 100 0 0 cm /Im1 Do Q')).toBe(false);
    expect(isContentBlank('0 0 100 100 re f')).toBe(false);
  });
});

describe('analyzeImage', () => {
  it('flags a low-resolution image', () => {
    const report = analyzeImage(pngWithSize(400, 600), 'A4');
    expect(codes(report)).toContain('LOW_RESOLUTION');
  });

  it('accepts a high-resolution image', () => {
    const report = analyzeImage(pngWithSize(2480, 3508), 'A4');
    expect(codes(report)).not.toContain('LOW_RESOLUTION');
  });

  it('notes a landscape image', () => {
    const report = analyzeImage(pngWithSize(3508, 2480), 'A4');
    expect(codes(report)).toContain('LANDSCAPE_ON_PORTRAIT');
  });
});
