import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { DocumentFileType } from '../../config/documentTypes';
import { env } from '../../config/env';

// Word / Excel / PowerPoint -> PDF with LibreOffice running headless, so the
// shop prints a PDF (same layout on every printer) instead of an Office file.
//
// - Each conversion gets its own temporary folder AND its own LibreOffice
//   profile folder: two conversions sharing a profile block each other.
// - At most MAX_PARALLEL conversions run at once; the rest wait their turn.
// - A conversion that takes longer than the timeout is killed.
// - If LibreOffice is not installed (e.g. a laptop without it) conversion is
//   skipped with one warning, and the upload works exactly as before.

export const CONVERTIBLE_TYPES: ReadonlySet<DocumentFileType> = new Set<DocumentFileType>([
  'DOCX',
  'DOC',
  'XLSX',
  'XLS',
  'PPTX',
  'PPT',
]);

export interface OfficeConverterConfig {
  enabled: boolean;
  // The command to run, e.g. ["soffice"] or ["/usr/bin/libreoffice"]. Tests
  // pass [node, fake-script].
  command: string[];
  timeoutMs: number;
  maxParallel: number;
}

export type ConversionResult =
  | { status: 'converted'; pdf: Buffer }
  | { status: 'skipped'; reason: 'disabled' | 'not-convertible' | 'not-installed' }
  | { status: 'failed'; reason: 'timeout' | 'error' };

const MAX_OUTPUT_BYTES = 200 * 1024 * 1024;

export class OfficeConverter {
  private running = 0;
  private readonly waiting: (() => void)[] = [];
  private warnedNotInstalled = false;

  constructor(private readonly config: OfficeConverterConfig) {}

  private async acquire(): Promise<void> {
    if (this.running < this.config.maxParallel) {
      this.running += 1;
      return;
    }
    await new Promise<void>((resolve) => this.waiting.push(resolve));
  }

  private release(): void {
    const next = this.waiting.shift();
    if (next) {
      next(); // hand the slot straight to the next caller
    } else {
      this.running -= 1;
    }
  }

  async convert(fileType: DocumentFileType, extension: string, input: Buffer): Promise<ConversionResult> {
    if (!this.config.enabled) {
      return { status: 'skipped', reason: 'disabled' };
    }
    if (!CONVERTIBLE_TYPES.has(fileType)) {
      return { status: 'skipped', reason: 'not-convertible' };
    }

    await this.acquire();
    const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'smartprint-convert-'));
    try {
      const inputPath = path.join(workDir, `input${extension}`);
      const outDir = path.join(workDir, 'out');
      const profileDir = path.join(workDir, 'profile');
      await fs.writeFile(inputPath, input);
      await fs.mkdir(outDir);

      const [cmd, ...prefix] = this.config.command;
      const args = [
        ...prefix,
        `-env:UserInstallation=${pathToFileURL(profileDir).href}`,
        '--headless',
        '--norestore',
        '--nologo',
        '--convert-to',
        'pdf',
        '--outdir',
        outDir,
        inputPath,
      ];

      const outcome = await new Promise<'ok' | 'timeout' | 'not-installed' | 'error'>((resolve) => {
        execFile(
          cmd,
          args,
          { timeout: this.config.timeoutMs, killSignal: 'SIGKILL', windowsHide: true, maxBuffer: 1024 * 1024 },
          (err) => {
            if (!err) return resolve('ok');
            const e = err as NodeJS.ErrnoException & { killed?: boolean; signal?: string };
            if (e.code === 'ENOENT') return resolve('not-installed');
            if (e.killed || e.signal === 'SIGKILL') return resolve('timeout');
            resolve('error');
          },
        );
      });

      if (outcome === 'not-installed') {
        if (!this.warnedNotInstalled) {
          this.warnedNotInstalled = true;
          // eslint-disable-next-line no-console
          console.warn(
            `Office -> PDF conversion skipped: "${cmd}" was not found. Install LibreOffice or set ` +
              'OFFICE_CONVERSION_ENABLED=false to silence this.',
          );
        }
        return { status: 'skipped', reason: 'not-installed' };
      }
      if (outcome === 'timeout') {
        return { status: 'failed', reason: 'timeout' };
      }

      // LibreOffice sometimes exits 0 without writing anything (and the
      // reverse), so the output file decides.
      const pdfPath = path.join(outDir, 'input.pdf');
      const stat = await fs.stat(pdfPath).catch(() => null);
      if (!stat || stat.size === 0 || stat.size > MAX_OUTPUT_BYTES) {
        return { status: 'failed', reason: 'error' };
      }
      return { status: 'converted', pdf: await fs.readFile(pdfPath) };
    } finally {
      await fs.rm(workDir, { recursive: true, force: true }).catch(() => undefined);
      this.release();
    }
  }
}

export const officeConverter = new OfficeConverter(env.officeConversion);
