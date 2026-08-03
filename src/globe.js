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
import { noise2 } from "./noise.js";
import { hoverShade } from "./color.js";

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

// Per-point animation phase + amplitude, aligned index-for-index with
// buildGlobePoints (same loop, same skip rule). Phase picks WHEN a dot
// moves in the cycle, amp how far — the exact fields the flat renderer
// bakes into its dot markup, so the six modes read the same on a sphere.
export function buildGlobePhases(cols, latRange, mode, water = false) {
  const rows = Math.round((cols / 360) * (latRange[1] - latRange[0]));
  const grid = { cols, rows, latRange };
  const out = [];
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const c = cellCenter(col, row, grid);
      if (isLand(c.lat, c.lon) === water) continue;
      let p;
      switch (mode) {
        case "noise":   p = (noise2(col * 0.22, row * 0.22) + 1) / 2; break;
        case "ripple":  p = Math.hypot(col - cols / 2, row - rows / 2) / Math.hypot(cols / 2, rows / 2); break;
        case "sweep":   p = col / cols; break;
        case "sparkle": p = (noise2(col * 3.7 + 9, row * 3.7 + 9) + 1) / 2; break;
        default:        p = (col + row) / (cols + rows); // wave
      }
      out.push(p, 0.55 + 0.45 * ((noise2(col * 0.31 + 47, row * 0.31 + 47) + 1) / 2));
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
    // focus: start the spin facing a point — the rotation that brings
    // the focus longitude to the front (z-max at rot = -λ, since
    // latLonToXYZ puts λ=0 facing the viewer at angle 0).
    this.angle = options.focus ? ((-options.focus.lon % 360) + 360) % 360 : 0;
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

    this.#bindPointer();
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
    const c = this.canvas;
    c.removeEventListener("pointerdown", this._onDown);
    c.removeEventListener("pointermove", this._onMove);
    c.removeEventListener("pointerup", this._onUp);
    c.removeEventListener("pointercancel", this._onUp);
    c.removeEventListener("pointerleave", this._onLeave);
    c.removeEventListener("click", this._onClick);
    c.remove();
  }

  // ── pointer layer: hover/click events + drag-to-spin ─────────────────────
  // Mirrors the flat renderer's contract exactly: onDotClick/onDotEnter/
  // onCityClick/onCityEnter callbacks + bubbling worldmap:* CustomEvents,
  // gated by `interactive`. On top of that, the globe is grabbable: drag
  // spins it directly, a flick carries momentum, and the spin relaxes back
  // to rotateSpeed on an exponential (~0.8s) — seamless handoff, no snap.

  // One marker/highlight footprint, honoring the shape options — the canvas
  // twin of the flat renderer's <use href="#wm-marker-shape">.
  #drawShape(sx, sy, size, shape) {
    const ctx = this.ctx;
    if (shape === "square") {
      ctx.fillRect(sx - size / 2, sy - size / 2, size, size);
    } else if (shape === "triangle") {
      ctx.beginPath();
      ctx.moveTo(sx, sy - size / 2);
      ctx.lineTo(sx + size / 2, sy + size / 2);
      ctx.lineTo(sx - size / 2, sy + size / 2);
      ctx.fill();
    } else if (shape === "pin") {
      // The map-pin (Google-marker silhouette): round head, tapered
      // tail, ANCHORED AT THE TIP — (sx, sy) is the place, the head
      // floats above it. A punched hole keeps it reading as a pin at
      // small sizes.
      const r = size * 0.62;
      const hy = sy - r * 1.9;      // head center
      ctx.beginPath();
      ctx.arc(sx, hy, r, Math.PI * 0.85, Math.PI * 0.15);
      ctx.quadraticCurveTo(sx + r * 0.55, hy + r * 1.1, sx, sy);
      ctx.quadraticCurveTo(sx - r * 0.55, hy + r * 1.1, sx - r * Math.cos(Math.PI * 0.15), hy + r * Math.sin(Math.PI * 0.15));
      ctx.closePath();
      ctx.fill();
      const punch = ctx.globalCompositeOperation;
      ctx.globalCompositeOperation = "destination-out";
      ctx.beginPath();
      ctx.arc(sx, hy, r * 0.42, 0, 6.2832);
      ctx.fill();
      ctx.globalCompositeOperation = punch;
    } else { // circle + custom-path fallback
      ctx.beginPath();
      ctx.arc(sx, sy, size / 2, 0, 6.2832);
      ctx.fill();
    }
  }

  #bindPointer() {
    this._drag = { active: false, moved: 0, lastX: 0, lastT: 0, v: 0 };
    this._hover = null;
    const c = this.canvas;
    this._onDown = (e) => {
      if (this.o.interactive === false) return;
      this._drag.active = true;
      this._drag.moved = 0;
      this._drag.lastX = e.clientX;
      this._drag.lastT = e.timeStamp;
      this._drag.v = 0;
      c.setPointerCapture?.(e.pointerId);
      c.style.cursor = "grabbing";
    };
    this._onMove = (e) => {
      if (this.o.interactive === false) return;
      if (this._drag.active) {
        const dx = e.clientX - this._drag.lastX;
        const dt = Math.max(1, e.timeStamp - this._drag.lastT);
        // Surface-true feel: dragging the equator by R px turns ~57°.
        const dDeg = (dx * 180) / (Math.PI * this.side * 0.40);
        this.angle = (this.angle + dDeg + 360) % 360;
        this._drag.v = 0.75 * this._drag.v + 0.25 * (dDeg / (dt / 1000));
        this._drag.moved += Math.abs(dx);
        this._drag.lastX = e.clientX;
        this._drag.lastT = e.timeStamp;
        if (this._static) this._draw();
      } else {
        this.#hover(e);
      }
    };
    this._onUp = (e) => {
      if (!this._drag.active) return;
      this._drag.active = false;
      c.releasePointerCapture?.(e.pointerId);
      c.style.cursor = "grab";
      // The flick: released velocity becomes the spin, clamped sane; the
      // loop's exponential relaxation walks it back to rotateSpeed.
      this._omega = Math.max(-360, Math.min(360, this._drag.v));
      if (this._static) this._omega = this.o.rotateSpeed; // no momentum without motion
    };
    this._onLeave = () => this.#clearHover();
    this._onClick = (e) => {
      if (this.o.interactive === false) return;
      if (this._drag.moved > 4) return; // that was a drag, not a click
      const hit = this.#hitTest(e);
      if (hit) this.#dispatch(hit.kind, "Click", hit.detail);
    };
    c.addEventListener("pointerdown", this._onDown);
    c.addEventListener("pointermove", this._onMove);
    c.addEventListener("pointerup", this._onUp);
    c.addEventListener("pointercancel", this._onUp);
    c.addEventListener("pointerleave", this._onLeave);
    c.addEventListener("click", this._onClick);
  }

  #hover(e) {
    const hit = this.#hitTest(e);
    const key = hit ? `${hit.kind}:${hit.detail.name ?? `${hit.detail.col},${hit.detail.row}`}` : null;
    if (key === this._hoverKey) return;
    this._hoverKey = key;
    this._hover = hit;
    this.canvas.style.cursor = hit
      ? (hit.kind === "city" ? this.o.markerCursor : this.o.cursor)
      : "grab";
    if (hit) this.#dispatch(hit.kind, "Enter", hit.detail);
    if (this._static) this._draw();
  }

  #clearHover() {
    if (!this._hover) return;
    this._hover = null;
    this._hoverKey = null;
    this.canvas.style.cursor = this.o.interactive === false ? "" : "grab";
    if (this._static) this._draw();
  }

  // Screen point → sphere surface → lat/lon → grid cell (or city, checked
  // first in screen space since markers draw on top).
  #hitTest(e) {
    const rect = this.canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const side = this.side;
    const cx = side / 2, cy = side / 2, R = side * 0.40;
    const rot = (this.angle * Math.PI) / 180;
    const tilt = ((this.o.tilt || 0) * Math.PI) / 180;
    const sinR = Math.sin(rot), cosR = Math.cos(rot);
    const sinT = Math.sin(tilt), cosT = Math.cos(tilt);
    const base = Math.max(0.75, (4 * R) / (this.o.cols ?? 170)) * this.o.dotSize * 1.6;

    for (const city of this.cityData) {
      const x1 = city.p.x * cosR + city.p.z * sinR;
      const z1 = -city.p.x * sinR + city.p.z * cosR;
      const y2 = city.p.y * cosT - z1 * sinT;
      const z2 = city.p.y * sinT + z1 * cosT;
      if (z2 <= 0.01) continue;
      if (Math.hypot(mx - (cx + x1 * R), my - (cy - y2 * R)) <= Math.max(10, base * this.o.markerScale * 0.9)) {
        return { kind: "city", detail: { name: city.name, lat: city.lat, lon: city.lon, element: this.canvas } };
      }
    }

    const X = (mx - cx) / R;
    const Y = -(my - cy) / R;
    const rr = X * X + Y * Y;
    if (rr > 1) return null;
    const Z = Math.sqrt(1 - rr);
    // Inverse of the draw transform: un-tilt, then un-spin.
    const y = Y * cosT + Z * sinT;
    const z1 = -Y * sinT + Z * cosT;
    const x = X * cosR - z1 * sinR;
    const z = X * sinR + z1 * cosR;
    const lat = (Math.asin(y) * 180) / Math.PI;
    const lon = (Math.atan2(x, z) * 180) / Math.PI;

    const [latMin, latMax] = this.o.latRange;
    if (lat < latMin || lat > latMax) return null;
    const cols = this.o.cols ?? 170; // auto: globes want density — foreshortening thins the limb
    const rows = Math.round((cols / 360) * (latMax - latMin));
    const col = Math.min(cols - 1, Math.max(0, Math.floor(((lon + 180) / 360) * cols)));
    const row = Math.min(rows - 1, Math.max(0, Math.floor(((latMax - lat) / (latMax - latMin)) * rows)));
    const c = cellCenter(col, row, { cols, rows, latRange: this.o.latRange });
    if (!isLand(c.lat, c.lon)) return null;
    return { kind: "dot", detail: { lat: c.lat, lon: c.lon, col, row, element: this.canvas } };
  }

  #dispatch(kind, phase, detail) {
    if (this.o.interactive === false) return;
    const cb = this.o[`on${kind === "city" ? "City" : "Dot"}${phase}`];
    if (cb) cb(detail);
    this.container.dispatchEvent(new CustomEvent(
      `worldmap:${kind}${phase.toLowerCase()}`,
      { detail, bubbles: true }
    ));
  }

  _rebuildData() {
    const cols = this.o.cols ?? 170; // auto: globes want density — foreshortening thins the limb
    this.points = buildGlobePoints(cols, this.o.latRange);
    this.waterPoints = this.o.oceanColor && this.o.oceanColor !== "none"
      ? buildGlobePoints(cols, this.o.latRange, true)
      : null;
    this.phases = this.o.animation && this.o.animation !== "none"
      ? buildGlobePhases(cols, this.o.latRange, this.o.animation)
      : null;
    const resolved = [ ...(this.o.cities || []), ...(this.o.markers || []) ]
      .map((c) => (typeof c === "string" ? resolveCity(c) : resolveCity(c)))
      .filter(Boolean);
    this.cityData = resolved.map((c) => ({ name: c.name, lat: c.lat, lon: c.lon, p: latLonToXYZ(c.lat, c.lon) }));
    this.canvas.style.cursor = this.o.interactive === false ? "" : "grab";
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
      this._time = (this._time || 0) + dt / 1000;
      if (this._drag?.active) {
        // The pointer owns the angle while dragging.
      } else {
        if (this._omega == null) this._omega = this.o.rotateSpeed;
        // Momentum relaxes back to the base spin — exponential, ~0.8s to
        // settle, so the handoff from a flick to auto-rotation is seamless.
        this._omega += (this.o.rotateSpeed - this._omega) * (1 - Math.exp(-dt / 800));
        this.angle = (this.angle + (this._omega * dt) / 1000 + 360) % 360;
      }
      this._draw();
      this._loop();
    });
  }

  // One transformed, culled, depth-faded pass over a point buffer — land
  // and water share it; only color, size and alpha band differ.
  #drawPoints(pts, { cx, cy, R, sinR, cosR, sinT, cosT, base, shape, alphaLo, alphaHi, anim }) {
    const ctx = this.ctx;
    for (let i = 0; i < pts.length; i += 3) {
      // Spin around the polar axis, then lean by the axial tilt.
      const x1 = pts[i] * cosR + pts[i + 2] * sinR;
      const z1 = -pts[i] * sinR + pts[i + 2] * cosR;
      const y2 = pts[i + 1] * cosT - z1 * sinT;
      const z2 = pts[i + 1] * sinT + z1 * cosT;
      if (z2 <= 0.01) continue; // back hemisphere

      let lift = 0, sizeMul = 1;
      if (anim) {
        const j = (i / 3) * 2;
        const d = (anim.cycle - anim.phases[j] + 1) % 1;
        if (d < anim.w) {
          const bump = Math.sin(Math.PI * (d / anim.w)) * anim.phases[j + 1];
          if (anim.mode === "sparkle") sizeMul = 1 + 0.45 * bump;
          else lift = (anim.heightPx * bump) / R;
        }
      }
      const k = 1 + lift;
      const sx = cx + x1 * R * k;
      const sy = cy - y2 * R * k;
      const s = base * (0.45 + 0.55 * z2) * sizeMul; // foreshortening at the limb
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
    const base = Math.max(0.75, (4 * R) / (o.cols ?? 170)) * o.dotSize * 1.6;
    const shape = o.dotShape === "circle" || o.dotShape === "triangle" ? o.dotShape : "square";

    // Water first — smaller, dimmer, same transform — so land reads on top.
    // Water never animates: the ocean is ground, the land is figure.
    if (this.waterPoints) {
      ctx.fillStyle = o.oceanColor;
      this.#drawPoints(this.waterPoints, { cx, cy, R, sinR, cosR, sinT, cosT, base: base * 0.62, shape, alphaLo: 0.15, alphaHi: 0.55 });
    }

    // The six animation modes on a sphere: the phase/amp fields decide when
    // and how far each dot lifts RADIALLY off the surface (sparkle scales
    // size instead) — the canvas twin of the flat renderer's translateY.
    const anim = !this._static && o.animation && o.animation !== "none" && this.phases ? {
      mode: o.animation,
      cycle: ((this._time || 0) / o.animationPeriod) % 1,
      w: Math.min(0.9, Math.max(0.02, o.animationWidth *
        ({ ripple: 0.8, sweep: 0.5, sparkle: 0.55 }[o.animation] ?? 1))),
      heightPx: o.animationHeight * (4 * R) / (o.cols ?? 170),
      phases: this.phases
    } : null;

    ctx.fillStyle = o.dotColor;
    this.#drawPoints(this.points, { cx, cy, R, sinR, cosR, sinT, cosT, base, shape, alphaLo: 0.25, alphaHi: 0.75, anim });

    // Hovered dot re-draws bigger in the hover color (cheap overdraw).
    if (this._hover?.kind === "dot") {
      const hp = latLonToXYZ(this._hover.detail.lat, this._hover.detail.lon);
      const x1 = hp.x * cosR + hp.z * sinR;
      const z1 = -hp.x * sinR + hp.z * cosR;
      const y2 = hp.y * cosT - z1 * sinT;
      const z2 = hp.y * sinT + z1 * cosT;
      if (z2 > 0.01) {
        ctx.fillStyle = o.dotHoverColor ?? hoverShade(o.dotColor);
        ctx.globalAlpha = 1;
        const s = base * (0.45 + 0.55 * z2) * o.dotHoverScale;
        this.#drawShape(cx + x1 * R, cy - y2 * R, s, shape);
      }
    }

    // City markers ride the same transform, drawn on top at full strength;
    // the hovered one swells by markerHoverScale.
    ctx.fillStyle = o.markerColor;
    for (const city of this.cityData) {
      const x1 = city.p.x * cosR + city.p.z * sinR;
      const z1 = -city.p.x * sinR + city.p.z * cosR;
      const y2 = city.p.y * cosT - z1 * sinT;
      const z2 = city.p.y * sinT + z1 * cosT;
      if (z2 <= 0.01) continue;
      const hovered = this._hover?.kind === "city" && this._hover.detail.name === city.name;
      ctx.globalAlpha = 1;
      const ms = base * o.markerScale * 0.6 * (hovered ? o.markerHoverScale : 1);
      const mshape = ["circle", "square", "triangle", "pin"].includes(o.markerShape) ? o.markerShape : "circle";
      this.#drawShape(cx + x1 * R, cy - y2 * R, ms * 2, mshape);
    }
    ctx.globalAlpha = 1;
  }
}
