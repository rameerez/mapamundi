// The renderer: one land mask in, one interactive <svg> out.
//
// Design decisions worth knowing before changing things:
//
// - SVG, not canvas: dots stay real elements — CSS hover, focusable markers,
//   restylable from outside. Sensible up to ~250 cols; beyond that a canvas
//   renderer (same options object) is the plan.
//
// - POSITIONING: every dot/marker is `<g transform="translate(x,y)"><use/></g>`
//   and ALL animation (hover, pulse, shimmer) transforms the INNER element,
//   whose shapes are centered on the local origin. Never scale an element
//   that carries x/y geometry: the scale multiplies the translate and dots
//   fly diagonally instead of growing in place (transform-box: fill-box is
//   not reliable on <use> cross-browser).
//
// - DIFFERENTIAL UPDATES — the crash lesson. Rebuilding the world per
//   option change froze and eventually OOM-killed tabs: each rebuild parses
//   thousands of nodes, recalcs style/layout for all of them, re-registers
//   every infinite animation, and discards ~1MB of DOM for GC — and a
//   slider drag asks for that 60×/second. So update() classifies changed
//   keys and does the CHEAPEST sufficient thing:
//     · style keys  (colors, tilt, cursors, ambient…) → rewrite ONE
//       persistent <style> element. No DOM touched.
//     · def keys    (dotShape/dotSize/markerShape/markerScale) → replace
//       two <defs> children; every <use> updates for free.
//     · marker keys (cities, markerPulse) → rebuild only the markers group.
//     · geometry    (cols, latRange, interactive) → full rebuild, but
//       leading+trailing debounced to ≥150ms spacing, with an LRU cache of
//       dot-markup strings per resolution (dragging back and forth replays
//       cached geometry instead of recomputing it).
//   Ambient phases (--wm-pw wave / --wm-pn noise) are baked into every dot
//   at build time and consumed via calc() in CSS, so ambient mode AND
//   duration are pure style patches too. Negative animation-delays start
//   each dot mid-cycle — no synchronized flash on load.
//
// - Events are DELEGATED from the svg root (three listeners total), never
//   per-dot. Payload coordinates come from data attributes on the wrapper.
//
// - The tilt lives on a WRAPPER div around the svg — the svg itself stays
//   untransformed so consumer getBoundingClientRect math keeps working.

import { isLand } from "./mask.js";
import { project, cellCenter } from "./projection.js";
import { resolveCity } from "./cities.js";
import { noise2 } from "./noise.js";

export const DEFAULTS = {
  // Grid
  cols: 120,                  // dots across the full longitude span (hard max 260)
  latRange: [-58, 84],        // cut Antarctica + arctic emptiness
  // Dots
  dotShape: "circle",         // "circle" | "square" | "triangle" | an SVG path string (24×24 units)
  dotSize: 0.55,              // fraction of a grid cell the dot fills
  dotColor: "#d3dce6",
  dotHoverColor: "#94a8bd",
  dotHoverScale: 2.6,
  // City markers
  cities: [],                 // ["London", { name, lat, lon, color? }, …]
  markerShape: "circle",
  markerColor: "#2262fe",
  markerScale: 1.5,           // relative to a dot
  markerPulse: true,          // radar ping: expanding fading ring behind the core
  markerHoverScale: 1.8,
  // Plane transform (degrees; the classic hero skew)
  tilt: 0,
  rotate: 0,
  perspective: 1000,
  // Ambient animation over the whole matrix
  ambient: "none",            // "none" | "wave" | "noise"
  ambientDuration: 6,         // seconds per cycle
  // Interaction
  cursor: "default",
  markerCursor: "pointer",
  interactive: true,
  // Callbacks (each also fires as a bubbling CustomEvent "worldmap:*")
  onDotClick: null,           // ({ lat, lon, col, row, element })
  onDotEnter: null,
  onCityClick: null,          // ({ name, lat, lon, element })
  onCityEnter: null
};

