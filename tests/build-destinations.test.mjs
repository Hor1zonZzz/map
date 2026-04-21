import test from "node:test";
import assert from "node:assert/strict";

import { compileDestinationLibrary, loadBoundaryIndex, validateDestinationSeeds } from "../scripts/build-destinations.mjs";

const boundaryIndex = await loadBoundaryIndex();

test("compileDestinationLibrary builds the curated destination index", async () => {
  const compiled = await compileDestinationLibrary();
  assert.equal(Object.keys(compiled.byAdcode).length, 10);
  assert.equal(
    Object.values(compiled.byAdcode).reduce((sum, items) => sum + items.length, 0),
    30,
  );
  assert.equal(compiled.byAdcode["110101"][0].sourceType, "curated");
});

test("validateDestinationSeeds rejects duplicate ids", () => {
  assert.throws(
    () => validateDestinationSeeds({
      version: 1,
      destinations: [
        { id: "dup", name: "A", adcode: "110101", lng: 116.397026, lat: 39.918058, kind: "landmark", summary: "x" },
        { id: "dup", name: "B", adcode: "110101", lng: 116.403414, lat: 39.932161, kind: "scenic", summary: "y" },
      ],
    }, boundaryIndex),
    /Duplicate destination id/,
  );
});

test("validateDestinationSeeds rejects unknown district adcodes", () => {
  assert.throws(
    () => validateDestinationSeeds({
      version: 1,
      destinations: [
        { id: "bad-adcode", name: "A", adcode: "999999", lng: 116.397026, lat: 39.918058, kind: "landmark", summary: "x" },
      ],
    }, boundaryIndex),
    /Unknown adcode/,
  );
});

test("validateDestinationSeeds rejects coordinates outside the declared district", () => {
  assert.throws(
    () => validateDestinationSeeds({
      version: 1,
      destinations: [
        { id: "outside", name: "A", adcode: "110101", lng: 121.490317, lat: 31.241701, kind: "landmark", summary: "x" },
      ],
    }, boundaryIndex),
    /outside district/,
  );
});
