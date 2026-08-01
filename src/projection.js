// Equirectangular projection — the deliberate choice for a SYMBOLIC map:
// linear lat/lon ↔ x/y, matching both the packed land mask and everyone's
// mental image of "the world map". Not area-accurate (Mercator-style debates
// don't apply — nothing here encodes quantity by area).
//
// All renderer geometry flows through these two functions, which is what
// makes the future globe mode a renderer swap instead of an API change:
// callers speak lat/lon, only the projection changes.

// Map a lat/lon to fractional grid coordinates in a cols×rows grid covering
// latRange (north→south) across the full −180…180 longitude span.
export function project(lat, lon, { cols, rows, latRange }) {
  const [latMin, latMax] = latRange;
  return {
    x: ((lon + 180) / 360) * cols,
    y: ((latMax - lat) / (latMax - latMin)) * rows
  };
}

// The center lat/lon of a grid cell — where the mask is sampled and where a
// dot is drawn.
export function cellCenter(col, row, { cols, rows, latRange }) {
  const [latMin, latMax] = latRange;
  return {
    lat: latMax - ((row + 0.5) / rows) * (latMax - latMin),
    lon: -180 + ((col + 0.5) / cols) * 360
  };
}
