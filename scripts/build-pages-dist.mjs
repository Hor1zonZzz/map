#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');

const args = process.argv.slice(2);
const outFlagIndex = args.indexOf('--out');
const outDir = outFlagIndex >= 0 && args[outFlagIndex + 1]
  ? path.resolve(projectRoot, args[outFlagIndex + 1])
  : path.join(projectRoot, 'dist');

const requiredEntries = [
  '.nojekyll',
  'index.html',
  'map.html',
  'app.js',
  'styles.css',
  'src',
  path.join('data', 'boundaries'),
  path.join('data', 'boundary-manifest.js'),
  path.join('data', 'pois-manifest.js'),
  path.join('data', 'statistical-regions.js'),
];

const optionalEntries = [
  'CNAME',
  path.join('data', 'pois'),
];

function ensureParent(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function copyEntry(relativePath) {
  const source = path.join(projectRoot, relativePath);
  if (!fs.existsSync(source)) {
    throw new Error(`missing required entry: ${relativePath}`);
  }
  const target = path.join(outDir, relativePath);
  ensureParent(target);
  fs.cpSync(source, target, { recursive: true });
}

function copyOptionalEntry(relativePath) {
  const source = path.join(projectRoot, relativePath);
  if (!fs.existsSync(source)) return;
  const target = path.join(outDir, relativePath);
  ensureParent(target);
  fs.cpSync(source, target, { recursive: true });
}

function countFiles(dirPath) {
  if (!fs.existsSync(dirPath)) return 0;
  const stat = fs.statSync(dirPath);
  if (!stat.isDirectory()) return 1;
  let total = 0;
  for (const entry of fs.readdirSync(dirPath)) {
    total += countFiles(path.join(dirPath, entry));
  }
  return total;
}

function main() {
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });

  for (const entry of requiredEntries) copyEntry(entry);
  for (const entry of optionalEntries) copyOptionalEntry(entry);

  const shardDir = path.join(outDir, 'data', 'pois');
  const shardCount = countFiles(shardDir);

  process.stdout.write(
    `Built Pages artifact at ${outDir}\n` +
      `Included required static assets and ${shardCount} POI shard files.\n`,
  );
}

main();
