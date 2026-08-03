// Region highlight: a polygon (rings of [lat, lon] pairs) tested per dot
// at geometry-build time. The consumer supplies the shape — mappo stays
// dependency-free (no bundled boundary dataset); VehiclesDB feeds it
// Natural Earth rings per jurisdiction.
//
// Ray-cast in lon/lat space. Rings that cross the antimeridian should be
// pre-normalized by the caller (shift western lons +360); normalizeRings
// below does it for rings whose lon span exceeds 180°.

export function normalizeRings(rings) {
  return rings.map((ring) => {
    let min = Infinity, max = -Infinity;
    for (const [, lon] of ring) { if (lon < min) min = lon; if (lon > max) max = lon; }
    if (max - min <= 180) return { ring, shifted: false };
    return { ring: ring.map(([la, lo]) => [la, lo < 0 ? lo + 360 : lo]), shifted: true };
  });
}

export function pointInRings(lat, lon, normalized) {
  for (const { ring, shifted } of normalized) {
    const x = shifted && lon < 0 ? lon + 360 : lon;
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [yi, xi] = ring[i];
      const [yj, xj] = ring[j];
      if ((yi > lat) !== (yj > lat) && x < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) {
        inside = !inside;
      }
    }
    if (inside) return true;
  }
  return false;
}
