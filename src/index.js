// dotted-world — a dotted world map as a zero-dependency web component.
//
//   import "worldmap";            // side effect: registers <world-map>
//   <world-map cities="London, Lagos"></world-map>
//
//   // or the programmatic API:
//   import { WorldMap } from "worldmap";
//   new WorldMap(el, { cities: ["Tokyo"], tilt: 40, ambient: "wave" });

export { WorldMap, DEFAULTS, snapToLand } from "./renderer.js";
export { WorldMapElement, register } from "./element.js";
export { CITIES, resolveCity } from "./cities.js";
export { isLand, MASK_W, MASK_H } from "./mask.js";
export { project, cellCenter } from "./projection.js";

import { register } from "./element.js";
// Auto-register when a DOM exists (browser); harmless no-op under Node.
if (typeof customElements !== "undefined") register();
