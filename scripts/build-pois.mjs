#!/usr/bin/env node

// Build POI shards from an OSM GeoJSON stream.
//
// Pipeline before running this script (user runs once):
//   1. Download China PBF:   https://download.geofabrik.de/asia/china-latest.osm.pbf
//   2. Filter named features:  osmium tags-filter china-latest.osm.pbf n/name w/name -o named.osm.pbf
//   3. Export as GeoJSONSeq:   osmium export named.osm.pbf -f geojsonseq -o data/raw/pois.geojsonseq
//
// Then:
//   node scripts/build-pois.mjs
//
// Inputs:  data/boundaries/*_full.js   (already built by build-boundaries.mjs)
//          data/raw/pois.geojsonseq    (osmium export output; one Feature per line)
// Outputs: data/pois/<adcode>.js        (one shard per leaf district)
//          data/pois-manifest.js        (aggregate index for lazy loading)

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

import * as turf from '@turf/turf';
import RBush from 'rbush';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');
const boundaryDir = path.join(projectRoot, 'data', 'boundaries');
const defaultInput = path.join(projectRoot, 'data', 'raw', 'pois.geojsonseq');
const outDir = path.join(projectRoot, 'data', 'pois');
const manifestPath = path.join(projectRoot, 'data', 'pois-manifest.js');

const inputPath = process.env.POI_INPUT || defaultInput;

// Tags we walk in priority order to derive a single `kind` for the POI.
// First match wins. Anything not listed is grouped as `other`.
const KIND_TAGS = [
  'tourism',
  'historic',
  'natural',
  'leisure',
  'amenity',
  'shop',
  'place',
  'man_made',
  'building',
  'office',
  'sport',
  'craft',
];

async function loadLeafDistricts() {
  const files = (await fs.promises.readdir(boundaryDir))
    .filter((name) => name.endsWith('_full.js'))
    .sort();
  const byAdcode = new Map();
  for (const file of files) {
    const source = await fs.promises.readFile(path.join(boundaryDir, file), 'utf8');
    const context = { window: {} };
    vm.createContext(context);
    vm.runInContext(source, context);
    const data = context.window.__BOUNDARY_DATA__ || {};
    for (const geo of Object.values(data)) {
      for (const feature of geo.features || []) {
        const props = feature.properties || {};
        // leaf = district with no further children
        if (props.level !== 'district' || Number(props.childrenNum || 0) > 0) continue;
        const adcode = String(props.adcode);
        if (byAdcode.has(adcode)) continue;
        byAdcode.set(adcode, { adcode, name: props.name || '', feature });
      }
    }
  }
  return [...byAdcode.values()];
}

function buildSpatialIndex(leaves) {
  const tree = new RBush();
  const items = leaves.map((leaf, i) => {
    const [minX, minY, maxX, maxY] = turf.bbox(leaf.feature);
    return { minX, minY, maxX, maxY, index: i };
  });
  tree.load(items);
  return tree;
}

function extractKind(props) {
  for (const key of KIND_TAGS) {
    const value = props[key];
    if (value && typeof value === 'string') {
      return `${key}.${value}`;
    }
  }
  return 'other';
}

function getPointFromFeature(feature) {
  const geometry = feature.geometry;
  if (!geometry) return null;
  if (geometry.type === 'Point') {
    const [lng, lat] = geometry.coordinates;
    if (Number.isFinite(lng) && Number.isFinite(lat)) return [lng, lat];
    return null;
  }
  try {
    const point = turf.centerOfMass(feature).geometry.coordinates;
    if (Number.isFinite(point[0]) && Number.isFinite(point[1])) return point;
  } catch {
    // fall through
  }
  return null;
}

function compressOsmId(raw) {
  if (!raw || typeof raw !== 'string') return null;
  // osmium export --add-unique-id=type_id emits Feature.id like `n123`, `w123`, `r123`.
  // Older / different exporters may use `node/123` etc.
  if (/^[nwr]\d+$/.test(raw)) return raw;
  const match = raw.match(/^(node|way|relation)\/(\d+)$/);
  if (!match) return raw.slice(0, 32);
  return `${match[1][0]}${match[2]}`;
}

