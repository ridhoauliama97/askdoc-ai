import { copyFileSync, mkdirSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = dirname(fileURLToPath(new URL('../package.json', import.meta.url)));
const pdfjsRoot = dirname(require.resolve('pdfjs-dist/package.json'));

const source = join(pdfjsRoot, 'build', 'pdf.worker.min.mjs');
const targetDir = join(root, 'public');
const target = join(targetDir, 'pdf.worker.min.mjs');

mkdirSync(targetDir, { recursive: true });
copyFileSync(source, target);

const { size } = statSync(target);

if (size === 0) {
  throw new Error(`Copied PDF worker is empty: ${target}`);
}

console.log(`Copied PDF worker to ${target} (${size} bytes)`);
