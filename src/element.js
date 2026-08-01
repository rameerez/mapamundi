// <dotted-world> — the zero-JS way in. Every renderer option that makes
// sense as markup is an attribute; change an attribute, the map re-renders.
//
//   <dotted-world cities="London, Lagos, Singapore" tilt="40"
//                 dot-shape="circle" marker-color="#2262fe"></dotted-world>
//
// Callbacks aren't attributes (functions don't serialize) — listen for the
// bubbling CustomEvents instead: dotted-world:cityclick, :cityenter,
// :dotclick, :dotenter. For full control, use the DottedWorld class.

import { DottedWorld } from "./renderer.js";

const ATTR_MAP = {
  // attribute      → [option, parser]
  "cols":             ["cols", Number],
  "lat-min":          ["latMin", Number],   // folded into latRange below
  "lat-max":          ["latMax", Number],
  "dot-shape":        ["dotShape", String],
  "dot-size":         ["dotSize", Number],
  "dot-color":        ["dotColor", String],
  "dot-hover-color":  ["dotHoverColor", String],
  "dot-hover-scale":  ["dotHoverScale", Number],
  "cities":           ["cities", (v) => v.split(",").map((s) => s.trim()).filter(Boolean)],
  "marker-shape":     ["markerShape", String],
  "marker-color":     ["markerColor", String],
  "marker-scale":     ["markerScale", Number],
  "marker-pulse":     ["markerPulse", (v) => v !== "false"],
  "tilt":             ["tilt", Number],
  "rotate":           ["rotate", Number],
  "perspective":      ["perspective", Number],
  "ambient":          ["ambient", String],
  "ambient-duration": ["ambientDuration", Number],
  "cursor":           ["cursor", String],
  "marker-cursor":    ["markerCursor", String],
  "interactive":      ["interactive", (v) => v !== "false"]
};

// Conditional class expression, not a declaration: `extends HTMLElement`
// evaluates at definition time, and this module must stay importable where
// no DOM exists (Node tests, SSR pipelines). There, the element export is
// null and register() no-ops — the data/geometry APIs still work.
export const DottedWorldElement = typeof HTMLElement === "undefined" ? null :
class DottedWorldElement extends HTMLElement {
  static observedAttributes = Object.keys(ATTR_MAP);

  connectedCallback() {
    // Light DOM on purpose: consumers restyle .dw-dot/.dw-marker with plain
    // CSS — a shadow root would wall that off for zero benefit here.
    this.map = new DottedWorld(this, this.#optionsFromAttributes());
  }

  disconnectedCallback() {
    this.map?.destroy();
    this.map = null;
  }

  attributeChangedCallback() {
    // Fires before connect for initial attributes; only re-render when live.
    this.map?.update(this.#optionsFromAttributes());
  }

  #optionsFromAttributes() {
    const options = {};
    for (const [attr, [key, parse]] of Object.entries(ATTR_MAP)) {
      const raw = this.getAttribute(attr);
      if (raw !== null) options[key] = parse(raw);
    }
    if (options.latMin !== undefined || options.latMax !== undefined) {
      options.latRange = [options.latMin ?? -58, options.latMax ?? 84];
      delete options.latMin;
      delete options.latMax;
    }
    return options;
  }
};

export function register(tag = "dotted-world") {
  if (!DottedWorldElement || customElements.get(tag)) return;
  customElements.define(tag, DottedWorldElement);
}
