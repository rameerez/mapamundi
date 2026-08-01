// The renderer: one land mask in, one interactive <svg> out.
//
// Design decisions worth knowing before changing things:
// - SVG, not canvas: dots stay real elements, so hover/focus/click styling is
//   plain CSS, markers are tab-reachable, and consumers can restyle
//   everything with their own stylesheet. A few thousand nodes is fine;
//   past ~15k dots (cols ≳ 300) browsers start to chug — that's a canvas
//   renderer's job, planned behind the same options object.
// - Events are DELEGATED from the svg root (two listeners total), never
//   per-dot — per-node listeners at 5k dots would dwarf the render cost.
// - Every visual knob lands in CSS custom properties or attributes so the
//   ambient animations (CSS keyframes) stay off the main thread. The wave
//   delay is precomputed per-dot into --dw-delay.
// - The tilt is a perspective + rotateX on a WRAPPER around the svg — the
//   svg itself must stay untransformed or getBoundingClientRect-based
//   tooltip positioning (a consumer concern) breaks in surprising ways.

import { isLand } from "./mask.js";
import { project, cellCenter } from "./projection.js";
import { resolveCity } from "./cities.js";

export const DEFAULTS = {
  // Grid
  cols: 120,                  // dots across the full longitude span
  latRange: [-58, 84],        // cut Antarctica + arctic emptiness (mockup framing)
  // Dots
  dotShape: "circle",         // "circle" | "square" | "triangle" | an SVG path string (24×24 units)
  dotSize: 0.55,              // fraction of a grid cell the dot fills
  dotColor: "#d3dce6",
  dotHoverColor: "#94a8bd",
  dotHoverScale: 2.2,
  // City markers
  cities: [],                 // ["London", { name, lat, lon, color? }, …]
  markerShape: "circle",
  markerColor: "#2262fe",
  markerScale: 1.5,           // relative to a dot
  markerPulse: true,
  markerHoverScale: 2,
  // Plane transform (degrees; the classic hero skew)
  tilt: 0,                    // rotateX — 0 = flat, ~40 = the lying-down look
  rotate: 0,                  // rotateZ
  perspective: 1000,          // px, only meaningful with tilt
  // Ambient animation over the whole matrix
  ambient: "none",            // "none" | "wave"
  ambientDuration: 6,         // seconds per wave cycle
  // Interaction
  cursor: "default",          // CSS cursor over land dots
  markerCursor: "pointer",
  interactive: true,          // false = pure decoration (no listeners, no hover)
  // Callbacks — every handler also fires as a DOM CustomEvent on the
  // container ("dotted-world:cityclick" etc.) so framework users can
  // addEventListener instead of passing functions.
  onDotClick: null,           // ({ lat, lon, col, row, element })
  onDotEnter: null,
  onCityClick: null,          // ({ name, lat, lon, element })
  onCityEnter: null
};

const SVG_NS = "http://www.w3.org/2000/svg";
const CELL = 10; // internal SVG units per grid cell — arbitrary, never exposed

  // Snap a lat/lon to the nearest LAND dot in the grid, searching outward a
  // few rings — coastal cities often sit in a sea cell at coarse resolutions
  // (harbors do that), and a marker floating just off the coast looks broken.
  // Pure function (exported for tests and for consumers doing their own
  // marker math); the class method delegates here.
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

export class DottedWorld {
  // @param container [HTMLElement] emptied and rendered into; sizing is the
  //   consumer's (the svg scales to the container via viewBox).
  // @param options   [Object] see DEFAULTS.
  constructor(container, options = {}) {
    this.container = container;
    this.options = { ...DEFAULTS, ...options };
    this.render();
  }

  // Re-render with changed options (cheap enough to call from a knob UI —
  // full rebuild, no diffing; at hero resolutions that's single-digit ms).
  update(options = {}) {
    this.options = { ...this.options, ...options };
    this.render();
  }

  destroy() {
    this.container.replaceChildren();
  }

