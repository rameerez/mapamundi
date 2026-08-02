#!/usr/bin/env node
// Builds dist/mappo.js — ONE self-contained ESM file, because the
// whole point is zero-friction consumption: a single <script type="module">,
// one importmap pin, one CDN URL. No bundler dependency: the module graph is
// a hand-ordered list and imports are internal-only, so "bundling" is
// stripping import lines and concatenating. If the graph ever gets real
// complexity, switch to esbuild — not before.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const src = (f) => readFileSync(join(here, "..", "src", f), "utf8");

// Dependency order, leaves first. index.js is not concatenated — its only
// job (re-exports + auto-register) is reproduced in the footer.
const MODULES = ["mask.js", "projection.js", "noise.js", "cities.js", "globe.js", "renderer.js", "element.js"];

const body = MODULES.map((file) => {
  const code = src(file)
    .replace(/^import\s[^;]+;\n/gm, "")       // internal imports: now same scope
    .trimEnd();
  return `// ══════════ src/${file} ══════════\n${code}`;
}).join("\n\n");

const banner = `// mappo v${JSON.parse(readFileSync(join(here, "..", "package.json"))).version}
// A dotted world map as a zero-dependency web component. MIT license.
// https://github.com/rameerez/mappo
// Land data: Natural Earth (public domain, naturalearthdata.com).
// GENERATED from src/ by scripts/build.js — edit src/, not this file.
`;

const footer = `
// ══════════ auto-register ══════════
if (typeof customElements !== "undefined") register();
`;

mkdirSync(join(here, "..", "dist"), { recursive: true });
writeFileSync(join(here, "..", "dist", "mappo.js"), banner + "\n" + body + footer);
console.log("wrote dist/mappo.js");
