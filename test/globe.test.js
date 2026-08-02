import { test } from "node:test";
import assert from "node:assert/strict";
import { latLonToXYZ, buildGlobePoints, buildGlobePhases, isLand } from "../dist/mappo.js";

// The globe's math layer is pure and must hold in Node — the canvas half
// only ever runs in a browser.

test("latLonToXYZ puts known points where the projection says", () => {
  const origin = latLonToXYZ(0, 0); // equator, prime meridian → faces viewer
  assert.ok(Math.abs(origin.x) < 1e-9 && Math.abs(origin.y) < 1e-9 && Math.abs(origin.z - 1) < 1e-9);

  const pole = latLonToXYZ(90, 0); // north pole → straight up
  assert.ok(Math.abs(pole.y - 1) < 1e-9 && Math.abs(pole.x) < 1e-9 && Math.abs(pole.z) < 1e-9);

  const east = latLonToXYZ(0, 90); // 90°E → +x
  assert.ok(Math.abs(east.x - 1) < 1e-9 && Math.abs(east.z) < 1e-9);
});

test("every globe point sits on the unit sphere", () => {
  const pts = buildGlobePoints(120, [-58, 84]);
  assert.ok(pts.length > 0, "no land points generated");
  for (let i = 0; i < pts.length; i += 3) {
    const r = Math.hypot(pts[i], pts[i + 1], pts[i + 2]);
    assert.ok(Math.abs(r - 1) < 1e-6, `point ${i / 3} off the sphere: |r|=${r}`);
  }
});

test("globe density scales with resolution and stays land-only-plausible", () => {
  const lo = buildGlobePoints(80, [-58, 84]).length / 3;
  const hi = buildGlobePoints(160, [-58, 84]).length / 3;
  // Doubling cols quadruples cells; land fraction is scale-free, so the
  // point count should land near 4× (sampling noise allowed).
  assert.ok(hi > lo * 3 && hi < lo * 5, `expected ~4× density, got ${hi / lo}×`);
  // Sanity: the world is about 30% land; the grid should be nowhere near
  // all-land or all-ocean.
  const cells = 160 * Math.round((160 / 360) * 142);
  const frac = hi / cells;
  assert.ok(frac > 0.15 && frac < 0.5, `implausible land fraction ${frac}`);
  assert.ok(isLand(51.5, -0.1), "London sanity anchor");
});

test("land and water buffers partition the grid exactly", () => {
  const cols = 100;
  const latRange = [-58, 84];
  const rows = Math.round((cols / 360) * (latRange[1] - latRange[0]));
  const land = buildGlobePoints(cols, latRange).length / 3;
  const water = buildGlobePoints(cols, latRange, true).length / 3;
  assert.equal(land + water, cols * rows, "every cell is exactly one of land|water");
  assert.ok(water > land, "Earth is mostly ocean");
});

test("animation phases align one-to-one with globe points", () => {
  for (const mode of ["wave", "noise", "ripple", "sweep", "sparkle"]) {
    const pts = buildGlobePoints(90, [-58, 84]).length / 3;
    const ph = buildGlobePhases(90, [-58, 84], mode);
    assert.equal(ph.length / 2, pts, `${mode}: phase pairs must match point count`);
    for (let i = 0; i < ph.length; i += 2) {
      assert.ok(ph[i] >= 0 && ph[i] <= 1.01, `${mode}: phase in [0,1]`);
      assert.ok(ph[i + 1] >= 0.55 && ph[i + 1] <= 1, `${mode}: amp in [0.55,1]`);
    }
  }
});