  render() {
    const o = this.options;
    const rows = Math.round((o.cols / 360) * (o.latRange[1] - o.latRange[0]));
    const grid = { cols: o.cols, rows, latRange: o.latRange };
    const width = o.cols * CELL;
    const height = rows * CELL;

    const svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
    svg.setAttribute("class", "dw-svg");
    svg.setAttribute("role", "img");
    svg.setAttribute("aria-label", this.#ariaLabel());

    svg.appendChild(this.#defs(o));
    svg.appendChild(this.#dots(grid, o));
    svg.appendChild(this.#markers(grid, o));

    const tiltWrap = document.createElement("div");
    tiltWrap.className = "dw-tilt";
    tiltWrap.appendChild(svg);

    this.container.replaceChildren(this.#style(o), tiltWrap);
    if (o.interactive) this.#bindEvents(svg, grid, o);
  }

  // -- geometry helpers --------------------------------------------------------

  snapToLand(lat, lon, grid) {
    return snapToLand(lat, lon, grid);
  }

  // -- render parts ------------------------------------------------------------

  #defs(o) {
    const defs = document.createElementNS(SVG_NS, "defs");
    defs.appendChild(this.#shapeDef("dw-dot-shape", o.dotShape, o.dotSize));
    defs.appendChild(this.#shapeDef("dw-marker-shape", o.markerShape, o.dotSize * o.markerScale));
    return defs;
  }

  // One reusable shape per role, referenced by <use> — swap the def, every
  // dot changes. Shapes are centered on (0,0) so transforms scale in place.
  #shapeDef(id, shape, size) {
    const r = (CELL * size) / 2;
    let el;
    switch (shape) {
      case "square":
        el = document.createElementNS(SVG_NS, "rect");
        el.setAttribute("x", -r); el.setAttribute("y", -r);
        el.setAttribute("width", r * 2); el.setAttribute("height", r * 2);
        el.setAttribute("rx", r * 0.25);
        break;
      case "triangle":
        el = document.createElementNS(SVG_NS, "path");
        el.setAttribute("d", `M0 ${-r} L${r} ${r} L${-r} ${r} Z`);
        break;
      case "circle":
        el = document.createElementNS(SVG_NS, "circle");
        el.setAttribute("r", r);
        break;
      default: {
        // Custom SVG path in a 24×24 box centered on origin (icon convention).
        el = document.createElementNS(SVG_NS, "path");
        el.setAttribute("d", shape);
        el.setAttribute("transform", `scale(${(r * 2) / 24})`);
      }
    }
    el.setAttribute("id", id);
    return el;
  }

  #dots(grid, o) {
    const g = document.createElementNS(SVG_NS, "g");
    g.setAttribute("class", "dw-dots");
    const maxDist = Math.hypot(grid.cols, grid.rows);

    for (let row = 0; row < grid.rows; row++) {
      for (let col = 0; col < grid.cols; col++) {
        const c = cellCenter(col, row, grid);
        if (!isLand(c.lat, c.lon)) continue;

        const use = document.createElementNS(SVG_NS, "use");
        use.setAttribute("href", "#dw-dot-shape");
        use.setAttribute("x", col * CELL + CELL / 2);
        use.setAttribute("y", row * CELL + CELL / 2);
        use.setAttribute("class", "dw-dot");
        use.dataset.col = col;
        use.dataset.row = row;
        if (o.ambient === "wave") {
          // Radial delay from the top-left → a wave sweeping the matrix.
          const delay = (Math.hypot(col, row) / maxDist) * o.ambientDuration;
          use.style.setProperty("--dw-delay", `${delay.toFixed(2)}s`);
        }
        g.appendChild(use);
      }
    }
    return g;
  }

  #markers(grid, o) {
    const g = document.createElementNS(SVG_NS, "g");
    g.setAttribute("class", "dw-markers");

    for (const entry of o.cities) {
      const city = resolveCity(entry);
      if (!city) {
        console.warn(`[dotted-world] unknown city: ${JSON.stringify(entry)} — not in the registry; pass { name, lat, lon } instead`);
        continue;
      }
      const { col, row } = this.snapToLand(city.lat, city.lon, grid);
      const use = document.createElementNS(SVG_NS, "use");
      use.setAttribute("href", "#dw-marker-shape");
      use.setAttribute("x", col * CELL + CELL / 2);
      use.setAttribute("y", row * CELL + CELL / 2);
      use.setAttribute("class", "dw-marker");
      if (city.color) use.style.fill = city.color;
      use.dataset.city = city.name;
      use.dataset.lat = city.lat;
      use.dataset.lon = city.lon;
      if (o.interactive) {
        use.setAttribute("tabindex", "0");
        use.setAttribute("role", "button");
        use.setAttribute("aria-label", city.name);
      }
      g.appendChild(use);
    }
    return g;
  }

  // Component-scoped stylesheet, all knobs as custom properties. Consumers
  // override any of it from outside CSS — these are defaults, not law.
  #style(o) {
    const style = document.createElement("style");
    style.textContent = `
      .dw-tilt { perspective: ${o.perspective}px; }
      .dw-tilt .dw-svg {
        width: 100%; height: auto; display: block;
        transform: rotateX(${o.tilt}deg) rotateZ(${o.rotate}deg);
        transform-style: preserve-3d;
      }
      .dw-dot {
        fill: ${o.dotColor};
        transform-origin: center;
        transform-box: fill-box;
        cursor: ${o.cursor};
        transition: transform .25s ease, fill .25s ease;
      }
      ${o.interactive ? `
      .dw-dot:hover {
        fill: ${o.dotHoverColor};
        transform: scale(${o.dotHoverScale});
        transition: none;
      }` : ""}
      .dw-marker {
        fill: ${o.markerColor};
        transform-origin: center;
        transform-box: fill-box;
        cursor: ${o.markerCursor};
        ${o.markerPulse ? "animation: dw-pulse 2.6s ease-in-out infinite;" : ""}
      }
      ${o.interactive ? `
      .dw-marker:hover, .dw-marker:focus-visible {
        animation: none;
        transform: scale(${o.markerHoverScale});
        outline: none;
      }` : ""}
      @keyframes dw-pulse {
        0%, 100% { transform: scale(1); }
        50% { transform: scale(1.45); }
      }
      ${o.ambient === "wave" ? `
      .dw-dot {
        animation: dw-wave ${o.ambientDuration}s ease-in-out infinite;
        animation-delay: var(--dw-delay, 0s);
      }
      @keyframes dw-wave {
        0%, 100% { opacity: 1; }
        50% { opacity: .45; }
      }` : ""}
      @media (prefers-reduced-motion: reduce) {
        .dw-dot, .dw-marker { animation: none !important; transition: none; }
      }
    `;
    return style;
  }

  // -- events ------------------------------------------------------------------

  #bindEvents(svg, grid, o) {
    const detailFor = (target) => {
      if (target.classList.contains("dw-marker")) {
        return { kind: "city", detail: {
          name: target.dataset.city,
          lat: Number(target.dataset.lat),
          lon: Number(target.dataset.lon),
          element: target
        } };
      }
      if (target.classList.contains("dw-dot")) {
        const col = Number(target.dataset.col), row = Number(target.dataset.row);
        const c = cellCenter(col, row, grid);
        return { kind: "dot", detail: { lat: c.lat, lon: c.lon, col, row, element: target } };
      }
      return null;
    };

    const dispatch = (kind, phase, detail) => {
      const cb = o[`on${kind === "city" ? "City" : "Dot"}${phase}`];
      if (cb) cb(detail);
      this.container.dispatchEvent(new CustomEvent(
        `dotted-world:${kind}${phase.toLowerCase()}`,
        { detail, bubbles: true }
      ));
    };

    svg.addEventListener("click", (e) => {
      const hit = detailFor(e.target);
      if (hit) dispatch(hit.kind, "Click", hit.detail);
    });
    // mouseover (not mouseenter) so one delegated listener covers every dot.
    svg.addEventListener("mouseover", (e) => {
      const hit = detailFor(e.target);
      if (hit) dispatch(hit.kind, "Enter", hit.detail);
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
