/* eslint-disable */
// Stand-in for LibreOffice in tests. Understands just enough of
//   soffice ... --convert-to pdf --outdir <dir> <input>
// Behaviour via a leading --fake-mode=<ok|slow|no-output|crash> argument.
const fs = require('node:fs');
const path = require('node:path');

const args = process.argv.slice(2);
const outDir = args[args.indexOf('--outdir') + 1];
const input = args[args.length - 1];
const modeArg = args.find((a) => a.startsWith('--fake-mode='));
const mode = modeArg ? modeArg.slice('--fake-mode='.length) : 'ok';

if (mode === 'slow') {
  setTimeout(() => undefined, 60_000);
} else if (mode === 'crash') {
  process.exit(3);
} else if (mode === 'no-output') {
  process.exit(0);
} else {
  const pdf = fs.readFileSync(path.join(__dirname, '..', 'valid.pdf'));
  const name = path.basename(input).replace(/\.[^.]*$/, '') + '.pdf';
  fs.writeFileSync(path.join(outDir, name), pdf);
}
