#!/usr/bin/env node

// Pack all per-adcode POI shards into a single gzipped tar for GitHub Release distribution.
//
// Input:  data/pois/<adcode>.js                (produced by build-pois.mjs)
//         data/pois-manifest.js                (already exists alongside)
//
// Output: data/pois.tar.gz                     (single release asset)
//         data/pois-manifest.js (patched)      (adds packaged bundle hash + size)
//
// The runtime loader in app.js fetches pois.tar.gz from the current
// GitHub Release on first visit, extracts shards with the browser-native
// DecompressionStream + a tiny tar reader, and populates window.__POI_SHARDS__.

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');
const shardDir = path.join(projectRoot, 'data', 'pois');
const manifestPath = path.join(projectRoot, 'data', 'pois-manifest.js');
const outPath = path.join(projectRoot, 'data', 'pois.tar.gz');

// Minimal tar writer: emits the USTAR-compatible records the browser untar expects.
// Each record = 512B header + filedata padded to 512B boundary.
function buildTarHeader(name, size) {
  const header = Buffer.alloc(512);
  const asciiField = (value, offset, length) => {
    const buf = Buffer.from(String(value), 'ascii');
    buf.copy(header, offset, 0, Math.min(buf.length, length - 1));
  };
  const octalField = (value, offset, length) => {
    const text = value.toString(8).padStart(length - 1, '0') + '\0';
    header.write(text, offset, 'ascii');
  };

  if (name.length > 100) {
    throw new Error(`tar name too long: ${name}`);
  }
  asciiField(name, 0, 100);
  octalField(0o644, 100, 8);
  octalField(0, 108, 8);
  octalField(0, 116, 8);
  octalField(size, 124, 12);
  octalField(Math.floor(Date.now() / 1000), 136, 12);
  header.write('        ', 148, 'ascii'); // checksum placeholder (8 spaces)
  header[156] = '0'.charCodeAt(0); // normal file
  header.write('ustar\0', 257, 'ascii');
  header.write('00', 263, 'ascii');

  let checksum = 0;
  for (let i = 0; i < 512; i++) checksum += header[i];
  const checksumStr = checksum.toString(8).padStart(6, '0') + '\0 ';
  header.write(checksumStr, 148, 'ascii');
  return header;
}

function buildTarEntry(name, payload) {
  const header = buildTarHeader(name, payload.length);
  const pad = (512 - (payload.length % 512)) % 512;
  const padding = Buffer.alloc(pad);
  return Buffer.concat([header, payload, padding]);
}

function readManifestJson() {
  const raw = fs.readFileSync(manifestPath, 'utf8');
  const match = raw.match(/window\.__POI_MANIFEST__\s*=\s*([\s\S]*);\s*$/m);
  if (!match) throw new Error(`cannot parse ${manifestPath}`);
  return JSON.parse(match[1]);
}

function writeManifestJson(data) {
  fs.writeFileSync(manifestPath, `window.__POI_MANIFEST__ = ${JSON.stringify(data)};\n`, 'utf8');
}

async function main() {
  if (!fs.existsSync(shardDir)) {
    process.stderr.write(`[package-pois] no shards at ${shardDir}; run build-pois first\n`);
    process.exit(1);
  }
  if (!fs.existsSync(manifestPath)) {
    process.stderr.write(`[package-pois] no manifest at ${manifestPath}\n`);
    process.exit(1);
  }

  const files = fs.readdirSync(shardDir).filter((n) => n.endsWith('.js')).sort();
  if (!files.length) {
    process.stderr.write(`[package-pois] ${shardDir} is empty\n`);
    process.exit(1);
  }

  process.stdout.write(`packing ${files.length} shards from ${shardDir}...\n`);
  const entries = [];
  let rawBytes = 0;
  for (const file of files) {
    const payload = fs.readFileSync(path.join(shardDir, file));
    entries.push(buildTarEntry(file, payload));
    rawBytes += payload.length;
  }
  entries.push(Buffer.alloc(1024)); // two empty blocks = tar end-of-archive marker
  const tarBuffer = Buffer.concat(entries);

  const gz = zlib.gzipSync(tarBuffer, { level: 9 });
  fs.writeFileSync(outPath, gz);

  const hash = crypto.createHash('sha256').update(gz).digest('hex');
  const manifest = readManifestJson();
  manifest.bundle = {
    fileName: 'pois.tar.gz',
    size: gz.length,
    sha256: hash,
    rawTarSize: tarBuffer.length,
    packagedAt: new Date().toISOString(),
  };
  writeManifestJson(manifest);

  const mb = (n) => (n / 1024 / 1024).toFixed(1);
  process.stdout.write(
    `done: ${files.length} shards → ${outPath}\n` +
      `  raw shard bytes: ${mb(rawBytes)} MB\n` +
      `  tar bytes:       ${mb(tarBuffer.length)} MB\n` +
      `  tar.gz bytes:    ${mb(gz.length)} MB\n` +
      `  sha256:          ${hash}\n`,
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