// Which update path each option needs. Callback keys appear in none of
// these on purpose: they're read at dispatch time, changing them costs
// nothing. Anything unlisted defaults to the safe full rebuild.
const STYLE_KEYS = new Set([
  "dotColor", "dotHoverColor", "dotHoverScale", "markerColor",
  "markerHoverScale", "tilt", "rotate", "perspective",
  "ambient", "ambientDuration", "cursor", "markerCursor"
]);
const DEF_KEYS = new Set(["dotShape", "dotSize", "markerShape", "markerScale"]);
const MARKER_KEYS = new Set(["cities", "markerPulse", "interactive"]);
const CALLBACK_KEYS = new Set(["onDotClick", "onDotEnter", "onCityClick", "onCityEnter"]);

const SVG_NS = "http://www.w3.org/2000/svg";
const CELL = 10;        // internal SVG units per grid cell — never exposed
const MAX_COLS = 260;   // above this, SVG node count degrades interaction
const REBUILD_MS = 150; // min spacing between geometry rebuilds
const NOISE_SCALE = 0.09; // ambient "noise" field frequency — tuned by eye

// Deep instrumentation, two layers:
// - performance.mark/measure spans ship ALWAYS (they cost ~nothing and make
//   any DevTools Performance trace self-documenting: look for "wm:*" blocks
//   in the flame chart).
// - console output is opt-in via `WorldMap.debug = true` (the perf harness
//   turns it on) so production consumers get a silent component.
function span(name, fn) {
  const m0 = `${name}:start`;
  performance.mark(m0);
  const out = fn();
  performance.measure(name, m0);
  const entries = performance.getEntriesByName(name);
  const ms = entries[entries.length - 1]?.duration ?? 0;
  performance.clearMarks(m0);
  return [out, ms];
}
function dbg(...args) {
  if (WorldMap.debug) console.debug("[worldmap]", ...args);
}

export class WorldMap {
  // Opt-in deep console output ("[worldmap] …"). The perf harness sets this.
  static debug = false;
  // @param container [HTMLElement] emptied and rendered into; sizing is the
  //   consumer's (the svg scales to the container via viewBox).
  // @param options   [Object] see DEFAULTS.
  constructor(container, options = {}) {
    this.container = container;
    this.options = { ...DEFAULTS, ...options };
    this._dotsCache = new Map(); // "cols|latMin|latMax" → dots markup string
    this.render();
  }