function isChineseName(text) {
  if (!text) return false;
  // A single Han character is enough to count; tolerates Chinese-English mixed names.
  return /[\u3400-\u9fff]/.test(text);
}

function normalizePoi(feature) {
  const props = feature.properties || {};
  const point = getPointFromFeature(feature);
  if (!point) return null;

  const nameZh = props['name:zh'] || props['name:zh-Hans'] || props['name:zh-Hant'] || '';
  const nameRaw = props.name || '';
  const nameEn = props['name:en'] || '';

  // Prefer explicit Chinese name; otherwise use raw name if it contains Han chars; otherwise fall back to English; otherwise skip.
  let displayName = '';
  if (nameZh) displayName = nameZh;
  else if (isChineseName(nameRaw)) displayName = nameRaw;
  else if (nameEn) displayName = nameEn;
  else if (nameRaw) displayName = nameRaw;
  else return null;

  const id = compressOsmId(
    feature.id || props['@id'] || props['osm:id'] || props['osm_id'] || '',
  );
  return {
    id: id || `x${Math.floor(Math.random() * 1e12).toString(36)}`,
    name: displayName,
    nameZh,
    nameRaw,
    nameEn,
    lng: point[0],
    lat: point[1],
    kind: extractKind(props),
    hasZh: Boolean(nameZh) || isChineseName(nameRaw),
  };
}

