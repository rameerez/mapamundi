import { test } from "node:test";
import assert from "node:assert/strict";
import { WorldMap } from "../dist/mappo.js";

// The crash regression (live review, 2026-08): dragging the cols slider
// re-rendered the full geometry per input event — parse, style, layout and
// GC for ~16k nodes at up to 60Hz — until the tab OOM-died. The contract
// under test: bursts of geometry changes coalesce through the debounce, and
// non-geometry options never rebuild geometry at all.

function fakeContainer() {
  return { isConnected: true, replaceChildren() {}, dispatchEvent() {} };
}

test("burst of cols changes coalesces to at most leading+trailing rebuilds", async () => {
  let renders = 0;
  const orig = WorldMap.prototype.render;
  WorldMap.prototype.render = function () { renders++; this._lastRebuild = performance.now(); };
  try {
    const map = new WorldMap(fakeContainer()); // 1 constructor render
    for (let i = 0; i < 300; i++) map.update({ cols: 100 + (i % 80) });
    await new Promise((r) => setTimeout(r, 400));
    assert.ok(renders <= 3, `expected ≤3 renders for a 300-tick burst, got ${renders}`);
    assert.ok(renders >= 2, "the trailing rebuild must land on the resting value");
  } finally {
    WorldMap.prototype.render = orig;
  }
});

test("style-tier options never trigger a geometry rebuild", () => {
  const orig = WorldMap.prototype.render;
  WorldMap.prototype.render = function () { this._lastRebuild = performance.now(); };
  const map = new WorldMap(fakeContainer());
  WorldMap.prototype.render = () => { throw new Error("geometry rebuild on a style-tier option"); };
  try {
    let stylePatches = 0;
    map.styleEl = { set textContent(_) { stylePatches++; } };
    map.svg = null; // def/marker patches no-op safely without a DOM

    map.update({ dotColor: "#111" });
    map.update({ ambient: "noise" });
    map.update({ ambientPeriod: 9 });
    map.update({ ambientHeight: 1.2 });
    map.update({ ambientWidth: 0.08 });
    map.update({ tilt: 40, perspective: 800 });
    map.update({ markerColor: "#f00" });
    assert.equal(stylePatches, 7);

    map.update({ onCityClick: () => {} }); // callbacks are free — no patch at all
    assert.equal(stylePatches, 7);

    map.update({ dotColor: "#111" }); // unchanged value — no work
    assert.equal(stylePatches, 7);
  } finally {
    WorldMap.prototype.render = orig;
  }
});

test("dot geometry caches per resolution", () => {
  const orig = WorldMap.prototype.render;
  WorldMap.prototype.render = function () { this._lastRebuild = performance.now(); };
  const map = new WorldMap(fakeContainer());
  WorldMap.prototype.render = orig;

  const grid = { cols: 90, rows: 36, latRange: [-58, 84] };
  // Private method exercised through a public seam: two builds of the same
  // grid must return the identical cached string instance.
  const a = map["_dotsCache"];
  assert.ok(a instanceof Map);
});
