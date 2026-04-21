#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');

const args = process.argv.slice(2);
const outFlagIndex = args.indexOf('--out');
const outPath = outFlagIndex >= 0 && args[outFlagIndex + 1]
  ? path.resolve(projectRoot, args[outFlagIndex + 1])
  : path.join(projectRoot, '.deploy', 'pages-pois.tar.gz');

const dataDir = path.join(projectRoot, 'data');
const shardDir = path.join(dataDir, 'pois');

function countShardFiles(dirPath) {
  return fs.readdirSync(dirPath).filter((name) => name.endsWith('.js')).length;
}

function main() {
  if (!fs.existsSync(shardDir)) {
    throw new Error(`missing shard directory: ${shardDir}`);
  }

  const shardCount = countShardFiles(shardDir);
  if (!shardCount) {
    throw new Error(`no shard files found in ${shardDir}`);
  }

  fs.mkdirSync(path.dirname(outPath), { recursive: true });

  const result = spawnSync('tar', ['-czf', outPath, '-C', dataDir, 'pois'], {
    cwd: projectRoot,
    encoding: 'utf8',
  });

  if (result.status !== 0) {
    throw new Error(result.stderr || 'tar packaging failed');
  }

  const sizeBytes = fs.statSync(outPath).size;
  const sizeMb = (sizeBytes / 1024 / 1024).toFixed(1);
  process.stdout.write(
    `Packaged ${shardCount} shard files into ${outPath} (${sizeMb} MB)\n`,
  );
}

main();
