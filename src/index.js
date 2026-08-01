// dotted-world — a dotted world map as a zero-dependency web component.
//
//   import "dotted-world";            // side effect: registers <dotted-world>
//   <dotted-world cities="London, Lagos"></dotted-world>
//
//   // or the programmatic API:
//   import { DottedWorld } from "dotted-world";
//   new DottedWorld(el, { cities: ["Tokyo"], tilt: 40, ambient: "wave" });

export { DottedWorld, DEFAULTS, snapToLand } from "./renderer.js";
export { DottedWorldElement, register } from "./element.js";
export { CITIES, resolveCity } from "./cities.js";
export { isLand, MASK_W, MASK_H } from "./mask.js";
export { project, cellCenter } from "./projection.js";

import { register } from "./element.js";
// Auto-register when a DOM exists (browser); harmless no-op under Node.
if (typeof customElements !== "undefined") register();
