#!/usr/bin/env node

// Backfill Chinese names for POIs that OSM left without `name:zh` and whose primary
// `name` tag is not Chinese. Uses the Amap reverse-geocoding Web Service API.
//
// Requires:
//   - AMAP_KEY env var (free web service key from https://lbs.amap.com)
//   - data/.pois-build/<adcode>.json files produced by scripts/build-pois.mjs
//
// Output: rewrites data/.pois-build/<adcode>.json and data/pois/<adcode>.js
//         for every shard that changed; also rewrites data/pois-manifest.js.
//
// Rate limits (free tier, one developer key):
//   - 5000 requests / day
//   - 3 QPS (we throttle to ~2 to leave headroom)
//
// Progress is checkpointed to data/.regeo-progress.json so the script can be
// resumed if interrupted or daily quota is hit.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');
const backfillDir = path.join(projectRoot, 'data', '.pois-build');
const runtimeDir = path.join(projectRoot, 'data', 'pois');
const manifestPath = path.join(projectRoot, 'data', 'pois-manifest.js');
const progressPath = path.join(projectRoot, 'data', '.regeo-progress.json');

const AMAP_KEY = process.env.AMAP_KEY;
const DAILY_BUDGET = Number(process.env.AMAP_DAILY_BUDGET || 4800);
const QPS = Number(process.env.AMAP_QPS || 2);
const REGEO_ENDPOINT = 'https://restapi.amap.com/v3/geocode/regeo';

if (!AMAP_KEY) {
  process.stderr.write('[fill-chinese-names] AMAP_KEY env var is required\n');
  process.exit(1);
}

async function readJson(file, fallback) {
  try {
    return JSON.parse(await fs.promises.readFile(file, 'utf8'));
  } catch {
    return fallback;
  }
}

