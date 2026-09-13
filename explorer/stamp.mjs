#!/usr/bin/env node
// Stamp the asset URLs with a hash of their own contents.
//
// There is no build step here, and the static host sends no Cache-Control, so a browser is free to
// keep app.js and theme.css for as long as it likes. A hand-written `?v=` made that worse rather
// than better: the query pinned the cached copy and I changed the files three times without
// touching it. A content hash cannot drift, because editing a file changes the URL that loads it.
//
// Run after editing any of HASHED, or just run it before serving; it is idempotent.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

const HASHED = ["app.js", "sql.js", "map.js", "theme.css"];
const here = (f) => new URL(f, import.meta.url);
const read = (f) => readFileSync(here(f), "utf8");

// Normalise the stamps themselves out before hashing, or writing the stamp would change the hash
// that produced it.
const norm = (s) => s.replace(/\?v=[0-9a-z]+/g, "?v=").replace(/const BUILD = "[^"]*"/, 'const BUILD = ""');
const stamp = createHash("sha256").update(HASHED.map((f) => norm(read(f))).join("\0")).digest("hex").slice(0, 8);

let changed = [];
for (const f of ["index.html", "app.js"]) {
  const before = read(f);
  let after = before.replace(/\?v=[0-9a-z]+/g, `?v=${stamp}`);
  if (f === "app.js") after = after.replace(/const BUILD = "[^"]*"/, `const BUILD = "${stamp}"`);
  if (after !== before) { writeFileSync(here(f), after); changed.push(f); }
}
// fetched with cache: "no-store" at boot, so a stale index.html can announce itself
const vj = JSON.stringify({ build: stamp }) + "\n";
if (read("version.json").trim() !== vj.trim()) { writeFileSync(here("version.json"), vj); changed.push("version.json"); }

console.log(`stamp ${stamp}${changed.length ? " -> " + changed.join(", ") : " (already current)"}`);
