// Compact 2D value noise — smooth, deterministic, zero-dependency. Used to
// shape animation DELAY fields (animation: "noise"): neighboring dots
// get neighboring phases, so the matrix shimmers in organic patches instead
// of mechanical sweeps. Not full simplex noise — for picking per-dot delays
// once at render time, smooth value noise is indistinguishable and a third
// of the code. If a future time-evolving mode needs higher-quality gradients,
// swap the internals; the noise2(x, y) → [-1, 1] contract holds.

// Deterministic integer hash → [0, 1). Same input, same output, every load —
// re-renders must not reshuffle the field.
function hash(ix, iy) {
  let h = (ix * 374761393 + iy * 668265263) | 0; // large primes
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

// Quintic smoothstep — C2-continuous interpolation, no grid-line artifacts.
function fade(t) {
  return t * t * t * (t * (t * 6 - 15) + 10);
}

// @return [Number] smooth noise in [-1, 1]
export function noise2(x, y) {
  const ix = Math.floor(x), iy = Math.floor(y);
  const fx = x - ix, fy = y - iy;

  const a = hash(ix, iy);
  const b = hash(ix + 1, iy);
  const c = hash(ix, iy + 1);
  const d = hash(ix + 1, iy + 1);

  const ux = fade(fx), uy = fade(fy);
  const value = a + (b - a) * ux + (c - a) * uy + (a - b - c + d) * ux * uy;
  return value * 2 - 1;
}
