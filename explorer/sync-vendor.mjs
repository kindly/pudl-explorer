#!/usr/bin/env node
// Copy the published facetful package into explorer/vendor/facetful.
//
// The app has no build step and no bundler: the browser fetches index.js, worker.js and the wasm by
// URL, so they have to sit in the served tree and be committed for GitHub Pages. What used to be a
// hand-maintained copy (with a local patch on top) is now just the npm package, checked out here.
// The version lives in package.json; nothing in vendor/ is ever edited by hand.
//
//   node sync-vendor.mjs            copy node_modules/facetful -> vendor/facetful
//   node sync-vendor.mjs --check    fail if they differ (a forgotten sync, or a hand edit)
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";

const SRC = new URL("./node_modules/facetful/", import.meta.url);
const VENDOR = new URL("./vendor/", import.meta.url);
const check = process.argv.includes("--check");

if (!existsSync(SRC)) {
  console.error("node_modules/facetful is missing — run `npm install` in explorer/ first.");
  process.exit(check ? 0 : 1);        // --check stays quiet where the package is not installed
}
const pkg = JSON.parse(readFileSync(new URL("package.json", SRC), "utf8"));
const files = [...pkg.files, "package.json"];
const sum = (b) => createHash("sha256").update(b).digest("hex").slice(0, 12);

// The version is in the directory name so an upgrade cannot be served from cache. engine.js is the
// only file that names it.
const dirName = `facetful-${pkg.version}`;
const DST = new URL(`${dirName}/`, VENDOR);
mkdirSync(DST, { recursive: true });
const diff = [];
for (const f of files) {
  const src = readFileSync(new URL(f, SRC));
  const dst = existsSync(new URL(f, DST)) ? readFileSync(new URL(f, DST)) : null;
  if (dst && dst.equals(src)) continue;
  diff.push(`${f} ${dst ? sum(dst) : "(absent)"} -> ${sum(src)}`);
  if (!check) writeFileSync(new URL(f, DST), src);
}
// engine.js points at the versioned directory; everything else imports engine.js
const eng = new URL("./engine.js", import.meta.url);
const before = readFileSync(eng, "utf8");
const after = before.replace(/const DIR = "\.\/vendor\/facetful-[^"]*\/";/, `const DIR = "./vendor/${dirName}/";`);
if (after !== before) { diff.push(`engine.js -> ./vendor/${dirName}/`); if (!check) writeFileSync(eng, after); }

if (check) {
  if (!diff.length) { console.log(`vendor/${dirName} matches facetful ${pkg.version}`); process.exit(0); }
  console.error(`the vendored engine is out of step with facetful ${pkg.version}:`);
  diff.forEach((d) => console.error("  " + d));
  console.error("run: npm run sync-vendor");
  process.exit(1);
}
// retire directories for versions we no longer use
for (const old of readdirSync(VENDOR)) {
  if (/^facetful(-|$)/.test(old) && old !== dirName) { rmSync(new URL(`${old}/`, VENDOR), { recursive: true, force: true }); diff.push(`removed vendor/${old}`); }
}
console.log(diff.length ? `facetful ${pkg.version}: ${diff.length} change(s)\n  ${diff.join("\n  ")}`
                        : `facetful ${pkg.version}: already in sync`);
