// Globe mode: the same land grid wrapped on a sphere and spun — on canvas,
// not SVG. A rotating globe re-projects every dot every frame; SVG would
// mean thousands of DOM attribute writes at 60Hz, which is exactly the
// failure mode the flat renderer's architecture exists to avoid. Canvas
// redraws ~4k rects/frame without noticing.
//
// The visual grammar (matched to the reference the mode was built for):
// dots shrink and fade toward the limb (foreshortening reads as depth),
// the front hemisphere only (back culled), and a thin halo ring floats
// just outside the sphere. tilt doubles as the axial tilt here — the same
// option that lays the flat map down leans the globe.
//
// Node-safe: the point-buffer builders are pure and testable; GlobeRenderer
// touches the DOM only in its constructor, which only runs in a browser.

import { isLand } from "./mask.js";
import { cellCenter } from "./projection.js";
import { resolveCity } from "./cities.js";

// Unit-sphere position for a lat/lon. At rotation 0, lon 0 faces the
// viewer (+z out of the screen), +y is north.
export function latLonToXYZ(lat, lon) {
  const phi = (lat * Math.PI) / 180;
  const lambda = (lon * Math.PI) / 180;
  const cosPhi = Math.cos(phi);
  return {
    x: cosPhi * Math.sin(lambda),
    y: Math.sin(phi),
    z: cosPhi * Math.cos(lambda)
  };
}

// Land dots as a flat Float32Array [x,y,z, x,y,z, …] — same grid sampling
// as the flat renderer (cellCenter + isLand), so flat and globe agree on
// what the world looks like at a given resolution.
export function buildGlobePoints(cols, latRange, water = false) {
  const rows = Math.round((cols / 360) * (latRange[1] - latRange[0]));
  const grid = { cols, rows, latRange };
  const out = [];
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const c = cellCenter(col, row, grid);
      if (isLand(c.lat, c.lon) === water) continue;
      const p = latLonToXYZ(c.lat, c.lon);
      out.push(p.x, p.y, p.z);
    }
  }
  return new Float32Array(out);
}

export class GlobeRenderer {
  // @param container [HTMLElement] emptied; a square canvas fills its width.
  // @param options   [Object] the owning WorldMap's options (shared ref).
  constructor(container, options) {
    this.container = container;
    this.o = options;
    this.angle = 0;
    this._raf = null;
    this._t = null;

    // <world-map> is inline by default — an inline container has
    // clientWidth 0, which turned v0.3.0's first cut into a stretched
    // ribbon (square backing store, rectangular CSS box). Two guarantees
    // fix it for good: the host becomes a block, and the canvas box is
    // aspect-locked square via CSS so display and backing store can never
    // disagree on shape.
    if (typeof getComputedStyle === "function" &&
        getComputedStyle(container).display === "inline") {
      container.style.display = "block";
    }
    this.canvas = document.createElement("canvas");
    this.canvas.className = "wm-globe";
    this.canvas.style.display = "block";
    this.canvas.style.width = "100%";
    this.canvas.style.aspectRatio = "1 / 1";
    container.replaceChildren(this.canvas);
    this.ctx = this.canvas.getContext("2d");

    this._rebuildData();

    // Reduced motion: one static frame, no loop. Checked once at build —
    // the OS-level setting rarely flips mid-visit.
    this._static = typeof matchMedia === "function" &&
      matchMedia("(prefers-reduced-motion: reduce)").matches;

    // Offscreen globes must not burn frames — pause when scrolled away.
    this._visible = true;
    if (typeof IntersectionObserver === "function") {
      this._io = new IntersectionObserver(([entry]) => {
        this._visible = entry.isIntersecting;
        if (this._visible && !this._raf && !this._static) {
          this._t = null; // don't let the paused gap become one giant dt
          this._loop();
        }
      });
      this._io.observe(this.canvas);
    }
    if (typeof ResizeObserver === "function") {
      // Observe the canvas itself: its CSS box (100% wide, aspect-locked
      // square) is the ground truth the backing store must match.
      this._ro = new ResizeObserver(() => this._resize());
      this._ro.observe(this.canvas);
    }

    this._resize(); // sizes the canvas and draws the first frame
    if (!this._static) this._loop();
  }

  // Any option may have changed (the options object is shared with the
  // owning WorldMap, so no diffing is possible here). Rebuilding the point
  // buffer is a few ms even at max resolution — just do it. The rotation
  // angle deliberately survives.
  update() {
    this._rebuildData();
    this._draw();
  }

  destroy() {
    if (this._raf) cancelAnimationFrame(this._raf);
    this._raf = null;
    this._io?.disconnect();
    this._ro?.disconnect();
    this.canvas.remove();
  }

  _rebuildData() {
    const cols = this.o.cols;
    this.points = buildGlobePoints(cols, this.o.latRange);
    this.waterPoints = this.o.oceanColor && this.o.oceanColor !== "none"
      ? buildGlobePoints(cols, this.o.latRange, true)
      : null;
    this.cities = (this.o.cities || [])
      .map((c) => (typeof c === "string" ? resolveCity(c) : c))
      .filter(Boolean)
      .map((c) => latLonToXYZ(c.lat, c.lon));
    if (this.o.dotShape !== "circle" && this.o.dotShape !== "square" &&
        this.o.dotShape !== "triangle" && !this._shapeWarned) {
      this._shapeWarned = true;
      console.warn(`[mappo] mode="globe" draws circle/square/triangle dots; custom SVG paths fall back to squares`);
    }
  }

