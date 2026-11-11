// Builds the static web version into dist-web/: the app files plus the ffmpeg.wasm engine.
// Host that folder on any static web server. Usage: npm run build:web
//
// The engine's .wasm is 31 MB raw, which is more than some static hosts accept for one file
// (Cloudflare Pages: 25 MiB), so it is shipped gzip-compressed and unpacked by the browser
// (see web-api.js). The build fails if any file still exceeds the limit.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const root = path.join(__dirname, '..');
const out = path.join(root, 'dist-web');
const engine = path.join(out, 'vendor', 'ffmpeg');
const MAX_FILE_BYTES = 25 * 1024 * 1024; // Cloudflare Pages: 25 MiB per file

const files = [
  ['index.html'], ['styles.css'], ['renderer.js'], ['media.js'], ['export-plan.js'], ['web-api.js'],
  // The ffmpeg.wasm wrapper (and its worker) must sit side by side: the worker is found next to ffmpeg.js.
  ['node_modules/@ffmpeg/ffmpeg/dist/umd/ffmpeg.js', 'vendor/ffmpeg/ffmpeg.js'],
  ['node_modules/@ffmpeg/ffmpeg/dist/umd/814.ffmpeg.js', 'vendor/ffmpeg/814.ffmpeg.js'],
  ['node_modules/@ffmpeg/core/dist/umd/ffmpeg-core.js', 'vendor/ffmpeg/ffmpeg-core.js'],
];

// Cloudflare Pages reads this file for response headers (other hosts ignore it).
const headers = `/vendor/ffmpeg/*
  Cache-Control: public, max-age=604800

/*
  X-Content-Type-Options: nosniff
  Referrer-Policy: same-origin
`;

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(engine, { recursive: true });

for (const [from, to = from] of files) {
  const source = path.join(root, from);
  if (!fs.existsSync(source)) throw new Error(`Missing ${from}. Run "npm install" first.`);
  fs.copyFileSync(source, path.join(out, to));
}

const wasmSource = path.join(root, 'node_modules/@ffmpeg/core/dist/umd/ffmpeg-core.wasm');
if (!fs.existsSync(wasmSource)) throw new Error('Missing ffmpeg-core.wasm. Run "npm install" first.');
const wasm = fs.readFileSync(wasmSource);
fs.writeFileSync(path.join(engine, 'ffmpeg-core.wasm.gz'), zlib.gzipSync(wasm, { level: 9 }));
fs.writeFileSync(path.join(out, '_headers'), headers);

const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true })
  .flatMap((entry) => (entry.isDirectory() ? walk(path.join(dir, entry.name)) : [path.join(dir, entry.name)]));
const built = walk(out);
for (const file of built) {
  const size = fs.statSync(file).size;
  if (size > MAX_FILE_BYTES) {
    throw new Error(`${path.relative(out, file)} is ${(size / 1048576).toFixed(1)} MiB, over the 25 MiB per-file limit of static hosts such as Cloudflare Pages.`);
  }
}

const mib = (n) => (n / 1048576).toFixed(1);
console.log(`Web build ready in ${path.relative(root, out)}/ (${built.length} files).`);
console.log(`Engine: ffmpeg-core.wasm ${mib(wasm.length)} MiB -> ${mib(fs.statSync(path.join(engine, 'ffmpeg-core.wasm.gz')).size)} MiB gzip. Largest file: ${mib(Math.max(...built.map((f) => fs.statSync(f).size)))} MiB.`);