  // Differential update — see the header. Public contract: call with any
  // subset of options, as often as you like; the component picks the
  // cheapest sufficient refresh and never lets bursts stack up.
  update(options = {}) {
    const changed = Object.keys(options).filter((k) => !sameOption(options[k], this.options[k]));
    Object.assign(this.options, options);
    if (changed.length === 0) return;

    if (changed.every((k) => CALLBACK_KEYS.has(k))) {
      dbg("update: callbacks only", changed, "→ no work");
      return; // read at dispatch time
    }

    const styleOnly = changed.every((k) =>
      STYLE_KEYS.has(k) || DEF_KEYS.has(k) || MARKER_KEYS.has(k) || CALLBACK_KEYS.has(k));

    if (!styleOnly) {
      dbg("update:", changed, "→ GEOMETRY rebuild (debounced)");
      this.#scheduleRebuild();
      return;
    }
    const patches = [];
    if (changed.some((k) => DEF_KEYS.has(k))) {
      const [, defsMs] = span("wm:patch-defs", () => this.#patchDefs());
      patches.push(`defs ${defsMs.toFixed(1)}ms`);
    }
    if (changed.some((k) => MARKER_KEYS.has(k))) {
      const [, markersMs] = span("wm:patch-markers", () => this.#patchMarkers());
      patches.push(`markers ${markersMs.toFixed(1)}ms`);
    }
    const [, styleMs] = span("wm:patch-style", () => this.#patchStyle());
    patches.push(`style ${styleMs.toFixed(1)}ms`);
    dbg("update:", changed, "→", patches.join(" · "));
  }

  destroy() {
    clearTimeout(this._rebuildTimer);
    this.container.replaceChildren();
  }

  // -- the full build (geometry path only) -------------------------------------

  // Leading + trailing debounce: an isolated change renders immediately; a
  // drag renders at most every REBUILD_MS with a guaranteed final render at
  // the resting value. This is the backpressure valve — without it, drag
  // input outruns render capacity and the tab drowns.
  #scheduleRebuild() {
    // ADAPTIVE spacing (perf-harness lesson): a fixed 150ms floor against
    // 70-146ms renders is a ~50% main-thread duty cycle — the storm scenario
    // measured 49% blocked. Spacing self-tunes to ~8× the last measured
    // render cost (capped at 1.2s), so heavy resolutions rebuild ~1×/s
    // during a drag while cheap ones stay at the 150ms floor. Blocked time
    // lands near 12% on any machine, fast or slow.
    const spacing = Math.min(1200, Math.max(REBUILD_MS, (this._lastRenderMs ?? 0) * 8));
    const since = performance.now() - (this._lastRebuild ?? -Infinity);
    const wait = Math.max(0, spacing - since);
    dbg(`rebuild scheduled: ${wait === 0 ? "immediate (leading)" : `in ${wait.toFixed(0)}ms (trailing)`}`);
    clearTimeout(this._rebuildTimer);
    this._rebuildTimer = setTimeout(() => {
      if (this.container.isConnected) this.render();
    }, wait);
  }

  render() {
    this._lastRebuild = performance.now();
    const o = this.options;
    const cols = Math.min(o.cols, MAX_COLS);
    if (o.cols > MAX_COLS) console.warn(`[worldmap] cols capped at ${MAX_COLS} (asked for ${o.cols}) — beyond that SVG interaction degrades; a canvas mode is on the roadmap`);
    const rows = Math.round((cols / 360) * (o.latRange[1] - o.latRange[0]));
    this.grid = { cols, rows, latRange: o.latRange };

    // PERSISTENT scene (heap-growth lesson): svg, tilt wrapper, style
    // element and listeners are created ONCE and reused forever — a rebuild
    // swaps viewBox + innerHTML in place. v2 recreated all three per rebuild
    // and re-bound listeners each time; across a slider storm that churned
    // tens of MB of discarded containers on top of the node garbage.
    const renderT0 = performance.now();
    if (!this.svg) {
      this.svg = document.createElementNS(SVG_NS, "svg");
      this.svg.setAttribute("class", "wm-svg");
      this.svg.setAttribute("role", "img");
      this._tiltWrap = document.createElement("div");
      this._tiltWrap.className = "wm-tilt";
      this._tiltWrap.appendChild(this.svg);
      this.styleEl = document.createElement("style");
      this.container.replaceChildren(this.styleEl, this._tiltWrap);
      this.#bindEvents(this.svg); // once — handlers guard on options.interactive
    }
    const svg = this.svg;
    svg.setAttribute("viewBox", `0 0 ${cols * CELL} ${rows * CELL}`);
    svg.setAttribute("aria-label", this.#ariaLabel());
    // One parse for the whole scene — the fast path for full builds.
    const [markup, buildMs] = span("wm:build-markup", () =>
      this.#defsMarkup(o) + this.#dotsMarkup(this.grid) + this.#markersMarkup(this.grid, o));
    const [, parseMs] = span("wm:parse-innerHTML", () => { svg.innerHTML = markup; });
    this.styleEl.textContent = this.#css(o);
    this._lastRenderMs = performance.now() - renderT0;
    dbg(`render: cols=${cols} rows=${rows} · build ${buildMs.toFixed(1)}ms · parse ${parseMs.toFixed(1)}ms · total ${this._lastRenderMs.toFixed(1)}ms · ${svg.querySelectorAll("*").length} nodes`);
  }

  // -- cheap patches -----------------------------------------------------------

  #patchStyle() {
    this.styleEl.textContent = this.#css(this.options);
  }

  #patchDefs() {
    const defs = this.svg?.querySelector("defs");
    if (defs) defs.innerHTML =
      this.#shapeMarkup("wm-dot-shape", this.options.dotShape, this.options.dotSize) +
      this.#shapeMarkup("wm-marker-shape", this.options.markerShape, this.options.dotSize * this.options.markerScale);
  }

  #patchMarkers() {
    const group = this.svg?.querySelector(".wm-markers");
    if (!group) return;
    group.remove();
    this.svg.insertAdjacentHTML("beforeend", this.#markersMarkup(this.grid, this.options));
    this.svg.setAttribute("aria-label", this.#ariaLabel());
  }

  // -- markup builders ---------------------------------------------------------

  #defsMarkup(o) {
    return `<defs>${
      this.#shapeMarkup("wm-dot-shape", o.dotShape, o.dotSize)}${
      this.#shapeMarkup("wm-marker-shape", o.markerShape, o.dotSize * o.markerScale)
    }</defs>`;
  }

  // One reusable shape per role, centered on the local origin so inner-
  // element transforms scale in place.
  #shapeMarkup(id, shape, size) {
    const r = (CELL * size) / 2;
    switch (shape) {
      case "square": {
        return `<rect id="${id}" x="${-r}" y="${-r}" width="${r * 2}" height="${r * 2}" rx="${(r * 0.25).toFixed(2)}"/>`;
      }
      case "triangle":
        return `<path id="${id}" d="M0 ${-r} L${r} ${r} L${-r} ${r} Z"/>`;
      case "circle":
        return `<circle id="${id}" r="${r}"/>`;
      default:
        // Custom SVG path, 24×24 box centered on origin (icon convention).
        return `<path id="${id}" d="${escapeAttr(shape)}" transform="scale(${((r * 2) / 24).toFixed(4)})"/>`;
    }
  }

  // Dot geometry depends ONLY on (cols, latRange) — colors, shapes and
  // ambient all live elsewhere — so the markup string caches perfectly per
  // resolution. Both ambient phases ship on every dot (~30 bytes each):
  // that's what makes ambient a style-only knob.
  #dotsMarkup(grid) {
    const key = `${grid.cols}|${grid.latRange[0]}|${grid.latRange[1]}`;
    const cached = this._dotsCache.get(key);
    if (cached) { dbg(`dots cache HIT ${key}`); return cached; }
    dbg(`dots cache MISS ${key} — computing`);

    const parts = [`<g class="wm-dots">`];
    for (let row = 0; row < grid.rows; row++) {
      for (let col = 0; col < grid.cols; col++) {
        const c = cellCenter(col, row, grid);
        if (!isLand(c.lat, c.lon)) continue;

        const pw = ((col + row) / (grid.cols + grid.rows)).toFixed(3);
        const pn = (((noise2(col * NOISE_SCALE, row * NOISE_SCALE) + 1) / 2)).toFixed(3);
        parts.push(
          `<g class="wm-pos" transform="translate(${col * CELL + CELL / 2} ${row * CELL + CELL / 2})" data-col="${col}" data-row="${row}">` +
          `<use class="wm-dot" href="#wm-dot-shape" style="--wm-pw:${pw};--wm-pn:${pn}"/></g>`
        );
      }
    }
    parts.push("</g>");
    const markup = parts.join("");

    this._dotsCache.set(key, markup);
    // Cap by BYTES, not entries: a resolution sweep can visit dozens of
    // grids and high-res strings run ~1MB each — an entry-count cap
    // measured as tens of MB of retained heap in the perf harness.
    this._cacheBytes = (this._cacheBytes ?? 0) + markup.length;
    while (this._cacheBytes > 4_000_000 && this._dotsCache.size > 1) {
      const oldest = this._dotsCache.keys().next().value;
      this._cacheBytes -= this._dotsCache.get(oldest).length;
      this._dotsCache.delete(oldest);
    }
    return markup;
  }

