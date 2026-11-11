// Builds the static web version into dist-web/: the app files plus the ffmpeg.wasm engine.
// Host that folder on any static web server. Usage: node scripts/build-web.js
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const out = path.join(root, 'dist-web');
const engine = path.join(out, 'vendor', 'ffmpeg');

const files = [
  ['index.html'], ['styles.css'], ['renderer.js'], ['media.js'], ['export-plan.js'], ['web-api.js'],
  // The ffmpeg.wasm wrapper (and its worker) must sit side by side: the worker is found next to ffmpeg.js.
  ['node_modules/@ffmpeg/ffmpeg/dist/umd/ffmpeg.js', 'vendor/ffmpeg/ffmpeg.js'],
  ['node_modules/@ffmpeg/ffmpeg/dist/umd/814.ffmpeg.js', 'vendor/ffmpeg/814.ffmpeg.js'],
  ['node_modules/@ffmpeg/core/dist/umd/ffmpeg-core.js', 'vendor/ffmpeg/ffmpeg-core.js'],
  ['node_modules/@ffmpeg/core/dist/umd/ffmpeg-core.wasm', 'vendor/ffmpeg/ffmpeg-core.wasm'],
];

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(engine, { recursive: true });
for (const [from, to = from] of files) {
  const source = path.join(root, from);
  if (!fs.existsSync(source)) throw new Error(`Missing ${from}. Run "npm install" first.`);
  fs.copyFileSync(source, path.join(out, to));
}
console.log(`Web build ready in ${path.relative(root, out)}/ (${files.length} files).`);
