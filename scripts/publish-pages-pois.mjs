#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');
const assetPath = path.join(projectRoot, '.deploy', 'pages-pois.tar.gz');
const releaseTag = 'pages-data';

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: projectRoot,
    encoding: 'utf8',
    ...options,
  });
  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || `${command} failed`);
  }
  return result.stdout;
}

function releaseExists(tag) {
  const result = spawnSync('gh', ['release', 'view', tag], {
    cwd: projectRoot,
    encoding: 'utf8',
  });
  return result.status === 0;
}

function main() {
  if (!fs.existsSync(assetPath)) {
    throw new Error(
      `missing ${assetPath}; run "npm run package:pages-pois" first`,
    );
  }

  if (!releaseExists(releaseTag)) {
    run('gh', [
      'release',
      'create',
      releaseTag,
      '--title',
      'Pages deploy data',
      '--notes',
      'Deploy-only POI shard bundle for GitHub Pages.',
    ]);
  }

  run('gh', [
    'release',
    'upload',
    releaseTag,
    assetPath,
    '--clobber',
  ]);

  process.stdout.write(
    `Uploaded ${path.basename(assetPath)} to release tag "${releaseTag}".\n`,
  );
}

main();