  #markersMarkup(grid, o) {
    const parts = [`<g class="wm-markers">`];
    for (const entry of o.cities) {
      const city = resolveCity(entry);
      if (!city) {
        console.warn(`[worldmap] unknown city: ${JSON.stringify(entry)} — not in the registry; pass { name, lat, lon } instead`);
        continue;
      }
      const { col, row } = snapToLand(city.lat, city.lon, grid);
      const fill = city.color ? ` style="fill:${escapeAttr(city.color)}"` : "";
      const focus = o.interactive ? ` tabindex="0" role="button" aria-label="${escapeAttr(city.name)}"` : "";
      // The ping ring renders BEHIND the core and animates independently —
      // the core barely breathes, the ring expands and fades. Scaling one
      // element for "pulse" read as throbbing, not pinging.
      parts.push(
        `<g class="wm-pos" transform="translate(${col * CELL + CELL / 2} ${row * CELL + CELL / 2})" data-city="${escapeAttr(city.name)}" data-lat="${city.lat}" data-lon="${city.lon}"${focus}>` +
        (o.markerPulse ? `<use class="wm-marker-ring" href="#wm-marker-shape"${fill}/>` : "") +
        `<use class="wm-marker" href="#wm-marker-shape"${fill}/></g>`
      );
    }
    parts.push("</g>");
    return parts.join("");
  }

  // The component stylesheet — defaults, not law; outside CSS wins.
  #css(o) {
    return `
      .wm-tilt { perspective: ${o.perspective}px; }
      .wm-tilt .wm-svg {
        width: 100%; height: auto; display: block;
        transform: rotateX(${o.tilt}deg) rotateZ(${o.rotate}deg);
        transform-style: preserve-3d;
      }
      .wm-dot {
        fill: ${o.dotColor};
        cursor: ${o.cursor};
        /* The hover wake: growing is INSTANT (transition:none below), the
           shrink-back runs slow and delayed — sweeping the cursor leaves a
           trail of settling dots. */
        transition: transform .3s ease .2s, fill .3s ease .2s;
      }
      ${o.interactive ? `
      .wm-pos:hover > .wm-dot {
        fill: ${o.dotHoverColor};
        transform: scale(${o.dotHoverScale});
        transition: none;
      }` : ""}
      .wm-marker {
        fill: ${o.markerColor};
        cursor: ${o.markerCursor};
        ${o.markerPulse ? "animation: wm-breathe 2.8s ease-in-out infinite;" : ""}
        transition: transform .2s ease;
      }
      .wm-marker-ring {
        fill: ${o.markerColor};
        pointer-events: none;
        animation: wm-ping 2.8s cubic-bezier(0, 0, 0.2, 1) infinite;
      }
      ${o.interactive ? `
      .wm-pos:hover > .wm-marker, .wm-pos:focus-visible > .wm-marker {
        animation: none;
        transform: scale(${o.markerHoverScale});
      }
      .wm-pos:hover > .wm-marker-ring, .wm-pos:focus-visible > .wm-marker-ring {
        animation: none;
        opacity: 0;
      }
      .wm-markers .wm-pos { outline: none; }` : ""}
      @keyframes wm-ping {
        0%   { transform: scale(1);    opacity: .55; }
        70%  { transform: scale(2.75); opacity: 0; }
        100% { transform: scale(2.75); opacity: 0; }
      }
      @keyframes wm-breathe {
        0%, 100% { transform: scale(1); }
        50%      { transform: scale(1.12); }
      }
      ${o.ambient !== "none" ? `
      .wm-dots .wm-dot {
        animation: wm-shimmer ${o.ambientDuration}s ease-in-out infinite;
        /* Negative delay = start mid-cycle: no synchronized flash. The
           phase is baked per-dot; which phase field applies is a pure
           style decision — that's why ambient never rebuilds geometry. */
        animation-delay: calc(${o.ambient === "wave" ? "var(--wm-pw)" : "var(--wm-pn)"} * ${o.ambientDuration}s * -1);
      }
      @keyframes wm-shimmer {
        0%, 100% { opacity: 1; }
        50%      { opacity: .4; }
      }` : ""}
      @media (prefers-reduced-motion: reduce) {
        .wm-dot, .wm-marker, .wm-marker-ring { animation: none !important; transition: none !important; }
        .wm-marker-ring { opacity: 0; }
      }
    `;
  }

  // -- events ------------------------------------------------------------------

  #bindEvents(svg) {
    const detailFor = (target) => {
      const pos = target.closest?.(".wm-pos");
      if (!pos) return null;
      if (pos.dataset.city !== undefined) {
        return { kind: "city", detail: {
          name: pos.dataset.city,
          lat: Number(pos.dataset.lat),
          lon: Number(pos.dataset.lon),
          element: pos
        } };
      }
      const col = Number(pos.dataset.col), row = Number(pos.dataset.row);
      const c = cellCenter(col, row, this.grid);
      return { kind: "dot", detail: { lat: c.lat, lon: c.lon, col, row, element: pos } };
    };

    const dispatch = (kind, phase, detail) => {
      if (!this.options.interactive) return;
      const cb = this.options[`on${kind === "city" ? "City" : "Dot"}${phase}`];
      if (cb) cb(detail);
      this.container.dispatchEvent(new CustomEvent(
        `worldmap:${kind}${phase.toLowerCase()}`,
        { detail, bubbles: true }
      ));
    };

    svg.addEventListener("click", (e) => {
      const hit = detailFor(e.target);
      if (hit) dispatch(hit.kind, "Click", hit.detail);
    });
    svg.addEventListener("mouseover", (e) => {
      // mouseover + a same-group guard ≈ mouseenter with one listener.
      const hit = detailFor(e.target);
      if (!hit) return;
      if (e.relatedTarget && hit.detail.element.contains(e.relatedTarget)) return;
      dispatch(hit.kind, "Enter", hit.detail);
    });
    svg.addEventListener("keydown", (e) => {
      if (e.key !== "Enter" && e.key !== " ") return;
      const hit = detailFor(e.target);
      if (hit?.kind === "city") { e.preventDefault(); dispatch("city", "Click", hit.detail); }
    });
  }

  #ariaLabel() {
    const names = this.options.cities.map((c) => resolveCity(c)?.name).filter(Boolean);
    return names.length
      ? `Dotted world map highlighting ${names.join(", ")}`
      : "Dotted world map";
  }
}