async function streamPois(input, onPoi) {
  const stream = fs.createReadStream(input, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  let raw = 0;
  let normalized = 0;
  for await (const line of rl) {
    if (!line) continue;
    // osmium geojsonseq uses the RS-prefixed form (0x1e) per RFC 7464.
    const trimmed = line.charCodeAt(0) === 0x1e ? line.slice(1) : line;
    if (!trimmed.startsWith('{')) continue;
    let feature;
    try {
      feature = JSON.parse(trimmed);
    } catch {
      continue;
    }
    raw += 1;
    const poi = normalizePoi(feature);
    if (poi) {
      onPoi(poi);
      normalized += 1;
    }
    if (raw % 200000 === 0) {
      process.stdout.write(`  ...${raw.toLocaleString('en-US')} features read (${normalized.toLocaleString('en-US')} kept)\n`);
    }
  }
  return { raw, normalized };
}

function packShard(pois) {
  // Drop build-time-only fields; runtime only needs id/name/lng/lat/kind.
  return pois.map((p) => ({
    id: p.id,
    name: p.name,
    lng: Number(p.lng.toFixed(6)),
    lat: Number(p.lat.toFixed(6)),
    kind: p.kind,
  }));
}

function packShardForBackfill(pois) {
  // Preserve fields needed by fill-chinese-names.mjs so we don't re-run the whole pipeline.
  return pois.map((p) => ({
    id: p.id,
    name: p.name,
    nameZh: p.nameZh,
    nameRaw: p.nameRaw,
    nameEn: p.nameEn,
    lng: Number(p.lng.toFixed(6)),
    lat: Number(p.lat.toFixed(6)),
    kind: p.kind,
    hasZh: p.hasZh,
  }));
}

async function main() {
  const startedAt = Date.now();

  if (!fs.existsSync(inputPath)) {
    process.stderr.write(
      [
        `[build-pois] input not found: ${inputPath}`,
        '',
        'Prepare it with:',
        '  curl -O https://download.geofabrik.de/asia/china-latest.osm.pbf',
        '  osmium tags-filter china-latest.osm.pbf n/name w/name -o named.osm.pbf',
        '  osmium export named.osm.pbf -f geojsonseq -o data/raw/pois.geojsonseq',
        '',
        'Or set POI_INPUT to an alternate path.',
        '',
      ].join('\n'),
    );
    process.exit(1);
  }

  process.stdout.write('loading leaf-district boundaries...\n');
  const leaves = await loadLeafDistricts();
  process.stdout.write(`  ${leaves.length} leaf districts loaded\n`);

  process.stdout.write('building spatial index...\n');
  const tree = buildSpatialIndex(leaves);

  process.stdout.write(`streaming POIs from ${inputPath}...\n`);
  const buckets = new Map();
  let matched = 0;
  let unmatched = 0;

  const { raw, normalized } = await streamPois(inputPath, (poi) => {
    const candidates = tree.search({ minX: poi.lng, minY: poi.lat, maxX: poi.lng, maxY: poi.lat });
    for (const candidate of candidates) {
      const leaf = leaves[candidate.index];
      if (turf.booleanPointInPolygon(turf.point([poi.lng, poi.lat]), leaf.feature)) {
        let bucket = buckets.get(leaf.adcode);
        if (!bucket) {
          bucket = [];
          buckets.set(leaf.adcode, bucket);
        }
        bucket.push(poi);
        matched += 1;
        return;
      }
    }
    unmatched += 1;
  });

  process.stdout.write(`  raw features:  ${raw.toLocaleString('en-US')}\n`);
  process.stdout.write(`  normalized:    ${normalized.toLocaleString('en-US')}\n`);
  process.stdout.write(`  matched:       ${matched.toLocaleString('en-US')}\n`);
  process.stdout.write(`  unmatched:     ${unmatched.toLocaleString('en-US')} (outside any mainland leaf district)\n`);

  await fs.promises.mkdir(outDir, { recursive: true });

  // Also write a side-by-side build-only shard that keeps name:zh/name:en, so
  // the regeo backfill script can operate without re-running the full pipeline.
  const backfillDir = path.join(projectRoot, 'data', '.pois-build');
  await fs.promises.mkdir(backfillDir, { recursive: true });

  const shardMeta = {};
  let totalMissingZh = 0;

  for (const [adcode, pois] of buckets) {
    const runtimePath = path.join(outDir, `${adcode}.js`);
    const runtimePayload = packShard(pois);
    const runtimeSource = [
      'window.__POI_SHARDS__ = window.__POI_SHARDS__ || Object.create(null);',
      `window.__POI_SHARDS__[${JSON.stringify(adcode)}] = ${JSON.stringify(runtimePayload)};`,
      '',
    ].join('\n');
    await fs.promises.writeFile(runtimePath, runtimeSource, 'utf8');

    const backfillPayload = packShardForBackfill(pois);
    await fs.promises.writeFile(
      path.join(backfillDir, `${adcode}.json`),
      JSON.stringify(backfillPayload),
      'utf8',
    );

    const missingZh = pois.reduce((sum, p) => sum + (p.hasZh ? 0 : 1), 0);
    totalMissingZh += missingZh;
    shardMeta[adcode] = { count: pois.length, missingZh };
  }

  const manifest = {
    version: 1,
    generatedAt: new Date().toISOString(),
    source: {
      name: 'OpenStreetMap',
      provider: 'OpenStreetMap contributors',
      license: 'ODbL 1.0',
      licenseUrl: 'https://opendatacommons.org/licenses/odbl/1-0/',
      attribution: 'POI 数据 © OpenStreetMap contributors',
    },
    rawFeatureCount: raw,
    normalizedCount: normalized,
    totalPois: matched,
    unmatchedCount: unmatched,
    shardCount: buckets.size,
    missingChineseCount: totalMissingZh,
    shards: shardMeta,
  };
  const manifestSource = `window.__POI_MANIFEST__ = ${JSON.stringify(manifest)};\n`;
  await fs.promises.writeFile(manifestPath, manifestSource, 'utf8');

  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
  process.stdout.write(
    `done: ${buckets.size} shards, ${matched.toLocaleString('en-US')} POIs (${totalMissingZh.toLocaleString('en-US')} missing Chinese name), in ${elapsed}s\n`,
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
