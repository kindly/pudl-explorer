// Run ad-hoc SQL against the prebuilt image: node query-test.mjs [sqlfile]
import { readFileSync } from "node:fs";
import { coreUrl, wasmUrl } from "./engine.js";
const { instantiate } = await import(coreUrl.href);
const engine = await instantiate(readFileSync(wasmUrl));
const { handle, rows } = engine.openTable(readFileSync("../data/eia_generator_month_2010plus.facetful"));
console.log("rows", rows);
const dec = new TextDecoder();
const cell = (c, i) => c.kind === "text" ? dec.decode(c.bytes.subarray(c.offsets[i], c.offsets[i + 1])) : c.values[i];
const Q = readFileSync(process.argv[2] ?? "queries.sql", "utf8").split(/;\s*\n/).map(s => s.trim()).filter(Boolean);
for (const sql of Q) {
  try {
    // warm + 3 runs, report min
    let best = 1e9, r;
    for (let k = 0; k < 3; k++) { const t = performance.now(); r = engine.query(handle, sql); best = Math.min(best, performance.now() - t); }
    console.log(`\n[${best.toFixed(1)} ms] ${r.rowCount} rows  ${sql.replace(/\s+/g,' ').slice(0, 120)}`);
    console.log("   " + r.columns.map(c => `${c.name}:${c.kind}`).join("  "));
    for (let i = 0; i < Math.min(+process.env.SHOW || 4, r.rowCount); i++) console.log("   " + r.columns.map(c => cell(c, i)).join(" | "));
  } catch (e) { console.log(`\nERROR ${sql.slice(0, 120)}\n${e.message}`); }
}
