// Copies the OCR files the pay page needs from node_modules into public/ocr, so the site serves them itself
// (no CDN). Runs before `vite` and `vite build` (see predev / prebuild in package.json). public/ocr is git-ignored.
//   worker.min.js                          tesseract.js web worker
//   tesseract-core-*-lstm.wasm.js (x3)     the WASM engine; the worker picks one by what the phone's CPU supports
//   eng.traineddata.gz                     English text data (LSTM, "best_int")
import { createRequire } from 'node:module';
import { copyFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const pkgDir = (name) => dirname(require.resolve(`${name}/package.json`));
const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'ocr');

const core = pkgDir('tesseract.js-core');
const files = [
  [join(pkgDir('tesseract.js'), 'dist', 'worker.min.js'), 'worker.min.js'],
  [join(core, 'tesseract-core-lstm.wasm.js'), 'tesseract-core-lstm.wasm.js'],
  [join(core, 'tesseract-core-simd-lstm.wasm.js'), 'tesseract-core-simd-lstm.wasm.js'],
  [join(core, 'tesseract-core-relaxedsimd-lstm.wasm.js'), 'tesseract-core-relaxedsimd-lstm.wasm.js'],
  [join(pkgDir('@tesseract.js-data/eng'), '4.0.0_best_int', 'eng.traineddata.gz'), 'eng.traineddata.gz'],
];

mkdirSync(out, { recursive: true });
let copied = 0;
for (const [from, name] of files) {
  const to = join(out, name);
  if (existsSync(to) && statSync(to).size === statSync(from).size) continue;
  copyFileSync(from, to);
  copied += 1;
}
if (copied) console.log(`[ocr] copied ${copied} file(s) to public/ocr`);
