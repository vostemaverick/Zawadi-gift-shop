const fs = require('node:fs');
const path = require('node:path');

const projectRoot = path.resolve(__dirname, '..');
const publicDirectory = path.join(projectRoot, 'public');

fs.mkdirSync(publicDirectory, { recursive: true });

for (const file of ['index.html', 'manifest.json', 'service-worker.js', 'icon.svg']) {
  fs.copyFileSync(path.join(projectRoot, file), path.join(publicDirectory, file));
}
