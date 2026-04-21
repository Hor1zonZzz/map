#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import * as turf from "@turf/turf";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..");
const boundaryDir = path.join(projectRoot, "data", "boundaries");
const seedPath = path.join(projectRoot, "data", "destinations.seed.json");
const outPath = path.join(projectRoot, "data", "destinations.js");
const DESTINATION_KINDS = new Set(["scenic", "urban", "food", "nature", "landmark"]);

export async function loadBoundaryIndex() {
  const files = (await fs.readdir(boundaryDir))
    .filter((name) => name.endsWith("_full.js"))
    .sort();
  const index = new Map();

  for (const file of files) {
    const source = await fs.readFile(path.join(boundaryDir, file), "utf8");
    const context = { window: {} };
    vm.createContext(context);
    vm.runInContext(source, context);
    const data = context.window.__BOUNDARY_DATA__ || {};
    for (const geo of Object.values(data)) {
      for (const feature of geo.features || []) {
        const props = feature.properties || {};
        index.set(String(props.adcode), feature);
      }
    }
  }

  return index;
}

export function validateDestinationSeeds(seedData, boundaryIndex) {
  const seenIds = new Set();
  const byAdcode = Object.create(null);

  for (const raw of seedData.destinations || []) {
    if (seenIds.has(raw.id)) {
      throw new Error(`Duplicate destination id: ${raw.id}`);
    }
    seenIds.add(raw.id);

    const feature = boundaryIndex.get(String(raw.adcode));
    if (!feature) {
      throw new Error(`Unknown adcode for destination ${raw.id}: ${raw.adcode}`);
    }

    if (feature.properties?.level !== "district" || Number(feature.properties?.childrenNum || 0) !== 0) {
      throw new Error(`Destination ${raw.id} must point to a district leaf adcode: ${raw.adcode}`);
    }

    if (!Number.isFinite(raw.lng) || !Number.isFinite(raw.lat)) {
      throw new Error(`Invalid coordinates for destination ${raw.id}`);
    }

    if (!DESTINATION_KINDS.has(String(raw.kind))) {
      throw new Error(`Invalid destination kind for ${raw.id}: ${raw.kind}`);
    }

    const point = turf.point([raw.lng, raw.lat]);
    if (!turf.booleanPointInPolygon(point, feature)) {
      throw new Error(`Destination ${raw.id} is outside district ${raw.adcode}`);
    }

    const record = {
      id: String(raw.id),
      name: String(raw.name),
      adcode: String(raw.adcode),
      lng: Number(raw.lng),
      lat: Number(raw.lat),
      kind: String(raw.kind),
      summary: String(raw.summary),
      sourceType: "curated",
    };

    byAdcode[record.adcode] = byAdcode[record.adcode] || [];
    byAdcode[record.adcode].push(record);
  }

  return {
    version: Number(seedData.version || 1),
    generatedAt: new Date().toISOString(),
    byAdcode,
  };
}

export async function compileDestinationLibrary() {
  const seedData = JSON.parse(await fs.readFile(seedPath, "utf8"));
  const boundaryIndex = await loadBoundaryIndex();
  return validateDestinationSeeds(seedData, boundaryIndex);
}

export async function writeDestinationModule(compiled) {
  const source = [
    `window.__DESTINATIONS__ = ${JSON.stringify(compiled)};`,
    "",
  ].join("\n");
  await fs.writeFile(outPath, source, "utf8");
}

async function main() {
  const compiled = await compileDestinationLibrary();
  await writeDestinationModule(compiled);
  process.stdout.write(
    `saved destinations: ${Object.keys(compiled.byAdcode).length} districts, ${Object.values(compiled.byAdcode).reduce((sum, items) => sum + items.length, 0)} points\n`,
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
