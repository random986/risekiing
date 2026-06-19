import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');
const target = join(root, 'derivprinter_build');

if (!existsSync(dist)) {
  console.error('Run vite build first — dist/ missing');
  process.exit(1);
}

mkdirSync(target, { recursive: true });

for (const name of readdirSync(dist)) {
  const src = join(dist, name);
  const dest = join(target, name);
  rmSync(dest, { recursive: true, force: true });
  cpSync(src, dest, { recursive: true });
}

console.log('Synced dist/ → derivprinter_build/');
