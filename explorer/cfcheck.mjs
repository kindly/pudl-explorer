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
console.log(bad ? `\n${bad} mismatches` : "\nthe cf measure agrees with the direct calculation");
process.exit(bad ? 1 : 0);
