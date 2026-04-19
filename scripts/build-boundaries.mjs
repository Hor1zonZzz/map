#!/usr/bin/env node

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');
const outDir = path.join(projectRoot, 'data', 'boundaries');
const manifestPath = path.join(projectRoot, 'data', 'boundary-manifest.js');

const ROOT_CODE = '100000';
const API_BASE = 'https://geo.datav.aliyun.com/areas_v3/bound';

const downloaded = new Map();
const failures = [];

function normalizeFeature(feature) {
  const props = feature?.properties || {};
  return {
    type: 'Feature',
    properties: {
      adcode: String(props.adcode),
      name: props.name || '',
      level: props.level || '',
      parentCode: props.parent?.adcode ? String(props.parent.adcode) : '',
      childrenNum: Number(props.childrenNum || 0),
      center: Array.isArray(props.center) ? props.center : null,
      centroid: Array.isArray(props.centroid) ? props.centroid : null,
      acroutes: Array.isArray(props.acroutes) ? props.acroutes.map(String) : [],
    },
    geometry: feature.geometry,
  };
}

async function fetchGeoJson(code) {
  const url = `${API_BASE}/${code}_full.json`;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} for ${url}`);
  }

  const contentType = response.headers.get('content-type') || '';
  if (!contentType.includes('json')) {
    const body = await response.text();
    throw new Error(`Unexpected response for ${code}: ${body.slice(0, 120)}`);
  }

  const payload = await response.json();
  const normalized = {
    type: 'FeatureCollection',
    code,
    features: (payload.features || []).map(normalizeFeature),
  };
  return normalized;
}

async function writeBoundaryModule(code, payload) {
  const filePath = path.join(outDir, `${code}_full.js`);
  const moduleSource = [
    'window.__BOUNDARY_DATA__ = window.__BOUNDARY_DATA__ || Object.create(null);',
    `window.__BOUNDARY_DATA__[${JSON.stringify(code)}] = ${JSON.stringify(payload)};`,
    '',
  ].join('\n');
  await fs.writeFile(filePath, moduleSource, 'utf8');
}

async function downloadBoundaryTree() {
  const queue = [ROOT_CODE];
  const queued = new Set(queue);

  while (queue.length) {
    const code = queue.shift();
    queued.delete(code);

    if (downloaded.has(code)) {
      continue;
    }

    try {
      const geo = await fetchGeoJson(code);
      downloaded.set(code, geo);
      await writeBoundaryModule(code, geo);
      process.stdout.write(`saved ${code} (${geo.features.length} features)\n`);

      for (const feature of geo.features) {
        if (feature.properties.childrenNum > 0) {
          const childCode = feature.properties.adcode;
          if (!downloaded.has(childCode) && !queued.has(childCode)) {
            queue.push(childCode);
            queued.add(childCode);
          }
        }
      }
    } catch (error) {
      failures.push({ code, error: String(error) });
      process.stderr.write(`skip ${code}: ${error}\n`);
    }
  }
}

async function writeManifest() {
  const files = [...downloaded.values()]
    .map((entry) => ({
      code: entry.code,
      featureCount: entry.features.length,
      childCount: entry.features.filter((feature) => feature.properties.childrenNum > 0).length,
      level: entry.features[0]?.properties.level || (entry.code === ROOT_CODE ? 'country' : ''),
    }))
    .sort((a, b) => a.code.localeCompare(b.code));

  const manifest = {
    rootCode: ROOT_CODE,
    generatedAt: new Date().toISOString(),
    source: {
      name: 'DataV.GeoAtlas',
      provider: '阿里云 DataV / 高德开放平台',
      apiBase: API_BASE,
      usageNote: '原始数据来自高德开放平台，仅供学习和交流使用。',
    },
    fileCount: files.length,
    failureCount: failures.length,
    files,
    failures,
  };

  const manifestSource = [
    `window.__BOUNDARY_MANIFEST__ = ${JSON.stringify(manifest)};`,
    '',
  ].join('\n');

  await fs.writeFile(manifestPath, manifestSource, 'utf8');
}

async function main() {
  await fs.mkdir(outDir, { recursive: true });
  await downloadBoundaryTree();
  await writeManifest();

  process.stdout.write(
    `done: ${downloaded.size} boundary files, ${failures.length} skipped\n`,
  );

  if (failures.length) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
