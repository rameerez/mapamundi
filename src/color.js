// One color utility: the auto hover shade. When dot-hover-color isn't set,
// hovers derive from dot-color itself — darker for light dots, lighter for
// dark dots — so a custom-colored map never falls back to somebody else's
// gray. Hex in, hex out; non-hex inputs (named colors, rgb()) fall back to
// a CSS color-mix() string, which every browser that runs this component
// already supports.

export function hoverShade(color) {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color?.trim?.() ?? "");
  if (!m) return `color-mix(in srgb, ${color} 65%, black)`;
  let hex = m[1];
  if (hex.length === 3) hex = hex.replace(/./g, (ch) => ch + ch);
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16));
  const luminance = 0.299 * r + 0.587 * g + 0.114 * b;
  const shade = luminance > 140
    ? (v) => Math.round(v * 0.62)                    // light dot → darker shade
    : (v) => Math.round(v + (255 - v) * 0.45);       // dark dot → lighter tint
  return `#${[r, g, b].map((v) => shade(v).toString(16).padStart(2, "0")).join("")}`;
}