  _resize() {
    const rect = this.canvas.getBoundingClientRect();
    const side = rect.width || this.container.clientWidth || 300;
    const dpr = (typeof devicePixelRatio === "number" && devicePixelRatio) || 1;
    this.side = side;
    this.canvas.width = Math.max(1, Math.round(side * dpr));
    this.canvas.height = Math.max(1, Math.round(side * dpr));
    this._dpr = dpr;
    this._draw();
  }

  _loop() {
    this._raf = requestAnimationFrame((t) => {
      this._raf = null;
      if (!this._visible) return; // the IntersectionObserver restarts us
      const dt = this._t == null ? 16 : Math.min(100, t - this._t);
      this._t = t;
      this.angle = (this.angle + (this.o.rotateSpeed * dt) / 1000) % 360;
      this._draw();
      this._loop();
    });
  }

  // One transformed, culled, depth-faded pass over a point buffer — land
  // and water share it; only color, size and alpha band differ.
  #drawPoints(pts, { cx, cy, R, sinR, cosR, sinT, cosT, base, shape, alphaLo, alphaHi }) {
    const ctx = this.ctx;
    for (let i = 0; i < pts.length; i += 3) {
      // Spin around the polar axis, then lean by the axial tilt.
      const x1 = pts[i] * cosR + pts[i + 2] * sinR;
      const z1 = -pts[i] * sinR + pts[i + 2] * cosR;
      const y2 = pts[i + 1] * cosT - z1 * sinT;
      const z2 = pts[i + 1] * sinT + z1 * cosT;
      if (z2 <= 0.01) continue; // back hemisphere
      const sx = cx + x1 * R;
      const sy = cy - y2 * R;
      const s = base * (0.45 + 0.55 * z2); // foreshortening at the limb
      ctx.globalAlpha = alphaLo + alphaHi * z2; // …and a depth fade
      if (shape === "circle") {
        ctx.beginPath();
        ctx.arc(sx, sy, s / 2, 0, 6.2832);
        ctx.fill();
      } else if (shape === "triangle") {
        ctx.beginPath();
        ctx.moveTo(sx, sy - s / 2);
        ctx.lineTo(sx + s / 2, sy + s / 2);
        ctx.lineTo(sx - s / 2, sy + s / 2);
        ctx.fill();
      } else {
        ctx.fillRect(sx - s / 2, sy - s / 2, s, s);
      }
    }
  }

  _draw() {
    const { ctx, side } = this;
    if (!ctx || !side) return;
    const o = this.o;
    ctx.setTransform(this._dpr, 0, 0, this._dpr, 0, 0);
    ctx.clearRect(0, 0, side, side);

    const cx = side / 2;
    const cy = side / 2;
    const R = side * 0.40; // breathing room — the halo must not kiss the edges

    // Solid planet: a uniform disc behind the dots.
    if (o.background && o.background !== "none") {
      ctx.beginPath();
      ctx.arc(cx, cy, R * 1.02, 0, Math.PI * 2);
      ctx.fillStyle = o.background;
      ctx.fill();
    }

    // The halo: a hairline orbit just outside the sphere. Optional.
    if (o.globeRing !== false) {
      ctx.beginPath();
      ctx.arc(cx, cy, R * 1.08, 0, Math.PI * 2);
      ctx.strokeStyle = o.dotColor;
      ctx.globalAlpha = 0.35;
      ctx.lineWidth = 1;
      ctx.stroke();
    }

    const rot = (this.angle * Math.PI) / 180;
    const tilt = ((o.tilt || 0) * Math.PI) / 180;
    const sinR = Math.sin(rot), cosR = Math.cos(rot);
    const sinT = Math.sin(tilt), cosT = Math.cos(tilt);

    // Dot footprint ≈ visible cell spacing: cols spans 360° of longitude,
    // so the front hemisphere shows cols/2 dots across 2R.
    const base = Math.max(0.75, (4 * R) / o.cols) * o.dotSize * 1.6;
    const shape = o.dotShape === "circle" || o.dotShape === "triangle" ? o.dotShape : "square";

    // Water first — smaller, dimmer, same transform — so land reads on top.
    if (this.waterPoints) {
      ctx.fillStyle = o.oceanColor;
      this.#drawPoints(this.waterPoints, { cx, cy, R, sinR, cosR, sinT, cosT, base: base * 0.62, shape, alphaLo: 0.15, alphaHi: 0.55 });
    }

    ctx.fillStyle = o.dotColor;
    this.#drawPoints(this.points, { cx, cy, R, sinR, cosR, sinT, cosT, base, shape, alphaLo: 0.25, alphaHi: 0.75 });

    // City markers ride the same transform, drawn on top at full strength.
    ctx.fillStyle = o.markerColor;
    for (const p of this.cities) {
      const x1 = p.x * cosR + p.z * sinR;
      const z1 = -p.x * sinR + p.z * cosR;
      const y2 = p.y * cosT - z1 * sinT;
      const z2 = p.y * sinT + z1 * cosT;
      if (z2 <= 0.01) continue;
      ctx.globalAlpha = 1;
      ctx.beginPath();
      ctx.arc(cx + x1 * R, cy - y2 * R, base * 0.85, 0, 6.2832);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }
}