async function writeJson(file, data) {
  await fs.promises.writeFile(file, JSON.stringify(data), 'utf8');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isChinese(text) {
  return /[\u3400-\u9fff]/.test(text || '');
}

function pickZhFromRegeo(payload, fallback) {
  const regeo = payload?.regeocode;
  if (!regeo) return null;
  const pois = Array.isArray(regeo.pois) ? regeo.pois : [];
  const withName = pois.find((p) => p?.name && isChinese(p.name));
  if (withName) return String(withName.name);
  const aoi = Array.isArray(regeo.aois) ? regeo.aois : [];
  const aoiWithName = aoi.find((a) => a?.name && isChinese(a.name));
  if (aoiWithName) return String(aoiWithName.name);
  const road = regeo.roads?.[0]?.name;
  if (road && isChinese(road)) return road;
  const formatted = regeo.formatted_address;
  if (formatted && isChinese(formatted)) return String(formatted);
  return fallback || null;
}

async function regeo(lng, lat) {
  const url = new URL(REGEO_ENDPOINT);
  url.searchParams.set('key', AMAP_KEY);
  url.searchParams.set('location', `${lng},${lat}`);
  url.searchParams.set('extensions', 'all');
  url.searchParams.set('radius', '200');
  url.searchParams.set('poitype', '');
  const response = await fetch(url, { headers: { accept: 'application/json' } });
  if (!response.ok) throw new Error(`regeo http ${response.status}`);
  const payload = await response.json();
  if (String(payload.status) !== '1') {
    throw new Error(`regeo api error: ${payload.info || payload.infocode || 'unknown'}`);
  }
  return payload;
}

function packRuntime(pois) {
  return pois.map((p) => ({
    id: p.id,
    name: p.name,
    lng: Number(p.lng.toFixed ? p.lng.toFixed(6) : p.lng),
    lat: Number(p.lat.toFixed ? p.lat.toFixed(6) : p.lat),
    kind: p.kind,
  }));
}

async function writeRuntimeShard(adcode, pois) {
  const payload = packRuntime(pois);
  const source = [
    'window.__POI_SHARDS__ = window.__POI_SHARDS__ || Object.create(null);',
    `window.__POI_SHARDS__[${JSON.stringify(adcode)}] = ${JSON.stringify(payload)};`,
    '',
  ].join('\n');
  await fs.promises.writeFile(path.join(runtimeDir, `${adcode}.js`), source, 'utf8');
}

async function loadManifest() {
  const source = await fs.promises.readFile(manifestPath, 'utf8');
  const match = source.match(/window\.__POI_MANIFEST__\s*=\s*(.*);?\s*$/);
  if (!match) throw new Error('cannot parse manifest');
  const jsonStr = match[1].replace(/;\s*$/, '');
  return JSON.parse(jsonStr);
}

async function writeManifest(manifest) {
  const source = `window.__POI_MANIFEST__ = ${JSON.stringify(manifest)};\n`;
  await fs.promises.writeFile(manifestPath, source, 'utf8');
}

async function main() {
  if (!fs.existsSync(backfillDir)) {
    process.stderr.write(
      `[fill-chinese-names] missing ${backfillDir} — run scripts/build-pois.mjs first\n`,
    );
    process.exit(1);
  }

  const progress = await readJson(progressPath, {
    completedIds: {},
    dailyCalls: { date: '', used: 0 },
  });

  const today = new Date().toISOString().slice(0, 10);
  if (progress.dailyCalls.date !== today) {
    progress.dailyCalls = { date: today, used: 0 };
  }

  const manifest = await loadManifest();
  const shards = Object.keys(manifest.shards || {}).sort();

  let calls = 0;
  let updated = 0;
  const intervalMs = Math.max(1, Math.floor(1000 / QPS));

  for (const adcode of shards) {
    if (progress.dailyCalls.used >= DAILY_BUDGET) {
      process.stdout.write(`daily budget reached (${progress.dailyCalls.used}/${DAILY_BUDGET}); stopping\n`);
      break;
    }

    const shardPath = path.join(backfillDir, `${adcode}.json`);
    if (!fs.existsSync(shardPath)) continue;
    const pois = await readJson(shardPath, []);
    let shardChanged = false;

    for (const poi of pois) {
      if (poi.hasZh) continue;
      if (progress.completedIds[poi.id]) continue;
      if (progress.dailyCalls.used >= DAILY_BUDGET) break;

      try {
        const payload = await regeo(poi.lng, poi.lat);
        const zh = pickZhFromRegeo(payload, poi.nameZh || poi.nameRaw);
        if (zh && isChinese(zh) && zh !== poi.name) {
          poi.name = zh;
          poi.nameZh = zh;
          poi.hasZh = true;
          shardChanged = true;
          updated += 1;
        } else {
          poi.hasZh = true; // mark as attempted so we don't retry
        }
        progress.completedIds[poi.id] = 1;
      } catch (error) {
        process.stderr.write(`  regeo failed for ${poi.id}: ${error.message}\n`);
      }

      progress.dailyCalls.used += 1;
      calls += 1;
      if (calls % 100 === 0) {
        process.stdout.write(
          `  ...${calls} regeo calls (${updated} names filled, today used ${progress.dailyCalls.used}/${DAILY_BUDGET})\n`,
        );
        await writeJson(progressPath, progress);
      }
      await sleep(intervalMs);
    }

    if (shardChanged) {
      await writeJson(shardPath, pois);
      await writeRuntimeShard(adcode, pois);
    }

    await writeJson(progressPath, progress);
  }

  // Recompute missingChineseCount based on current stash.
  let totalMissing = 0;
  for (const adcode of shards) {
    const shardPath = path.join(backfillDir, `${adcode}.json`);
    if (!fs.existsSync(shardPath)) continue;
    const pois = await readJson(shardPath, []);
    const missing = pois.reduce((sum, p) => sum + (p.hasZh ? 0 : 1), 0);
    manifest.shards[adcode].missingZh = missing;
    totalMissing += missing;
  }
  manifest.missingChineseCount = totalMissing;
  manifest.lastBackfillAt = new Date().toISOString();
  await writeManifest(manifest);

  process.stdout.write(
    `done: ${calls} regeo calls made, ${updated} Chinese names filled; today used ${progress.dailyCalls.used}/${DAILY_BUDGET}\n`,
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
