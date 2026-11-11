// Syntax-checks every JavaScript file of the app (the project root and scripts/).
// A quick safety net before committing or deploying: npm run check
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.join(__dirname, '..');
const files = [root, __dirname].flatMap((dir) => fs.readdirSync(dir)
  .filter((name) => name.endsWith('.js'))
  .map((name) => path.join(dir, name)));

let failed = 0;
for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (result.status !== 0) {
    failed += 1;
    console.error(`FAIL ${path.relative(root, file)}\n${result.stderr}`);
  }
}

console.log(`${files.length - failed} of ${files.length} files OK`);
process.exit(failed ? 1 : 0);
