# dotted-world

**A dotted world map as a zero-dependency web component.** Land dots derived
from a packed bitmask at any resolution, a built-in city registry (just type
`"London"`), shapes, tilt, pulse markers, hover/click events. One ESM file,
no build step, no dependencies.

```html
<script type="module" src="https://unpkg.com/dotted-world"></script>

<dotted-world cities="London, Lagos, Singapore" tilt="40"></dotted-world>
```

That's the whole integration.

## Why this exists

Every SaaS hero section eventually wants the dotted world with glowing city
markers. The usual path is a designer's frozen SVG: thousands of hardcoded
rectangles, cities placed by eye, one resolution forever. `dotted-world`
derives the dots from a ~22 KB packed land bitmask instead — so resolution,
dot shape, projection framing, and city markers are all runtime parameters,
and "add Nairobi" is typing `Nairobi`.

## Install

```bash
npm install dotted-world
```

Or skip npm entirely — it's one file:

```html
<script type="module" src="https://unpkg.com/dotted-world"></script>
```

Rails with importmaps:

```ruby
# config/importmap.rb
pin "dotted-world", to: "dotted-world.js" # vendor dist/dotted-world.js
```

## The element

```html
<dotted-world
  cities="London, Lagos, Singapore, New York"
  cols="140"
  dot-shape="circle"
  dot-color="#d3dce6"
  marker-color="#2262fe"
  marker-pulse="true"
  tilt="40"
  ambient="wave"
></dotted-world>
```

Attributes are live — change one, the map re-renders. Interaction bubbles as
DOM events:

```js
map.addEventListener("dotted-world:cityclick", (e) => {
  console.log(e.detail.name, e.detail.lat, e.detail.lon);
});
// also: dotted-world:cityenter, :dotclick, :dotenter
```

## The JS API

```js
import { DottedWorld } from "dotted-world";

const map = new DottedWorld(document.querySelector("#hero-map"), {
  cols: 140,                       // dots across the world — the resolution
  latRange: [-58, 84],             // default framing cuts Antarctica
  dotShape: "circle",              // "circle" | "square" | "triangle" | SVG path (24×24)
  dotSize: 0.55,                   // fraction of a grid cell
  dotColor: "#d3dce6",
  dotHoverColor: "#94a8bd",
  dotHoverScale: 2.2,
  cities: [
    "Tokyo", "Berlin",             // the built-in registry (~160 cities)
    { name: "HQ", lat: 41.4, lon: 2.2, color: "#ff9900" } // or your own coords
  ],
  markerShape: "circle",
  markerColor: "#2262fe",
  markerPulse: true,
  tilt: 40,                        // the lying-down hero look (rotateX, deg)
  perspective: 1000,
  ambient: "none",                 // "wave" animates the whole matrix
  cursor: "default",
  markerCursor: "pointer",
  onCityClick: ({ name }) => console.log(name)
});

map.update({ markerColor: "#ff3b30" }); // re-render with new options
map.destroy();
```

Lower-level pieces are exported too — `isLand(lat, lon)`, `project`,
`cellCenter`, `snapToLand`, and the `CITIES` registry — if you want to build
your own renderer on the same data.

## Styling

The component renders into light DOM with plain classes (`.dw-dot`,
`.dw-marker`, `.dw-svg`, `.dw-tilt`) — your stylesheet wins. The built-in
styles are defaults, not law. `prefers-reduced-motion` disables all
animation automatically.

## Design notes

- **SVG, not canvas**: dots are real elements — CSS hover, focusable
  markers, restylable from outside. Sensible up to ~250 cols; a canvas
  renderer for extreme grids is on the roadmap behind the same options.
- **Equirectangular on purpose**: this is a *symbolic* map. Linear lat/lon
  matches both the packed mask and everyone's mental world map.
- **Coastal snapping**: city coordinates snap to the nearest land dot
  (harbors sit in sea cells at coarse resolutions; a marker floating off
  the coast looks broken).
- **Globe mode** (`projection: "globe"`, rotating) is designed into the API
  as a renderer swap — coordinates are lat/lon everywhere — and planned.

## Data

Land shapes derived from [Natural Earth](https://www.naturalearthdata.com)
(110m land polygons, public domain), rasterized into a 512×256 bitmask at
build time by `scripts/generate-mask.js`. Regenerate any time; consumers
never run it.

## Development

```bash
node scripts/generate-mask.js   # refresh src/mask.js from Natural Earth
node scripts/build.js           # bundle src/ → dist/dotted-world.js
node --test test/               # the suite runs against dist/
```

## License

MIT © Javi R. Land data: Natural Earth (public domain).
