// Capacity factor as a measure must match the capacity factor the totals bar already computes.
import { readFileSync } from "node:fs";
import { coreUrl, wasmUrl } from "./engine.js";
import { MEASURES, YEARS, measureExpr } from "./sql.js";
const { instantiate } = await import(coreUrl.href);
const eng = await instantiate(readFileSync(wasmUrl));
const h = eng.openTable(readFileSync("../data/generator_tech_wide.facetful")).handle;
const dec = new TextDecoder();
const q = (sql) => { const r = eng.query(h, sql);
  return Array.from({ length: r.rowCount }, (_, i) => Object.fromEntries(r.columns.map((c) =>
    [c.name, c.kind === "text" ? dec.decode(c.bytes.subarray(c.offsets[i], c.offsets[i + 1])) : c.values[i]]))); };
const y = YEARS;
const span = (p) => y.map((k) => `${p}_${k}`).join(" + ");
const rows = q(`select fuel_type_code_pudl as f, ${measureExpr(MEASURES.cf, y)} as measure_cf, ` +
  `round(sum(${span("gen")}) / nullif(sum(${span("cap")}) * 730.5, 0) * 100, 2) as direct_cf, ` +
  `count(*) as n from t group by fuel_type_code_pudl order by measure_cf desc limit 9`);
console.log("fuel       measure  direct   rows   (both are % capacity factor)");
let bad = 0;
for (const r of rows) {
  const off = Math.abs((r.measure_cf ?? 0) - (r.direct_cf ?? 0));
  if (off > 0.02) bad++;
  console.log(`${String(r.f).padEnd(10)} ${String(r.measure_cf).padStart(7)} ${String(r.direct_cf).padStart(7)} ${String(r.n).padStart(6)}${off > 0.02 ? "   MISMATCH" : ""}`);
}

// The year chart has its own per-year expression; it once hardcoded the CEMS gate, which divided all
// generation by monitored capacity only. Every yearly capacity factor must be a real percentage.
const { yearSql, MEASURES: M2 } = await import("./sql.js");
const yr = q(yearSql(new Map(), M2.cf).replace(/^select/, "select"));
const bads = [];
for (const row of yr) for (const [k, v] of Object.entries(row)) {
  if (!/^y\d{4}$/.test(k) || v == null) continue;
  if (v < 0 || v > 100) bads.push(`${row.f} ${k.slice(1)} = ${v}`);
}
const fuels = new Set(yr.filter((r) => YEARS.some((y) => (r[`y${y}`] ?? 0) > 0)).map((r) => r.f));
for (const need of ["nuclear", "hydro", "wind", "solar", "coal", "gas"]) {
  if (!fuels.has(need)) { bads.push(`${need} has no yearly capacity factor at all`); }
}
console.log(bads.length ? `\nyearly capacity factor out of range:\n  ${bads.slice(0, 8).join("\n  ")}`
  : `\nevery yearly capacity factor is within 0-100% across ${fuels.size} fuels`);
bad += bads.length;

console.log(bad ? `\n${bad} problems` : "\nthe cf measure agrees with the direct calculation");
process.exit(bad ? 1 : 0);
