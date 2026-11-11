// Removes the build output: the web build (dist-web/) and the desktop installer (release/).
// Usage: npm run clean
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
for (const dir of ['dist-web', 'release']) {
  fs.rmSync(path.join(root, dir), { recursive: true, force: true });
  console.log(`Removed ${dir}/`);
}
