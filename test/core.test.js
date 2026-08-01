import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isLand, MASK_W, MASK_H,
  project, cellCenter,
  CITIES, resolveCity,
  snapToLand, DEFAULTS
} from "../dist/mapamundi.js";

// The dist bundle is what ships — test THAT, not src/, so a build bug can
// never pass the suite.

const GRID = { cols: 120, rows: 47, latRange: [-58, 84] };

test("mask: known land and sea points", () => {
  assert.equal(isLand(40.4, -3.7), true, "Madrid");
  assert.equal(isLand(-5, -60), true, "Amazon");
  assert.equal(isLand(65, 100), true, "Siberia");
  assert.equal(isLand(23, 10), true, "Sahara");
  assert.equal(isLand(30, -40), false, "mid-Atlantic");
  assert.equal(isLand(0, -150), false, "mid-Pacific");
  assert.equal(isLand(-20, 80), false, "Indian Ocean");
});

test("mask: poles and bounds don't explode", () => {
  assert.equal(typeof isLand(90, 180), "boolean");
  assert.equal(typeof isLand(-90, -180), "boolean");
  assert.equal(isLand(91, 0), false, "out of range is sea");
});

test("projection: project and cellCenter are inverses at cell centers", () => {
  for (const [col, row] of [[0, 0], [60, 23], [119, 46]]) {
    const { lat, lon } = cellCenter(col, row, GRID);
    const { x, y } = project(lat, lon, GRID);
    assert.ok(Math.abs(x - (col + 0.5)) < 1e-9, `x roundtrip for ${col}`);
    assert.ok(Math.abs(y - (row + 0.5)) < 1e-9, `y roundtrip for ${row}`);
  }
});

test("projection: latRange top edge maps to y=0", () => {
  const { y } = project(GRID.latRange[1], 0, GRID);
  assert.equal(y, 0);
});

test("cities: registry lookups are case-insensitive and trimmed", () => {
  assert.deepEqual(resolveCity("London"), { name: "London", lat: 51.5, lon: -0.1 });
  assert.equal(resolveCity("  lagos ").lat, 6.5);
  assert.equal(resolveCity("SINGAPORE").lon, 103.8);
});

test("cities: unknown names resolve to null, never throw", () => {
  assert.equal(resolveCity("Atlantis"), null);
  assert.equal(resolveCity(""), null);
  assert.equal(resolveCity({ name: "no coords" }), null);
});

test("cities: custom coordinate entries pass through", () => {
  const custom = resolveCity({ name: "HQ", lat: 1.2, lon: 3.4, color: "#f00" });
  assert.equal(custom.name, "HQ");
  assert.equal(custom.color, "#f00");
});

test("cities: every registry entry sits on land after snapping", () => {
  // The registry's whole promise: type a name, get a marker ON the map.
  // Snapped cell must be land for every city at the default resolution.
  for (const [name, [lat, lon]] of Object.entries(CITIES)) {
    const { col, row } = snapToLand(lat, lon, GRID);
    const c = cellCenter(col, row, GRID);
    assert.equal(isLand(c.lat, c.lon), true, `${name} snaps to sea at default resolution`);
  }
});

test("snapToLand: coastal city moves onto land, inland city stays put", () => {
  // Venice sits in the lagoon — must snap to a land cell.
  const venice = snapToLand(45.4, 12.3, GRID);
  const vc = cellCenter(venice.col, venice.row, GRID);
  assert.equal(isLand(vc.lat, vc.lon), true);

  // Madrid's own cell is land — snapping must not move it.
  const { x, y } = project(40.4, -3.7, GRID);
  const madrid = snapToLand(40.4, -3.7, GRID);
  assert.equal(madrid.col, Math.floor(x));
  assert.equal(madrid.row, Math.floor(y));
});

test("defaults: sane and internally consistent", () => {
  assert.ok(DEFAULTS.cols > 0);
  assert.ok(DEFAULTS.latRange[0] < DEFAULTS.latRange[1]);
  assert.equal(DEFAULTS.ambient, "none", "ambient animation is opt-in");
  assert.equal(DEFAULTS.interactive, true);
});