// Snap a lat/lon to the nearest LAND dot in the grid, searching outward a
// few rings — coastal cities often sit in a sea cell at coarse resolutions
// (harbors do that), and a marker floating just off the coast looks broken.
// Pure function (exported for tests and consumers doing their own math).
export function snapToLand(lat, lon, grid) {
  const { x, y } = project(lat, lon, grid);
  const col0 = Math.min(grid.cols - 1, Math.max(0, Math.floor(x)));
  const row0 = Math.min(grid.rows - 1, Math.max(0, Math.floor(y)));

  for (let radius = 0; radius <= 3; radius++) {
    let best = null;
    for (let dr = -radius; dr <= radius; dr++) {
      for (let dc = -radius; dc <= radius; dc++) {
        if (Math.max(Math.abs(dr), Math.abs(dc)) !== radius) continue; // ring only
        const col = col0 + dc, row = row0 + dr;
        if (col < 0 || col >= grid.cols || row < 0 || row >= grid.rows) continue;
        const c = cellCenter(col, row, grid);
        if (!isLand(c.lat, c.lon)) continue;
        const d = (col - x) ** 2 + (row - y) ** 2;
        if (!best || d < best.d) best = { col, row, d };
      }
    }
    if (best) return best;
  }
  // Deep-ocean coordinates render where they are — honest, and it makes
  // custom "cities" like ships or islands-below-resolution still work.
  return { col: col0, row: row0 };
}

// Option equality for the differential update: cities and latRange are the
// only structural values; everything else compares by identity.
function sameOption(a, b) {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) return JSON.stringify(a) === JSON.stringify(b);
  return false;
}

function escapeAttr(value) {
  return String(value).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}
