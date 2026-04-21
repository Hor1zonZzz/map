import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

import * as turf from "@turf/turf";

import {
  createFallbackDestination,
  pickRandomImpactLngLat,
  pickRegionForCurrentDepth,
  pointInsideFeature,
  projectLngLatToScreen,
  resolveDestination,
} from "../src/destination-core.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const boundaryDir = path.resolve(__dirname, "..", "data", "boundaries");

async function loadBoundaryIndex() {
  const files = (await fs.readdir(boundaryDir)).filter((name) => name.endsWith("_full.js")).sort();
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

const boundaryIndex = await loadBoundaryIndex();
const geoOps = {
  bbox: turf.bbox,
  point: turf.point,
  booleanPointInPolygon: turf.booleanPointInPolygon,
  pointOnFeature: turf.pointOnFeature,
};

function seededRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (1664525 * state + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

test("pickRandomImpactLngLat always returns a point inside the selected polygon", () => {
  const feature = boundaryIndex.get("330106");
  const region = {
    adcode: "330106",
    center: feature.properties.center,
    centroid: feature.properties.centroid,
    feature,
  };
  const random = seededRandom(42);

  for (let i = 0; i < 20; i++) {
    const point = pickRandomImpactLngLat(region, geoOps, random, 300);
    assert.equal(pointInsideFeature(geoOps, point, feature), true);
  }
});

test("resolveDestination samples OSM POIs for the adcode with roughly uniform weight", () => {
  const feature = boundaryIndex.get("110101");
  const region = {
    adcode: "110101",
    name: "东城区",
    center: feature.properties.center,
    centroid: feature.properties.centroid,
    feature,
  };
  const poiIndex = {
    "110101": [
      { id: "n1", name: "A", lng: 116.397026, lat: 39.918058, kind: "tourism.museum" },
      { id: "n2", name: "B", lng: 116.403414, lat: 39.932161, kind: "tourism.attraction" },
      { id: "n3", name: "C", lng: 116.417028, lat: 39.948747, kind: "amenity.restaurant" },
    ],
  };
  const counts = { n1: 0, n2: 0, n3: 0 };
  const random = seededRandom(7);

  for (let i = 0; i < 3000; i++) {
    const destination = resolveDestination(region, poiIndex, geoOps, random);
    assert.equal(destination.sourceType, "osm");
    counts[destination.id] += 1;
  }

  assert.ok(counts.n1 > 800 && counts.n1 < 1200);
  assert.ok(counts.n2 > 800 && counts.n2 < 1200);
  assert.ok(counts.n3 > 800 && counts.n3 < 1200);
});

test("resolveDestination falls back to a geometric random point when the adcode has no POI coverage", () => {
  const feature = turf.polygon([[
    [0, 0],
    [2, 0],
    [2, 2],
    [0, 2],
    [0, 0],
  ]]);
  const region = {
    adcode: "test",
    name: "测试区",
    center: [1, 1],
    centroid: [1, 1],
    feature,
  };

  const destination = resolveDestination(region, {}, geoOps, seededRandom(3));
  assert.equal(destination.sourceType, "random");
  assert.match(destination.name, /随机落点/);
  assert.equal(pointInsideFeature(geoOps, [destination.lng, destination.lat], feature), true);
});

test("createFallbackDestination always returns the provided coordinate", () => {
  const region = { adcode: "999999", name: "示例区" };
  const dest = createFallbackDestination(region, [120.5, 30.5]);
  assert.equal(dest.sourceType, "random");
  assert.equal(dest.lng, 120.5);
  assert.equal(dest.lat, 30.5);
});

test("pickRegionForCurrentDepth keeps province and city sampling uniform while honoring filters", () => {
  const regions = [
    { adcode: "a", childrenNum: 2 },
    { adcode: "b", childrenNum: 2 },
    { adcode: "c", childrenNum: 0 },
  ];
  const counts = { a: 0, b: 0 };
  const random = seededRandom(11);

  for (let i = 0; i < 2000; i++) {
    const picked = pickRegionForCurrentDepth({
      regions,
      currentDepth: 0,
      maxDepth: 2,
      hasRadiusSelection: false,
      isRegionFilteredIn: () => true,
      isRegionWithinRadius: () => false,
    }, random);
    counts[picked.adcode] += 1;
  }

  assert.ok(counts.a > 850 && counts.a < 1150);
  assert.ok(counts.b > 850 && counts.b < 1150);
});

test("projectLngLatToScreen uses the provided projection", () => {
  const projection = ([lng, lat]) => [lng * 10, lat * -5];
  assert.deepEqual(projectLngLatToScreen(projection, [12, 8]), { x: 120, y: -40 });
});
