// The renderer: one land mask in, one interactive <svg> out.
//
// Design decisions worth knowing before changing things:
//
// - SVG, not canvas: dots stay real elements — CSS hover, focusable markers,
//   restylable from outside. Sensible up to ~250 cols; beyond that a canvas
//   renderer (same options object) is the plan.
//
// - POSITIONING: every dot/marker is `<g transform="translate(x,y)"><use/></g>`
//   and ALL animation (hover, pulse, wave) transforms the INNER element,
//   whose shapes are centered on the local origin. Never scale an element
//   that carries x/y geometry: a <use x y> under `transform: scale()`
//   multiplies its own translate and the dot flies diagonally instead of
//   growing in place (transform-box: fill-box on <use> is not reliable
//   cross-browser). v1 shipped that bug; the wrapper pattern is the fix.
//
// - PERFORMANCE: the grid is built as ONE markup string and parsed with a
//   single innerHTML assignment — thousands of createElementNS calls were
//   the other half of v1's slider freeze. The first half was re-rendering
//   on every option twitch: update() now coalesces through rAF, so a
//   slider drag costs at most one rebuild per frame.
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
  cols: 120,                  // dots across the full longitude span (soft max 260)
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

const SVG_NS = "http://www.w3.org/2000/svg";
const CELL = 10;      // internal SVG units per grid cell — never exposed
const MAX_COLS = 260; // above this, SVG node count degrades interaction

export class WorldMap {
  // @param container [HTMLElement] emptied and rendered into; sizing is the
  //   consumer's (the svg scales to the container via viewBox).
  // @param options   [Object] see DEFAULTS.
  constructor(container, options = {}) {
    this.container = container;
    this.options = { ...DEFAULTS, ...options };
    this.render();
  }

  // Coalesced re-render: burst option changes (a slider drag, several
  // attribute writes) collapse into one rebuild per animation frame.
  update(options = {}) {
    this.options = { ...this.options, ...options };
    if (this._renderQueued) return;
    this._renderQueued = true;
    requestAnimationFrame(() => {
      this._renderQueued = false;
      if (this.container.isConnected) this.render();
    });
  }

  destroy() {
    this.container.replaceChildren();
  }

  render() {
    const o = this.options;
    const cols = Math.min(o.cols, MAX_COLS);
    if (o.cols > MAX_COLS) console.warn(`[worldmap] cols capped at ${MAX_COLS} (asked for ${o.cols}) — beyond that SVG interaction degrades; a canvas mode is on the roadmap`);
    const rows = Math.round((cols / 360) * (o.latRange[1] - o.latRange[0]));
    const grid = { cols, rows, latRange: o.latRange };

    const svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("viewBox", `0 0 ${cols * CELL} ${rows * CELL}`);
    svg.setAttribute("class", "wm-svg");
    svg.setAttribute("role", "img");
    svg.setAttribute("aria-label", this.#ariaLabel());
    // One parse for the whole scene — this is the fast path.
    svg.innerHTML = this.#defsMarkup(o) + this.#dotsMarkup(grid, o) + this.#markersMarkup(grid, o);

    const tiltWrap = document.createElement("div");
    tiltWrap.className = "wm-tilt";
    tiltWrap.appendChild(svg);

    this.container.replaceChildren(this.#styleEl(o), tiltWrap);
    if (o.interactive) this.#bindEvents(svg, grid, o);
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
        const rr = (r * 0.25).toFixed(2);
        return `<rect id="${id}" x="${-r}" y="${-r}" width="${r * 2}" height="${r * 2}" rx="${rr}"/>`;
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

  #dotsMarkup(grid, o) {
    const parts = [`<g class="wm-dots">`];
    const noiseScale = 0.09; // field frequency for ambient "noise" — tuned by eye

    for (let row = 0; row < grid.rows; row++) {
      for (let col = 0; col < grid.cols; col++) {
        const c = cellCenter(col, row, grid);
        if (!isLand(c.lat, c.lon)) continue;

        let delay = "";
        if (o.ambient === "wave") {
          // A diagonal front sweeping the matrix.
          const d = ((col + row) / (grid.cols + grid.rows)) * o.ambientDuration;
          delay = ` style="--wm-delay:${d.toFixed(2)}s"`;
        } else if (o.ambient === "noise") {
          // Perlin-shaped delay field: neighbors get similar phases, so the
          // shimmer forms organic patches instead of a mechanical sweep —
          // noise picks the WHEN, CSS does the animating (zero rAF cost).
          const n = (noise2(col * noiseScale, row * noiseScale) + 1) / 2;
          delay = ` style="--wm-delay:${(n * o.ambientDuration).toFixed(2)}s"`;
        }

        const x = col * CELL + CELL / 2;
        const y = row * CELL + CELL / 2;
        parts.push(
          `<g class="wm-pos" transform="translate(${x} ${y})" data-col="${col}" data-row="${row}">` +
          `<use class="wm-dot" href="#wm-dot-shape"${delay}/></g>`
        );
      }
    }
    parts.push("</g>");
    return parts.join("");
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
      const x = col * CELL + CELL / 2;
      const y = row * CELL + CELL / 2;
      const fill = city.color ? ` style="fill:${escapeAttr(city.color)}"` : "";
      const focus = o.interactive ? ` tabindex="0" role="button" aria-label="${escapeAttr(city.name)}"` : "";
      // The ping ring renders BEHIND the core and animates independently —
      // the core barely breathes, the ring expands and fades. Scaling one
      // element for "pulse" (v1) read as throbbing, not pinging.
      parts.push(
        `<g class="wm-pos" transform="translate(${x} ${y})" data-city="${escapeAttr(city.name)}" data-lat="${city.lat}" data-lon="${city.lon}"${focus}>` +
        (o.markerPulse ? `<use class="wm-marker-ring" href="#wm-marker-shape"${fill}/>` : "") +
        `<use class="wm-marker" href="#wm-marker-shape"${fill}/></g>`
      );
    }
    parts.push("</g>");
    return parts.join("");
  }

  // Component-scoped stylesheet — defaults, not law; outside CSS wins.
  #styleEl(o) {
    const style = document.createElement("style");
    style.textContent = `
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
        animation-delay: var(--wm-delay, 0s);
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
    return style;
  }

  // -- events ------------------------------------------------------------------

  #bindEvents(svg, grid, o) {
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
      const c = cellCenter(col, row, grid);
      return { kind: "dot", detail: { lat: c.lat, lon: c.lon, col, row, element: pos } };
    };

    const dispatch = (kind, phase, detail) => {
      const cb = o[`on${kind === "city" ? "City" : "Dot"}${phase}`];
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

function escapeAttr(value) {
  return String(value).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}
