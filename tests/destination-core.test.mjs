import test from "node:test";
import assert from "node:assert/strict";

import * as turf from "@turf/turf";

import {
  pickRandomImpactLngLat,
  pickRegionForCurrentDepth,
  pointInsideFeature,
  projectLngLatToScreen,
  resolveDestination,
} from "../src/destination-core.mjs";
import { loadBoundaryIndex } from "../scripts/build-destinations.mjs";

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

test("resolveDestination prefers curated destinations and samples them roughly uniformly", () => {
  const feature = boundaryIndex.get("110101");
  const region = {
    adcode: "110101",
    name: "东城区",
    center: feature.properties.center,
    centroid: feature.properties.centroid,
    feature,
  };
  const curatedIndex = {
    "110101": [
      { id: "a", name: "A", adcode: "110101", lng: 116.397026, lat: 39.918058, kind: "landmark", summary: "A", sourceType: "curated" },
      { id: "b", name: "B", adcode: "110101", lng: 116.403414, lat: 39.932161, kind: "scenic", summary: "B", sourceType: "curated" },
      { id: "c", name: "C", adcode: "110101", lng: 116.417028, lat: 39.948747, kind: "landmark", summary: "C", sourceType: "curated" },
    ],
  };
  const counts = { a: 0, b: 0, c: 0 };
  const random = seededRandom(7);

  for (let i = 0; i < 3000; i++) {
    counts[resolveDestination(region, curatedIndex, geoOps, random).id] += 1;
  }

  assert.ok(counts.a > 800 && counts.a < 1200);
  assert.ok(counts.b > 800 && counts.b < 1200);
  assert.ok(counts.c > 800 && counts.c < 1200);
});

test("resolveDestination falls back to a safe in-polygon point when center is unusable", () => {
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
    center: [3, 3],
    centroid: [3, 3],
    feature,
  };

  const destination = resolveDestination(region, {}, geoOps, seededRandom(3));
  assert.equal(destination.sourceType, "fallback");
  assert.match(destination.name, /参考点/);
  assert.equal(pointInsideFeature(geoOps, [destination.lng, destination.lat], feature), true);
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
