'use strict';

const { execFile } = require('node:child_process');
const fs = require('node:fs/promises');
const path = require('node:path');

// Sends one file to the printer with the order's settings.
// item: { copies, printType: 'BW'|'COLOR', paperSize: 'A4'|..., sides: 'SINGLE'|'DOUBLE', pageRange }

const PRINTABLE_TYPES = ['application/pdf', 'image/jpeg', 'image/png'];

function isPrintable(contentType) {
  return PRINTABLE_TYPES.some((t) => contentType.startsWith(t));
}

function extensionFor(contentType) {
  if (contentType.startsWith('image/jpeg')) return '.jpg';
  if (contentType.startsWith('image/png')) return '.png';
  return '.pdf';
}

// CUPS lp (Linux/macOS).
function lpArgs(item, file, printerName) {
  const args = [];
  if (printerName) args.push('-d', printerName);
  args.push('-n', String(item.copies));
  args.push('-o', `media=${item.paperSize}`);
  args.push('-o', item.sides === 'DOUBLE' ? 'sides=two-sided-long-edge' : 'sides=one-sided');
  args.push('-o', item.printType === 'BW' ? 'print-color-mode=monochrome' : 'print-color-mode=color');
  if (item.pageRange) args.push('-o', `page-ranges=${item.pageRange}`);
  args.push(file);
  return args;
}

// SumatraPDF (Windows): https://www.sumatrapdfreader.org/docs/Command-line-arguments
function sumatraArgs(item, file, printerName) {
  const settings = [];
  if (item.pageRange) settings.push(item.pageRange);
  settings.push(`${item.copies}x`);
  settings.push(item.sides === 'DOUBLE' ? 'duplex' : 'simplex');
  settings.push(item.printType === 'BW' ? 'monochrome' : 'color');
  settings.push(`paper=${item.paperSize}`);
  const target = printerName ? ['-print-to', printerName] : ['-print-to-default'];
  return [...target, '-silent', '-print-settings', settings.join(','), file];
}

function defaultSumatraPath() {
  const base = process.env.LOCALAPPDATA || 'C:\\Users\\Default\\AppData\\Local';
  return path.join(base, 'SumatraPDF', 'SumatraPDF.exe');
}

function resolveMethod(method, platform = process.platform) {
  if (method && method !== 'auto') return method;
  return platform === 'win32' ? 'sumatra' : 'lp';
}

function run(cmd, args, timeoutMs, execFileImpl = execFile) {
  return new Promise((resolve, reject) => {
    execFileImpl(cmd, args, { timeout: timeoutMs, windowsHide: true }, (err, _stdout, stderr) => {
      if (err) {
        const detail = (stderr && String(stderr).trim()) || err.message;
        reject(new Error(`${path.basename(cmd)} failed: ${detail}`));
      } else {
        resolve();
      }
    });
  });
}

function createPrinter({ method, printerName, sumatraPath, outputDir, execFileImpl, platform } = {}) {
  const resolved = resolveMethod(method, platform);
  if (!['lp', 'sumatra', 'folder'].includes(resolved)) {
    throw new Error(`Unknown PRINT_METHOD "${method}" (use auto, lp, sumatra or folder)`);
  }

  return {
    method: resolved,
    // `file` is a path to the downloaded document; `label` names it in folder mode.
    async print(file, item, label) {
      if (resolved === 'folder') {
        const dir = outputDir || './printed';
        await fs.mkdir(dir, { recursive: true });
        const settings = [
          `${item.copies}x`,
          item.printType,
          item.paperSize,
          item.sides,
          item.pageRange ? `pages-${item.pageRange.replace(/[^0-9,-]/g, '')}` : null,
        ]
          .filter(Boolean)
          .join('_');
        const target = path.join(dir, `${label}_${settings}${path.extname(file)}`);
        await fs.copyFile(file, target);
        return target;
      }
      if (resolved === 'lp') {
        await run('lp', lpArgs(item, file, printerName), 120_000, execFileImpl);
        return null;
      }
      await run(sumatraPath || defaultSumatraPath(), sumatraArgs(item, file, printerName), 300_000, execFileImpl);
      return null;
    },
  };
}

module.exports = { createPrinter, extensionFor, isPrintable, lpArgs, resolveMethod, sumatraArgs };
